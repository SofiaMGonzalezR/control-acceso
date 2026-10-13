(function () {
  "use strict";

  var API_URL = window.location.origin + "/api";
  var TOKEN_KEY = "control-accesos:token";
  var ROL_KEY = "control-accesos:rol";
  var CACHE_KEY = "control-accesos:cache"; // último estado conocido (empleados, movimientos, turnos)
  var COLA_KEY = "control-accesos:cola-offline"; // marcas hechas sin conexión, pendientes de sincronizar

  var empleados = [];
  var movimientos = [];
  var turnos = []; // [{empleadoId, horaEntrada, toleranciaMinutos}]
  var enLinea = true;
  var sincronizando = false;

  // Estado del modal de captura (foto + ubicación) al marcar un movimiento
  var capturaEmpleadoId = null;
  var capturaStream = null;
  var capturaFotoDataUrl = null;
  var capturaLat = null;
  var capturaLng = null;

  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }

  function setToken(token) {
    localStorage.setItem(TOKEN_KEY, token);
  }

  function getRol() {
    return localStorage.getItem(ROL_KEY);
  }

  function setRol(rol) {
    localStorage.setItem(ROL_KEY, rol);
  }

  function esAdmin() {
    return getRol() === "admin";
  }

  function limpiarToken() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(ROL_KEY);
  }

  // --- Caché local (para poder mostrar datos aunque no haya conexión) ---

  function guardarCache() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ empleados: empleados, movimientos: movimientos, turnos: turnos }));
    } catch (e) {
      console.error("No se pudo guardar la caché local", e);
    }
  }

  function cargarCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return false;
      var datos = JSON.parse(raw);
      empleados = datos.empleados || [];
      movimientos = datos.movimientos || [];
      turnos = datos.turnos || [];
      return true;
    } catch (e) {
      return false;
    }
  }

  // --- Cola de marcas hechas sin conexión ---

  function obtenerCola() {
    try {
      return JSON.parse(localStorage.getItem(COLA_KEY) || "[]");
    } catch (e) {
      return [];
    }
  }

  function guardarCola(cola) {
    localStorage.setItem(COLA_KEY, JSON.stringify(cola));
  }

  function agregarACola(item) {
    var cola = obtenerCola();
    cola.push(item);
    guardarCola(cola);
    actualizarBadgeConexion();
  }

  // --- Detección de conexión real con el backend ---

  async function probarConexion() {
    try {
      var controller = new AbortController();
      var timeoutId = setTimeout(function () { controller.abort(); }, 3000);
      var res = await fetch(API_URL + "/salud", { signal: controller.signal });
      clearTimeout(timeoutId);
      return res.ok;
    } catch (e) {
      return false;
    }
  }

  function actualizarBadgeConexion() {
    var badge = document.getElementById("badge-conexion");
    if (!badge) return;
    var pendientes = obtenerCola().length;

    if (enLinea) {
      if (pendientes > 0) {
        badge.textContent = sincronizando
          ? "Sincronizando " + pendientes + " fichaje(s)…"
          : "Conectado · " + pendientes + " fichaje(s) por sincronizar";
        badge.className = "badge-conexion syncing";
      } else {
        badge.textContent = "Conectado";
        badge.className = "badge-conexion online";
      }
    } else {
      badge.textContent = pendientes > 0
        ? "Sin conexión · " + pendientes + " fichaje(s) guardados localmente"
        : "Sin conexión";
      badge.className = "badge-conexion offline";
    }
  }

  async function sincronizarCola() {
    if (sincronizando) return;
    var cola = obtenerCola();
    if (cola.length === 0) return;

    sincronizando = true;
    actualizarBadgeConexion();

    while (cola.length > 0) {
      var item = cola[0];
      try {
        var res = await fetch(API_URL + "/empleados/" + item.empleadoId + "/marcar", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + getToken(),
          },
          body: JSON.stringify({ timestampCliente: item.timestamp, foto: item.foto || null, latitud: item.latitud, longitud: item.longitud }),
        });

        if (!res.ok) {
          // El servidor respondió pero rechazó la marca (por ejemplo, sesión vencida):
          // la sacamos de la cola para no reintentar algo que nunca va a funcionar.
          cola.shift();
          guardarCola(cola);
          continue;
        }

        var data = await res.json();

        // Reemplazamos el movimiento "pendiente" que se mostraba localmente por el real del servidor.
        movimientos = movimientos.map(function (m) {
          return m.clientId === item.clientId ? data.movimiento : m;
        });
        empleados = empleados.map(function (e) {
          return e.id === data.empleado.id ? data.empleado : e;
        });

        cola.shift();
        guardarCola(cola);
        guardarCache();
        renderTodo();
      } catch (e) {
        // Sigue sin haber conexión real: dejamos el resto de la cola para más adelante.
        break;
      }
    }

    sincronizando = false;
    actualizarBadgeConexion();
  }

  async function chequearConexionYSincronizar() {
    var estabaOffline = !enLinea;
    enLinea = await probarConexion();
    actualizarBadgeConexion();
    if (enLinea && (estabaOffline || obtenerCola().length > 0)) {
      await sincronizarCola();
    }
  }

  async function apiGet(path) {
    var res = await fetch(API_URL + path, {
      headers: { Authorization: "Bearer " + getToken() },
    });
    if (res.status === 401) { manejarSesionVencida(); throw new Error("Sesión vencida"); }
    if (!res.ok) throw new Error("Error en " + path);
    return res.json();
  }

  async function apiPost(path, body) {
    var res = await fetch(API_URL + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + getToken(),
      },
      body: JSON.stringify(body || {}),
    });
    if (res.status === 401) { manejarSesionVencida(); throw new Error("Sesión vencida"); }
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || "Error en " + path);
    return data;
  }

  async function apiPut(path, body) {
    var res = await fetch(API_URL + path, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + getToken(),
      },
      body: JSON.stringify(body || {}),
    });
    if (res.status === 401) { manejarSesionVencida(); throw new Error("Sesión vencida"); }
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || "Error en " + path);
    return data;
  }

  async function apiDelete(path) {
    var res = await fetch(API_URL + path, {
      method: "DELETE",
      headers: { Authorization: "Bearer " + getToken() },
    });
    if (res.status === 401) { manejarSesionVencida(); throw new Error("Sesión vencida"); }
    if (!res.ok) throw new Error("Error en " + path);
  }

  function manejarSesionVencida() {
    limpiarToken();
    mostrarLogin("Tu sesión venció. Iniciá sesión de nuevo.");
  }

  function mostrarLogin(mensajeError) {
    document.getElementById("app-wrap").style.display = "none";
    document.getElementById("login-overlay").style.display = "flex";
    mostrarTabLogin();
    var err = document.getElementById("login-error");
    if (mensajeError) {
      err.textContent = mensajeError;
      err.style.display = "block";
    } else {
      err.style.display = "none";
    }
    document.getElementById("login-usuario").focus();
  }

  function mostrarApp() {
    document.getElementById("login-overlay").style.display = "none";
    document.getElementById("app-wrap").style.display = "block";
    document.getElementById("btn-abrir-modal").style.display = esAdmin() ? "flex" : "none";
    document.getElementById("btn-abrir-usuarios").style.display = esAdmin() ? "flex" : "none";
  }

  async function manejarLogin(e) {
    e.preventDefault();
    var usuario = document.getElementById("login-usuario").value.trim();
    var password = document.getElementById("login-password").value;
    var err = document.getElementById("login-error");

    if (!usuario || !password) {
      err.textContent = "Ingresá usuario y contraseña.";
      err.style.display = "block";
      return;
    }

    try {
      var res = await fetch(API_URL + "/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usuario: usuario, password: password }),
      });
      var data = await res.json();
      if (!res.ok) {
        err.textContent = data.error || "No se pudo iniciar sesión.";
        err.style.display = "block";
        return;
      }
      setToken(data.token);
      setRol(data.rol);
      err.style.display = "none";
      document.getElementById("form-login").reset();
      await iniciarApp();
    } catch (e2) {
      err.textContent = "No se pudo conectar con el servidor (¿está corriendo el backend?).";
      err.style.display = "block";
    }
  }

  function mostrarTabLogin() {
    document.getElementById("tab-login").classList.add("active");
    document.getElementById("tab-registro").classList.remove("active");
    document.getElementById("form-login").style.display = "block";
    document.getElementById("form-registro").style.display = "none";
  }

  function mostrarTabRegistro() {
    document.getElementById("tab-registro").classList.add("active");
    document.getElementById("tab-login").classList.remove("active");
    document.getElementById("form-registro").style.display = "block";
    document.getElementById("form-login").style.display = "none";
  }

  async function manejarRegistro(e) {
    e.preventDefault();
    var usuario = document.getElementById("registro-usuario").value.trim();
    var email = document.getElementById("registro-email").value.trim();
    var documento = document.getElementById("registro-documento").value.trim();
    var password = document.getElementById("registro-password").value;
    var err = document.getElementById("registro-error");
    var exito = document.getElementById("registro-exito");

    err.style.display = "none";
    exito.style.display = "none";

    if (!usuario || !email || !documento || !password) {
      err.textContent = "Completá todos los campos.";
      err.style.display = "block";
      return;
    }

    try {
      var res = await fetch(API_URL + "/registro", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usuario: usuario, email: email, documento: documento, password: password }),
      });
      var data = await res.json();
      if (!res.ok) {
        err.textContent = data.error || "No se pudo crear la cuenta.";
        err.style.display = "block";
        return;
      }
      exito.textContent = data.mensaje || "Cuenta creada. Ya podés iniciar sesión.";
      exito.style.display = "block";
      document.getElementById("form-registro").reset();
      setTimeout(function () {
        mostrarTabLogin();
        document.getElementById("login-usuario").value = usuario;
        document.getElementById("login-password").focus();
      }, 1500);
    } catch (e2) {
      err.textContent = "No se pudo conectar con el servidor (¿está corriendo el backend?).";
      err.style.display = "block";
    }
  }

  // --- Recuperar usuario / contraseña ---

  function abrirModalRecuperar() {
    document.getElementById("modal-recuperar-overlay").classList.add("open");
    mostrarTabRecuperarUsuario();
  }

  function cerrarModalRecuperar() {
    document.getElementById("modal-recuperar-overlay").classList.remove("open");
    document.getElementById("form-recuperar-usuario").reset();
    document.getElementById("form-recuperar-password").reset();
    document.getElementById("bloque-codigo").style.display = "none";
    document.getElementById("btn-confirmar-codigo").style.display = "none";
    ["recuperar-usuario-error", "recuperar-usuario-exito", "recuperar-password-error", "recuperar-password-exito"].forEach(function (id) {
      document.getElementById(id).style.display = "none";
    });
  }

  function mostrarTabRecuperarUsuario() {
    document.getElementById("tab-recuperar-usuario").classList.add("active");
    document.getElementById("tab-recuperar-password").classList.remove("active");
    document.getElementById("form-recuperar-usuario").style.display = "block";
    document.getElementById("form-recuperar-password").style.display = "none";
  }

  function mostrarTabRecuperarPassword() {
    document.getElementById("tab-recuperar-password").classList.add("active");
    document.getElementById("tab-recuperar-usuario").classList.remove("active");
    document.getElementById("form-recuperar-password").style.display = "block";
    document.getElementById("form-recuperar-usuario").style.display = "none";
  }

  async function manejarRecuperarUsuario(e) {
    e.preventDefault();
    var email = document.getElementById("recuperar-usuario-email").value.trim();
    var err = document.getElementById("recuperar-usuario-error");
    var exito = document.getElementById("recuperar-usuario-exito");
    err.style.display = "none";
    exito.style.display = "none";

    if (!email) {
      err.textContent = "Ingresá tu email.";
      err.style.display = "block";
      return;
    }

    try {
      var res = await fetch(API_URL + "/recuperar/usuario", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email }),
      });
      var data = await res.json();
      if (!res.ok) {
        err.textContent = data.error || "No se pudo procesar la solicitud.";
        err.style.display = "block";
        return;
      }
      exito.textContent = data.mensaje;
      exito.style.display = "block";
    } catch (e2) {
      err.textContent = "No se pudo conectar con el servidor.";
      err.style.display = "block";
    }
  }

  async function manejarEnviarCodigo() {
    var email = document.getElementById("recuperar-password-email").value.trim();
    var err = document.getElementById("recuperar-password-error");
    var exito = document.getElementById("recuperar-password-exito");
    err.style.display = "none";
    exito.style.display = "none";

    if (!email) {
      err.textContent = "Ingresá tu email.";
      err.style.display = "block";
      return;
    }

    try {
      var res = await fetch(API_URL + "/recuperar/solicitar-codigo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email }),
      });
      var data = await res.json();
      if (!res.ok) {
        err.textContent = data.error || "No se pudo procesar la solicitud.";
        err.style.display = "block";
        return;
      }
      exito.textContent = data.mensaje;
      exito.style.display = "block";
      document.getElementById("bloque-codigo").style.display = "block";
      document.getElementById("btn-confirmar-codigo").style.display = "block";
      document.getElementById("recuperar-codigo").focus();
    } catch (e2) {
      err.textContent = "No se pudo conectar con el servidor.";
      err.style.display = "block";
    }
  }

  async function manejarConfirmarCodigo(e) {
    e.preventDefault();
    var email = document.getElementById("recuperar-password-email").value.trim();
    var codigo = document.getElementById("recuperar-codigo").value.trim();
    var nuevaPassword = document.getElementById("recuperar-nueva-password").value;
    var err = document.getElementById("recuperar-password-error");
    var exito = document.getElementById("recuperar-password-exito");
    err.style.display = "none";

    if (!codigo || !nuevaPassword) {
      err.textContent = "Completá el código y la nueva contraseña.";
      err.style.display = "block";
      return;
    }

    try {
      var res = await fetch(API_URL + "/recuperar/confirmar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email, codigo: codigo, nuevaPassword: nuevaPassword }),
      });
      var data = await res.json();
      if (!res.ok) {
        err.textContent = data.error || "No se pudo cambiar la contraseña.";
        err.style.display = "block";
        return;
      }
      exito.textContent = data.mensaje;
      exito.style.display = "block";
      setTimeout(function () {
        cerrarModalRecuperar();
        document.getElementById("login-usuario").focus();
      }, 1500);
    } catch (e2) {
      err.textContent = "No se pudo conectar con el servidor.";
      err.style.display = "block";
    }
  }

  function manejarLogout() {
    limpiarToken();
    mostrarLogin();
  }

  function formatHora(iso) {
    var d = new Date(iso);
    return d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
  }

  function formatFecha(iso) {
    var d = new Date(iso);
    return d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
  }

  function formatDuracion(ms) {
    var totalMin = Math.floor(ms / 60000);
    var h = Math.floor(totalMin / 60);
    var m = totalMin % 60;
    if (h === 0) return m + "m";
    return h + "h " + m + "m";
  }

  function hoyISO() {
    return new Date().toISOString().slice(0, 10);
  }

  function tiempoDentro(empleado) {
    for (var i = 0; i < movimientos.length; i++) {
      var mov = movimientos[i];
      if (mov.empleadoId === empleado.id && mov.tipo === "ingreso") {
        return formatDuracion(new Date() - new Date(mov.timestamp));
      }
    }
    return null;
  }

  function turnoDe(empleadoId) {
    return turnos.find(function (t) { return t.empleadoId === empleadoId; }) || null;
  }

  function formatHoraCorta(horaEntrada) {
    // horaEntrada viene como "08:00:00" desde MySQL
    return String(horaEntrada).slice(0, 5);
  }

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function actualizarReloj() {
    var now = new Date();
    var texto = now.toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long" }) +
      " · " + now.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
    document.getElementById("fecha-hora").textContent = texto;
  }

  function renderMetricas() {
    document.getElementById("m-total").textContent = empleados.length;
    var dentro = empleados.filter(function (e) { return e.dentro; }).length;
    document.getElementById("m-dentro").textContent = dentro;
    var hoy = hoyISO();
    var movHoy = movimientos.filter(function (m) { return m.timestamp.slice(0, 10) === hoy; }).length;
    document.getElementById("m-hoy").textContent = movHoy;
    var tardeHoy = movimientos.filter(function (m) {
      return m.timestamp.slice(0, 10) === hoy && m.tipo === "ingreso" && m.llegoTarde;
    }).length;
    document.getElementById("m-tarde").textContent = tardeHoy;
  }

  function renderLista() {
    var query = document.getElementById("buscar").value.trim().toLowerCase();
    var filtrados = empleados.filter(function (emp) {
      if (!query) return true;
      return emp.nombre.toLowerCase().indexOf(query) !== -1 ||
        emp.legajo.toLowerCase().indexOf(query) !== -1 ||
        emp.area.toLowerCase().indexOf(query) !== -1;
    });

    var ul = document.getElementById("lista-empleados");
    ul.innerHTML = "";

    if (filtrados.length === 0) {
      var msg = empleados.length === 0
        ? "Todavía no agregaste personal. Usá \"Agregar persona\" para empezar."
        : "No encontramos a nadie con esa búsqueda.";
      ul.innerHTML = '<li class="empty" style="display:block; width:100%; border:none;">' + msg + "</li>";
      return;
    }

    filtrados.forEach(function (emp) {
      var li = document.createElement("li");
      var tiempo = emp.dentro ? tiempoDentro(emp) : null;
      var turno = turnoDe(emp.id);
      var turnoTexto = turno
        ? ' · Entrada esperada: ' + formatHoraCorta(turno.horaEntrada) + (turno.toleranciaMinutos ? ' (+' + turno.toleranciaMinutos + 'm)' : '')
        : '';
      li.innerHTML =
        '<div class="emp-left">' +
          '<span class="dot ' + (emp.dentro ? "on" : "") + '"></span>' +
          '<div style="min-width:0;">' +
            '<p class="emp-name">' + escapeHtml(emp.nombre) + '</p>' +
            '<p class="emp-sub">Legajo ' + escapeHtml(emp.legajo) + ' · ' + escapeHtml(emp.area) +
              (tiempo ? ' · <span class="time-in">hace ' + tiempo + '</span>' : '') +
              turnoTexto +
            '</p>' +
          '</div>' +
        '</div>' +
        '<div class="emp-actions">' +
          '<button class="btn-mark ' + (emp.dentro ? "out" : "in") + '" data-id="' + emp.id + '">' +
            (emp.dentro ? "Marcar egreso" : "Marcar ingreso") +
          '</button>' +
          (esAdmin() ? '<button class="btn-manual" data-id="' + emp.id + '" aria-label="Cargar fichaje olvidado" title="Cargar fichaje olvidado">&#9998;</button>' : '') +
          (esAdmin() ? '<button class="btn-turno" data-id="' + emp.id + '" aria-label="Asignar horario">&#128337;</button>' : '') +
          (esAdmin() ? '<button class="btn-del" data-id="' + emp.id + '" aria-label="Eliminar">&#128465;</button>' : '') +
        '</div>';
      ul.appendChild(li);
    });

    ul.querySelectorAll(".btn-mark").forEach(function (btn) {
      btn.addEventListener("click", function () {
        abrirModalCaptura(btn.getAttribute("data-id"));
      });
    });
    ul.querySelectorAll(".btn-del").forEach(function (btn) {
      btn.addEventListener("click", function () {
        eliminarEmpleado(btn.getAttribute("data-id"));
      });
    });
    ul.querySelectorAll(".btn-manual").forEach(function (btn) {
      btn.addEventListener("click", function () {
        abrirModalManual(btn.getAttribute("data-id"), null);
      });
    });
    ul.querySelectorAll(".btn-turno").forEach(function (btn) {
      btn.addEventListener("click", function () {
        abrirModalTurno(btn.getAttribute("data-id"));
      });
    });
  }

  function renderHistorial() {
    var cont = document.getElementById("lista-historial");
    cont.innerHTML = "";

    if (movimientos.length === 0) {
      cont.innerHTML = '<div class="empty">Sin movimientos registrados todavía.</div>';
      return;
    }

    movimientos.forEach(function (m) {
      var icono = m.tipo === "ingreso" ? "&#8594;" : "&#8592;";
      var color = m.tipo === "ingreso" ? "color:#059669;" : "color:#94a3b8;";
      var badge = m.llegoTarde
        ? '<span class="badge-tarde">&#9888; Tarde' + (m.minutosTarde ? ' ' + m.minutosTarde + 'm' : '') + '</span>'
        : '';
      var badgePendiente = m.pendienteSync
        ? '<span class="badge-pendiente">&#8635; Sin sincronizar</span>'
        : '';
      var botonFoto = (m.foto || (m.latitud != null && m.longitud != null))
        ? '<button class="btn-foto" data-clientid="' + (m.clientId || m.id) + '" aria-label="Ver verificación">&#128247;</button>'
        : '';
      var botonEditar = (esAdmin() && !m.pendienteSync && m.id)
        ? '<button class="btn-editar-mov" aria-label="Editar horario" title="Editar horario">&#9998;</button>'
        : '';
      var div = document.createElement("div");
      div.className = "hist-item";
      div.innerHTML =
        '<div class="hist-left">' +
          '<span style="' + color + 'flex-shrink:0;">' + icono + '</span>' +
          '<b>' + escapeHtml(m.nombre) + '</b>' +
          '<span class="area">· ' + escapeHtml(m.area) + '</span>' +
          badge +
          badgePendiente +
        '</div>' +
        '<div class="hist-time">' + formatFecha(m.timestamp) + ' · ' + formatHora(m.timestamp) + botonFoto + botonEditar + '</div>';
      cont.appendChild(div);

      var btnEditar = div.querySelector(".btn-editar-mov");
      if (btnEditar) {
        btnEditar.addEventListener("click", function () {
          abrirModalManual(m.empleadoId, m);
        });
      }

      if (m.foto || (m.latitud != null && m.longitud != null)) {
        div.querySelector(".btn-foto").addEventListener("click", function () {
          verFotoMovimiento(m);
        });
      }
    });
  }

  function renderTodo() {
    renderMetricas();
    renderLista();
    renderHistorial();
  }

  function mostrarToast(mensaje, esTarde) {
    var cont = document.getElementById("toast-container");
    var div = document.createElement("div");
    div.className = "toast" + (esTarde ? " tarde" : "");
    div.textContent = mensaje;
    cont.appendChild(div);
    setTimeout(function () {
      div.remove();
    }, 6000);
  }

  // --- Modal de captura: foto + ubicación antes de marcar ---

  function abrirModalCaptura(empleadoId) {
    var emp = empleados.find(function (e) { return e.id === empleadoId; });
    if (!emp) return;

    capturaEmpleadoId = empleadoId;
    capturaFotoDataUrl = null;
    capturaLat = null;
    capturaLng = null;

    document.getElementById("captura-titulo").textContent =
      (emp.dentro ? "Marcar egreso" : "Marcar ingreso") + " — " + emp.nombre;
    document.getElementById("captura-estado-ubicacion").textContent = "Obteniendo ubicación…";
    document.getElementById("captura-error").style.display = "none";
    document.getElementById("captura-preview").style.display = "none";
    document.getElementById("captura-video").style.display = "block";
    document.getElementById("btn-tomar-foto").style.display = "block";
    document.getElementById("captura-acciones-confirmar").classList.remove("mostrar");
    document.getElementById("btn-omitir-captura").style.display = "none";

    document.getElementById("modal-captura-overlay").classList.add("open");

    pedirUbicacion();
    iniciarCamara();
  }

  function pedirUbicacion() {
    if (!navigator.geolocation) {
      document.getElementById("captura-estado-ubicacion").textContent = "Este dispositivo no puede obtener ubicación.";
      return;
    }
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        capturaLat = pos.coords.latitude;
        capturaLng = pos.coords.longitude;
        document.getElementById("captura-estado-ubicacion").textContent = "Ubicación obtenida ✓";
      },
      function () {
        document.getElementById("captura-estado-ubicacion").textContent = "No se pudo obtener la ubicación (¿diste el permiso?). Se va a marcar sin ubicación.";
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  async function iniciarCamara() {
    var video = document.getElementById("captura-video");
    var err = document.getElementById("captura-error");
    try {
      capturaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
      video.srcObject = capturaStream;
      err.style.display = "none";
      document.getElementById("btn-omitir-captura").style.display = "none";
    } catch (e) {
      err.textContent = "No se pudo acceder a la cámara (¿diste el permiso?). Un administrador puede autorizar el fichaje sin foto.";
      err.style.display = "block";
      document.getElementById("btn-tomar-foto").style.display = "none";
      if (esAdmin()) {
        document.getElementById("btn-omitir-captura").style.display = "block";
      }
    }
  }

  function detenerCamara() {
    if (capturaStream) {
      capturaStream.getTracks().forEach(function (t) { t.stop(); });
      capturaStream = null;
    }
  }

  function tomarFoto() {
    var video = document.getElementById("captura-video");
    var canvas = document.getElementById("captura-canvas");
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    var ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    capturaFotoDataUrl = canvas.toDataURL("image/jpeg", 0.7);

    detenerCamara();

    var preview = document.getElementById("captura-preview");
    preview.src = capturaFotoDataUrl;
    preview.style.display = "block";
    video.style.display = "none";
    document.getElementById("btn-tomar-foto").style.display = "none";
    document.getElementById("captura-acciones-confirmar").classList.add("mostrar");
  }

  function repetirFoto() {
    capturaFotoDataUrl = null;
    document.getElementById("captura-preview").style.display = "none";
    document.getElementById("captura-video").style.display = "block";
    document.getElementById("captura-acciones-confirmar").classList.remove("mostrar");
    document.getElementById("btn-tomar-foto").style.display = "block";
    iniciarCamara();
  }

  function cerrarModalCaptura() {
    detenerCamara();
    document.getElementById("modal-captura-overlay").classList.remove("open");
    capturaEmpleadoId = null;
    capturaFotoDataUrl = null;
  }

  function confirmarCaptura() {
    if (!capturaEmpleadoId) return;
    var id = capturaEmpleadoId;
    var foto = capturaFotoDataUrl;
    var lat = capturaLat;
    var lng = capturaLng;
    cerrarModalCaptura();
    marcarMovimiento(id, foto, lat, lng);
  }

  function omitirCaptura() {
    if (!capturaEmpleadoId) return;
    var id = capturaEmpleadoId;
    var lat = capturaLat;
    var lng = capturaLng;
    cerrarModalCaptura();
    marcarMovimiento(id, null, lat, lng);
  }

  // --- Ver foto/ubicación de un movimiento ya registrado ---

  function verFotoMovimiento(movimiento) {
    var img = document.getElementById("ver-foto-img");
    var ubic = document.getElementById("ver-foto-ubicacion");
    var link = document.getElementById("ver-foto-mapa-link");

    img.style.display = movimiento.foto ? "block" : "none";
    img.src = movimiento.foto || "";

    if (movimiento.latitud != null && movimiento.longitud != null) {
      var latNum = Number(movimiento.latitud);
      var lngNum = Number(movimiento.longitud);
      ubic.textContent = "Ubicación: " + latNum.toFixed(5) + ", " + lngNum.toFixed(5);
      link.href = "https://www.google.com/maps?q=" + latNum + "," + lngNum;
      link.style.display = "inline-block";
    } else {
      ubic.textContent = "No se registró ubicación para este fichaje.";
      link.style.display = "none";
    }

    document.getElementById("modal-ver-foto-overlay").classList.add("open");
  }

  function cerrarVerFoto() {
    document.getElementById("modal-ver-foto-overlay").classList.remove("open");
  }

  async function marcarMovimiento(id, foto, lat, lng) {
    var emp = empleados.find(function (e) { return e.id === id; });
    if (!emp) return;

    try {
      var res = await fetch(API_URL + "/empleados/" + id + "/marcar", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + getToken(),
        },
        body: JSON.stringify({ foto: foto || null, latitud: lat, longitud: lng }),
      });

      if (res.status === 401) { manejarSesionVencida(); return; }

      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        alert(data.error || "No se pudo registrar el movimiento.");
        return;
      }

      if (!enLinea) { enLinea = true; actualizarBadgeConexion(); }

      empleados = empleados.map(function (e) {
        return e.id === id ? data.empleado : e;
      });
      movimientos.unshift(data.movimiento);
      guardarCache();
      renderTodo();

      if (data.movimiento.tipo === "ingreso") {
        if (data.movimiento.llegoTarde) {
          mostrarToast("⚠ " + data.movimiento.nombre + " llegó tarde (" + data.movimiento.minutosTarde + " min)", true);
        } else {
          mostrarToast(data.movimiento.nombre + " marcó ingreso en horario.", false);
        }
      }
    } catch (e) {
      // No se pudo ni siquiera contactar al servidor: registramos la marca localmente
      // (con la foto y ubicación ya capturadas) y la vamos a sincronizar apenas vuelva la conexión.
      enLinea = false;
      var ahoraISO = new Date().toISOString();
      var nuevoEstado = !emp.dentro;
      var clientId = "local-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);

      empleados = empleados.map(function (ee) {
        return ee.id === id ? Object.assign({}, ee, { dentro: nuevoEstado }) : ee;
      });

      var movimientoLocal = {
        id: clientId,
        clientId: clientId,
        empleadoId: id,
        nombre: emp.nombre,
        legajo: emp.legajo,
        area: emp.area,
        tipo: nuevoEstado ? "ingreso" : "egreso",
        timestamp: ahoraISO,
        llegoTarde: false,
        minutosTarde: null,
        foto: foto || null, // se muestra localmente ya mismo; el servidor la guarda al sincronizar
        latitud: lat,
        longitud: lng,
        pendienteSync: true,
      };
      movimientos.unshift(movimientoLocal);

      agregarACola({ clientId: clientId, empleadoId: id, timestamp: ahoraISO, foto: foto || null, latitud: lat, longitud: lng });
      guardarCache();
      renderTodo();
      mostrarToast(
        (nuevoEstado ? "Ingreso" : "Egreso") + " de " + emp.nombre + " guardado sin conexión. Se sincroniza solo.",
        false
      );
    }
  }

  function requiereConexion() {
    if (!enLinea) {
      alert("Esta acción necesita conexión a internet. El marcado de ingreso/egreso sí funciona sin conexión.");
      return false;
    }
    return true;
  }

  async function eliminarEmpleado(id) {
    if (!requiereConexion()) return;
    try {
      await apiDelete("/empleados/" + id);
      empleados = empleados.filter(function (e) { return e.id !== id; });
      renderTodo();
    } catch (err) {
      if (err.message !== "Sesión vencida") alert(err.message);
    }
  }

  // --- Admin: cargar un fichaje olvidado / editar la hora de uno existente ---

  function aValorDatetimeLocal(fecha) {
    function dos(n) { return (n < 10 ? "0" : "") + n; }
    return fecha.getFullYear() + "-" + dos(fecha.getMonth() + 1) + "-" + dos(fecha.getDate()) +
      "T" + dos(fecha.getHours()) + ":" + dos(fecha.getMinutes());
  }

  function abrirModalManual(empleadoId, movimiento) {
    var emp = empleados.find(function (e) { return e.id === empleadoId; });
    var nombre = emp ? emp.nombre : (movimiento ? movimiento.nombre : "");

    document.getElementById("manual-empleado-id").value = empleadoId;
    document.getElementById("manual-movimiento-id").value = movimiento ? movimiento.id : "";
    document.getElementById("manual-emp-nombre").textContent = nombre;
    document.getElementById("manual-error").style.display = "none";

    var ahora = new Date();
    document.getElementById("manual-fecha-hora").max = aValorDatetimeLocal(ahora);

    if (movimiento) {
      document.getElementById("manual-titulo").textContent = "Editar horario de " + (movimiento.tipo === "ingreso" ? "ingreso" : "egreso");
      document.getElementById("manual-campo-tipo").style.display = "none";
      document.getElementById("manual-fecha-hora").value = aValorDatetimeLocal(new Date(movimiento.timestamp));
    } else {
      document.getElementById("manual-titulo").textContent = "Cargar fichaje olvidado";
      document.getElementById("manual-campo-tipo").style.display = "block";
      document.getElementById("manual-tipo").value = emp && emp.dentro ? "egreso" : "ingreso";
      document.getElementById("manual-fecha-hora").value = aValorDatetimeLocal(ahora);
    }
    document.getElementById("modal-manual-overlay").classList.add("open");
  }

  function cerrarModalManual() {
    document.getElementById("modal-manual-overlay").classList.remove("open");
  }

  async function guardarManual(e) {
    e.preventDefault();
    var empleadoId = document.getElementById("manual-empleado-id").value;
    var movId = document.getElementById("manual-movimiento-id").value;
    var fechaHora = document.getElementById("manual-fecha-hora").value;
    var err = document.getElementById("manual-error");

    if (!fechaHora) {
      err.textContent = "Ingresá la fecha y la hora.";
      err.style.display = "block";
      return;
    }
    if (!requiereConexion()) return;

    try {
      if (movId) {
        var r = await apiPut("/movimientos/" + movId, { fechaHora: fechaHora });
        movimientos = movimientos.map(function (m) {
          return m.id === movId
            ? Object.assign({}, m, { timestamp: r.movimiento.timestamp, llegoTarde: r.movimiento.llegoTarde, minutosTarde: r.movimiento.minutosTarde })
            : m;
        });
        empleados = empleados.map(function (emp) {
          return emp.id === r.empleadoId ? Object.assign({}, emp, { dentro: r.dentro }) : emp;
        });
      } else {
        var data = await apiPost("/movimientos/manual", {
          empleadoId: empleadoId,
          tipo: document.getElementById("manual-tipo").value,
          fechaHora: fechaHora,
        });
        movimientos.push(data.movimiento);
        empleados = empleados.map(function (emp) { return emp.id === data.empleado.id ? data.empleado : emp; });
      }
      movimientos.sort(function (a, b) { return new Date(b.timestamp) - new Date(a.timestamp); });
      guardarCache();
      cerrarModalManual();
      renderTodo();
      mostrarToast("Horario guardado.", false);
    } catch (e2) {
      if (e2.message !== "Sesión vencida") {
        err.textContent = e2.message;
        err.style.display = "block";
      }
    }
  }

  async function recargarHistorialPorFecha() {
    var filtroFecha = document.getElementById("filtro-fecha").value;
    try {
      movimientos = filtroFecha
        ? await apiGet("/movimientos?fecha=" + filtroFecha)
        : await apiGet("/movimientos");
      renderHistorial();
    } catch (err) {
      console.error(err);
    }
  }

  function abrirModalTurno(empleadoId) {
    var emp = empleados.find(function (e) { return e.id === empleadoId; });
    if (!emp) return;
    var turno = turnoDe(empleadoId);

    document.getElementById("turno-empleado-id").value = empleadoId;
    document.getElementById("turno-emp-nombre").textContent = emp.nombre;
    document.getElementById("turno-hora").value = turno ? formatHoraCorta(turno.horaEntrada) : "";
    document.getElementById("turno-tolerancia").value = turno ? turno.toleranciaMinutos : 10;
    document.getElementById("btn-quitar-turno").style.display = turno ? "block" : "none";
    document.getElementById("turno-error").style.display = "none";
    document.getElementById("modal-turno-overlay").classList.add("open");
  }

  function cerrarModalTurno() {
    document.getElementById("modal-turno-overlay").classList.remove("open");
    document.getElementById("form-turno").reset();
  }

  async function guardarTurno(e) {
    e.preventDefault();
    var empleadoId = document.getElementById("turno-empleado-id").value;
    var horaEntrada = document.getElementById("turno-hora").value;
    var tolerancia = document.getElementById("turno-tolerancia").value;
    var err = document.getElementById("turno-error");

    if (!horaEntrada) {
      err.textContent = "Ingresá la hora de entrada esperada.";
      err.style.display = "block";
      return;
    }
    if (!requiereConexion()) return;

    try {
      var guardado = await apiPost("/turnos", {
        empleadoId: empleadoId,
        horaEntrada: horaEntrada,
        toleranciaMinutos: tolerancia === "" ? 0 : Number(tolerancia),
      });
      turnos = turnos.filter(function (t) { return t.empleadoId !== empleadoId; });
      turnos.push(guardado);
      cerrarModalTurno();
      renderLista();
    } catch (e2) {
      if (e2.message !== "Sesión vencida") {
        err.textContent = e2.message;
        err.style.display = "block";
      }
    }
  }

  async function quitarTurno() {
    if (!requiereConexion()) return;
    var empleadoId = document.getElementById("turno-empleado-id").value;
    try {
      await apiDelete("/turnos/" + empleadoId);
      turnos = turnos.filter(function (t) { return t.empleadoId !== empleadoId; });
      cerrarModalTurno();
      renderLista();
    } catch (err) {
      if (err.message !== "Sesión vencida") alert(err.message);
    }
  }

  async function exportarHistorial() {
    var btn = document.getElementById("btn-exportar");
    var filtroFecha = document.getElementById("filtro-fecha").value;
    var url = API_URL + "/movimientos/exportar" + (filtroFecha ? "?fecha=" + filtroFecha : "");

    btn.disabled = true;
    var textoOriginal = btn.textContent;
    btn.textContent = "Exportando…";

    try {
      var res = await fetch(url, { headers: { Authorization: "Bearer " + getToken() } });
      if (res.status === 401) { manejarSesionVencida(); return; }
      if (!res.ok) {
        var data = await res.json().catch(function () { return {}; });
        alert(data.error || "No se pudo exportar el historial.");
        return;
      }
      var blob = await res.blob();
      var enlace = document.createElement("a");
      var objectUrl = URL.createObjectURL(blob);
      enlace.href = objectUrl;
      enlace.download = "movimientos" + (filtroFecha ? "-" + filtroFecha : "") + ".xlsx";
      document.body.appendChild(enlace);
      enlace.click();
      document.body.removeChild(enlace);
      URL.revokeObjectURL(objectUrl);
    } catch (e) {
      alert("No se pudo conectar con el servidor para exportar. ¿Hay conexión?");
    } finally {
      btn.disabled = false;
      btn.textContent = textoOriginal;
    }
  }

  // --- Gestión de usuarios (solo admin) ---

  var usuariosCache = [];

  function abrirModalUsuarios() {
    document.getElementById("modal-usuarios-overlay").classList.add("open");
    cargarUsuarios();
    actualizarSelectEmpleadoVinculado();
  }

  function cerrarModalUsuarios() {
    document.getElementById("modal-usuarios-overlay").classList.remove("open");
    document.getElementById("form-usuario").reset();
    document.getElementById("usuario-error").style.display = "none";
    document.getElementById("usuario-exito").style.display = "none";
    actualizarCampoEmpleadoVisible();
  }

  function actualizarCampoEmpleadoVisible() {
    var rol = document.getElementById("usuario-nuevo-rol").value;
    document.getElementById("campo-empleado-vinculado").style.display = rol === "empleado" ? "block" : "none";
  }

  function actualizarSelectEmpleadoVinculado() {
    var select = document.getElementById("usuario-nuevo-empleado");
    var idsConCuenta = usuariosCache.filter(function (u) { return u.empleadoId; }).map(function (u) { return u.empleadoId; });
    var disponibles = empleados.filter(function (e) { return idsConCuenta.indexOf(e.id) === -1; });

    select.innerHTML = "";
    if (disponibles.length === 0) {
      select.innerHTML = '<option value="">No hay fichas sin cuenta vinculada</option>';
      return;
    }
    disponibles.forEach(function (e) {
      var opt = document.createElement("option");
      opt.value = e.id;
      opt.textContent = e.nombre + " (legajo " + e.legajo + ")";
      select.appendChild(opt);
    });
  }

  async function cargarUsuarios() {
    var cont = document.getElementById("lista-usuarios");
    cont.innerHTML = '<div class="empty" style="padding:16px;">Cargando…</div>';
    try {
      usuariosCache = await apiGet("/usuarios");
      renderUsuarios();
      actualizarSelectEmpleadoVinculado();
    } catch (err) {
      if (err.message !== "Sesión vencida") {
        cont.innerHTML = '<div class="empty" style="padding:16px;">No se pudo cargar la lista.</div>';
      }
    }
  }

  function renderUsuarios() {
    var cont = document.getElementById("lista-usuarios");
    if (usuariosCache.length === 0) {
      cont.innerHTML = '<div class="empty" style="padding:16px;">Todavía no hay cuentas creadas.</div>';
      return;
    }
    cont.innerHTML = "";
    usuariosCache.forEach(function (u) {
      var div = document.createElement("div");
      div.className = "usuario-item";
      div.innerHTML =
        '<div class="usuario-info">' +
          '<p class="usuario-nombre">' + escapeHtml(u.usuario) +
            '<span class="rol-pill ' + u.rol + '">' + u.rol + '</span>' +
            (u.tienePassword ? '' : '<span class="pill-pendiente">Pendiente de activar</span>') +
          '</p>' +
          '<p class="usuario-sub">' + escapeHtml(u.email) + (u.empleadoNombre ? ' · ' + escapeHtml(u.empleadoNombre) : '') + '</p>' +
        '</div>' +
        '<div style="display:flex; gap:2px;">' +
          (u.tienePassword ? '' : '<button class="btn-mini" data-id="' + u.id + '" data-accion="reenviar">Reenviar</button>') +
          '<button class="btn-mini" data-id="' + u.id + '" data-accion="clave">Definir clave</button>' +
          '<button class="btn-mini" data-id="' + u.id + '" data-accion="eliminar">Eliminar</button>' +
        '</div>';
      cont.appendChild(div);
    });

    cont.querySelectorAll('[data-accion="reenviar"]').forEach(function (btn) {
      btn.addEventListener("click", function () { reenviarActivacion(btn.getAttribute("data-id")); });
    });
    cont.querySelectorAll('[data-accion="clave"]').forEach(function (btn) {
      btn.addEventListener("click", function () { definirClave(btn.getAttribute("data-id")); });
    });
    cont.querySelectorAll('[data-accion="eliminar"]').forEach(function (btn) {
      btn.addEventListener("click", function () { eliminarUsuario(btn.getAttribute("data-id")); });
    });
  }

  async function definirClave(id) {
    var clave = prompt("Escribí la contraseña nueva para esta cuenta (mínimo 6 caracteres). Después pasásela a la persona:");
    if (clave === null) return;
    if (clave.length < 6) { alert("La contraseña debe tener al menos 6 caracteres."); return; }
    try {
      var data = await apiPost("/usuarios/" + id + "/password", { password: clave });
      mostrarToast(data.mensaje || "Contraseña definida.", false);
      cargarUsuarios();
    } catch (err) {
      if (err.message !== "Sesión vencida") alert(err.message);
    }
  }

  async function reenviarActivacion(id) {
    try {
      var data = await apiPost("/usuarios/" + id + "/reenviar-activacion");
      mostrarToast(data.mensaje || "Mail reenviado.", false);
    } catch (err) {
      if (err.message !== "Sesión vencida") alert(err.message);
    }
  }

  async function eliminarUsuario(id) {
    if (!confirm("¿Eliminar esta cuenta de acceso? La persona ya no va a poder iniciar sesión (su ficha de personal no se borra).")) return;
    try {
      await apiDelete("/usuarios/" + id);
      usuariosCache = usuariosCache.filter(function (u) { return u.id !== id; });
      renderUsuarios();
      actualizarSelectEmpleadoVinculado();
    } catch (err) {
      if (err.message !== "Sesión vencida") alert(err.message);
    }
  }

  async function crearUsuario(e) {
    e.preventDefault();
    var usuario = document.getElementById("usuario-nuevo-usuario").value.trim();
    var email = document.getElementById("usuario-nuevo-email").value.trim();
    var rol = document.getElementById("usuario-nuevo-rol").value;
    var empleadoId = document.getElementById("usuario-nuevo-empleado").value;
    var err = document.getElementById("usuario-error");
    var exito = document.getElementById("usuario-exito");
    err.style.display = "none";
    exito.style.display = "none";

    if (!usuario || !email) {
      err.textContent = "Completá usuario y email.";
      err.style.display = "block";
      return;
    }
    if (rol === "empleado" && !empleadoId) {
      err.textContent = "Elegí a qué ficha de personal vincular esta cuenta.";
      err.style.display = "block";
      return;
    }

    try {
      var data = await apiPost("/usuarios", {
        usuario: usuario,
        email: email,
        rol: rol,
        empleadoId: rol === "empleado" ? empleadoId : null,
      });
      exito.textContent = data.aviso || ("Cuenta creada. Le enviamos un mail a " + email + " para que active su contraseña.");
      exito.style.display = "block";
      document.getElementById("form-usuario").reset();
      actualizarCampoEmpleadoVisible();
      await cargarUsuarios();
    } catch (e2) {
      if (e2.message !== "Sesión vencida") {
        err.textContent = e2.message;
        err.style.display = "block";
      }
    }
  }

  function abrirModal() {
    document.getElementById("modal-overlay").classList.add("open");
    document.getElementById("in-nombre").focus();
  }

  function cerrarModal() {
    document.getElementById("modal-overlay").classList.remove("open");
    document.getElementById("form-error").style.display = "none";
    document.getElementById("form-agregar").reset();
  }

  function mostrarErrorForm(msg) {
    var el = document.getElementById("form-error");
    el.textContent = msg;
    el.style.display = "block";
  }

  async function agregarEmpleado(e) {
    e.preventDefault();
    var nombre = document.getElementById("in-nombre").value.trim();
    var legajo = document.getElementById("in-legajo").value.trim();
    var area = document.getElementById("in-area").value.trim();

    if (!nombre) { mostrarErrorForm("Ingresá un nombre."); return; }
    if (!legajo) { mostrarErrorForm("Ingresá un legajo o DNI."); return; }
    if (!requiereConexion()) return;

    try {
      var nuevo = await apiPost("/empleados", { nombre: nombre, legajo: legajo, area: area });
      empleados.push(nuevo);
      cerrarModal();
      renderTodo();
    } catch (err) {
      if (err.message !== "Sesión vencida") mostrarErrorForm(err.message);
    }
  }

  async function iniciarApp() {
    var conectado = await probarConexion();
    enLinea = conectado;

    if (conectado) {
      try {
        empleados = await apiGet("/empleados");
        movimientos = await apiGet("/movimientos");
        turnos = await apiGet("/turnos");
        guardarCache();
      } catch (err) {
        if (err.message === "Sesión vencida") return;
        console.error("No se pudo conectar con el servidor.", err);
        return;
      }
    } else {
      var hayCache = cargarCache();
      if (!hayCache) {
        mostrarLogin("Necesitás conexión a internet la primera vez que uses la app en este dispositivo.");
        return;
      }
    }

    mostrarApp();
    actualizarReloj();
    renderTodo();
    actualizarBadgeConexion();

    if (conectado) {
      sincronizarCola();
    }
  }

  function init() {
    document.getElementById("form-login").addEventListener("submit", manejarLogin);
    document.getElementById("form-registro").addEventListener("submit", manejarRegistro);
    document.getElementById("tab-login").addEventListener("click", mostrarTabLogin);
    document.getElementById("tab-registro").addEventListener("click", mostrarTabRegistro);
    document.getElementById("btn-logout").addEventListener("click", manejarLogout);

    setInterval(actualizarReloj, 30000);
    setInterval(renderLista, 60000); // refresca los "hace Xm" de quienes están adentro
    setInterval(chequearConexionYSincronizar, 15000); // reintenta sincronizar cada 15s

    window.addEventListener("online", chequearConexionYSincronizar);
    window.addEventListener("offline", function () {
      enLinea = false;
      actualizarBadgeConexion();
    });

    document.getElementById("btn-abrir-modal").addEventListener("click", abrirModal);
    document.getElementById("btn-cerrar-modal").addEventListener("click", cerrarModal);
    document.getElementById("modal-overlay").addEventListener("click", function (e) {
      if (e.target.id === "modal-overlay") cerrarModal();
    });
    document.getElementById("form-agregar").addEventListener("submit", agregarEmpleado);
    document.getElementById("buscar").addEventListener("input", renderLista);
    document.getElementById("filtro-fecha").addEventListener("change", recargarHistorialPorFecha);
    document.getElementById("btn-exportar").addEventListener("click", exportarHistorial);
    document.getElementById("form-manual").addEventListener("submit", guardarManual);
    document.getElementById("btn-cerrar-manual").addEventListener("click", cerrarModalManual);
    document.getElementById("modal-manual-overlay").addEventListener("click", function (e) {
      if (e.target.id === "modal-manual-overlay") cerrarModalManual();
    });
    document.getElementById("form-turno").addEventListener("submit", guardarTurno);
    document.getElementById("btn-cerrar-modal-turno").addEventListener("click", cerrarModalTurno);
    document.getElementById("btn-quitar-turno").addEventListener("click", quitarTurno);
    document.getElementById("modal-turno-overlay").addEventListener("click", function (e) {
      if (e.target.id === "modal-turno-overlay") cerrarModalTurno();
    });

    document.getElementById("btn-abrir-recuperar").addEventListener("click", abrirModalRecuperar);
    document.getElementById("btn-cerrar-recuperar").addEventListener("click", cerrarModalRecuperar);
    document.getElementById("modal-recuperar-overlay").addEventListener("click", function (e) {
      if (e.target.id === "modal-recuperar-overlay") cerrarModalRecuperar();
    });
    document.getElementById("tab-recuperar-usuario").addEventListener("click", mostrarTabRecuperarUsuario);
    document.getElementById("tab-recuperar-password").addEventListener("click", mostrarTabRecuperarPassword);
    document.getElementById("form-recuperar-usuario").addEventListener("submit", manejarRecuperarUsuario);
    document.getElementById("btn-enviar-codigo").addEventListener("click", manejarEnviarCodigo);
    document.getElementById("form-recuperar-password").addEventListener("submit", manejarConfirmarCodigo);

    document.getElementById("btn-tomar-foto").addEventListener("click", tomarFoto);
    document.getElementById("btn-repetir-foto").addEventListener("click", repetirFoto);
    document.getElementById("btn-confirmar-captura").addEventListener("click", confirmarCaptura);
    document.getElementById("btn-omitir-captura").addEventListener("click", omitirCaptura);
    document.getElementById("btn-cerrar-captura").addEventListener("click", cerrarModalCaptura);
    document.getElementById("modal-captura-overlay").addEventListener("click", function (e) {
      if (e.target.id === "modal-captura-overlay") cerrarModalCaptura();
    });
    document.getElementById("btn-cerrar-ver-foto").addEventListener("click", cerrarVerFoto);
    document.getElementById("modal-ver-foto-overlay").addEventListener("click", function (e) {
      if (e.target.id === "modal-ver-foto-overlay") cerrarVerFoto();
    });

    document.getElementById("btn-abrir-usuarios").addEventListener("click", abrirModalUsuarios);
    document.getElementById("btn-cerrar-usuarios").addEventListener("click", cerrarModalUsuarios);
    document.getElementById("modal-usuarios-overlay").addEventListener("click", function (e) {
      if (e.target.id === "modal-usuarios-overlay") cerrarModalUsuarios();
    });
    document.getElementById("usuario-nuevo-rol").addEventListener("change", actualizarCampoEmpleadoVisible);
    document.getElementById("form-usuario").addEventListener("submit", crearUsuario);

    if (getToken()) {
      iniciarApp();
    } else {
      mostrarLogin();
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
