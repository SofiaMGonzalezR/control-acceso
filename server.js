require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");

const app = express();
app.use(cors());
app.use(express.json({ limit: "8mb" })); // las fotos vienen como base64, necesitan más espacio que JSON normal
app.use(express.static(path.join(__dirname, "public")));

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "control_accesos",
  waitForConnections: true,
  connectionLimit: 10,
});

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: Number(process.env.SMTP_PORT) === 465,
  family: 4, // Railway no tiene salida por IPv6: forzamos IPv4 para llegar a Gmail
  connectionTimeout: 15000,
  greetingTimeout: 15000,
  socketTimeout: 20000,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function enviarEmail(destinatario, asunto, texto) {
  // Railway bloquea SMTP: si hay clave de Brevo, enviamos por API (HTTPS)
  if (process.env.BREVO_API_KEY) {
    const respuesta = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": process.env.BREVO_API_KEY,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        sender: {
          name: process.env.MAIL_NOMBRE || "Control de accesos",
          email: process.env.MAIL_REMITENTE,
        },
        to: [{ email: destinatario }],
        subject: asunto,
        textContent: texto,
      }),
    });
    if (!respuesta.ok) {
      const detalle = await respuesta.text();
      throw new Error("Brevo " + respuesta.status + ": " + detalle);
    }
    return;
  }
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: destinatario,
    subject: asunto,
    text: texto,
  });
}

const EMAIL_REGEX = /^[^\s@<>\r\n]+@[^\s@<>\r\n]+\.[^\s@<>\r\n]+$/;

function emailValido(email) {
  return typeof email === "string" && EMAIL_REGEX.test(email.trim()) && email.length <= 150;
}

const JWT_SECRET = process.env.JWT_SECRET || "cambiar-este-secreto";
const JWT_EXPIRA_EN = "12h";

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function validarFoto(fotoBase64) {
  if (!fotoBase64 || typeof fotoBase64 !== "string") return null;
  var match = fotoBase64.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
  if (!match) return null;
  return fotoBase64; // se guarda tal cual (data URI completa) directamente en la base de datos
}

// --- SALUD (para que el frontend detecte si hay conexión con el backend) ---
app.get("/api/salud", (req, res) => {
  res.json({ ok: true });
});

// --- REGISTRO ---
// Autoregistro de empleados: solo funciona si el documento coincide con una
// ficha de personal ya cargada por un administrador (tabla empleados).

app.post("/api/registro", async (req, res) => {
  try {
    const { usuario, email, password, documento } = req.body;

    if (!usuario || !usuario.trim()) return res.status(400).json({ error: "El nombre de usuario es obligatorio." });
    if (!email || !emailValido(email)) return res.status(400).json({ error: "Ingresá un email válido." });
    if (!password || password.length < 6) return res.status(400).json({ error: "La contraseña debe tener al menos 6 caracteres." });
    if (!documento || !documento.trim()) return res.status(400).json({ error: "El documento es obligatorio." });

    const emailNorm = email.trim().toLowerCase();
    const usuarioNorm = usuario.trim();
    const documentoNorm = documento.trim();

    // El documento tiene que coincidir con el legajo/DNI de una ficha ya creada por un admin.
    const [empRows] = await pool.query("SELECT id, nombre FROM empleados WHERE legajo = ?", [documentoNorm]);
    if (empRows.length === 0) {
      return res.status(404).json({
        error: "No encontramos a nadie con ese documento en el personal registrado. Pedile a un administrador que te agregue primero.",
      });
    }
    const empleado = empRows[0];

    // Ese empleado no puede tener ya un usuario vinculado.
    const [yaVinculado] = await pool.query("SELECT id FROM usuarios WHERE empleado_id = ?", [empleado.id]);
    if (yaVinculado.length > 0) {
      return res.status(409).json({ error: "Ese documento ya tiene una cuenta creada. Iniciá sesión en vez de registrarte." });
    }

    const [usuarioExiste] = await pool.query("SELECT id FROM usuarios WHERE usuario = ? OR email = ?", [usuarioNorm, emailNorm]);
    if (usuarioExiste.length > 0) {
      return res.status(409).json({ error: "Ese nombre de usuario o email ya está en uso." });
    }

    const hash = await bcrypt.hash(password, 10);
    const id = uid();
    await pool.query(
      "INSERT INTO usuarios (id, usuario, email, password_hash, rol, empleado_id) VALUES (?, ?, ?, ?, 'empleado', ?)",
      [id, usuarioNorm, emailNorm, hash, empleado.id]
    );

    res.status(201).json({ mensaje: `Cuenta creada para ${empleado.nombre}. Ya podés iniciar sesión.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al registrar la cuenta" });
  }
});

// --- RECUPERAR USUARIO / CONTRASEÑA (por email) ---

function generarCodigo() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 dígitos
}

async function enviarCodigoParaEstablecerPassword(usuarioId, email, esBienvenida) {
  const codigo = generarCodigo();
  const expiraEn = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 horas (más margen que un simple reseteo)

  await pool.query(
    "INSERT INTO codigos_recuperacion (id, usuario_id, codigo, expira_en) VALUES (?, ?, ?, ?)",
    [uid(), usuarioId, codigo, expiraEn]
  );

  const asunto = esBienvenida ? "Bienvenido/a - Activá tu cuenta de Control de acceso" : "Código para restablecer tu contraseña - Control de acceso";
  const cuerpo = esBienvenida
    ? `Hola,\n\nSe creó una cuenta para vos en la app de Control de acceso.\n\nPara activarla, entrá a la app, tocá "¿Olvidaste tu usuario o contraseña?" → "Olvidé mi contraseña", poné tu email (${email}) y usá este código para elegir tu contraseña: ${codigo}\n\nVence en 24 horas.`
    : `Hola,\n\nTu código para restablecer tu contraseña es: ${codigo}\n\nVence en 24 horas. Si no pediste esto, podés ignorar este mensaje.`;

  await enviarEmail(email, asunto, cuerpo);
}

// Enviar por mail el nombre de usuario asociado a ese email
app.post("/api/recuperar/usuario", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !emailValido(email)) {
      return res.status(400).json({ error: "Ingresá un email válido." });
    }
    const emailNorm = email.trim().toLowerCase();

    const [rows] = await pool.query("SELECT usuario FROM usuarios WHERE email = ?", [emailNorm]);
    if (rows.length > 0) {
      await enviarEmail(
        emailNorm,
        "Tu nombre de usuario - Control de acceso",
        `Hola,\n\nTu nombre de usuario para ingresar a la app de Control de acceso es: ${rows[0].usuario}\n\nSi no pediste esto, podés ignorar este mensaje.`
      );
    }
    // Mismo mensaje exista o no el email, para no revelar qué emails están registrados.
    res.json({ mensaje: "Si ese email está registrado, te enviamos tu usuario por correo." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo procesar la solicitud. Verificá la configuración de correo del servidor." });
  }
});

// Paso 1 de recuperar contraseña: pedir un código y enviarlo por mail
app.post("/api/recuperar/solicitar-codigo", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !emailValido(email)) {
      return res.status(400).json({ error: "Ingresá un email válido." });
    }
    const emailNorm = email.trim().toLowerCase();

    const [rows] = await pool.query("SELECT id FROM usuarios WHERE email = ?", [emailNorm]);
    if (rows.length > 0) {
      await enviarCodigoParaEstablecerPassword(rows[0].id, emailNorm, false);
    }
    res.json({ mensaje: "Si ese email está registrado, te enviamos un código de verificación." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo procesar la solicitud. Verificá la configuración de correo del servidor." });
  }
});

// Paso 2 de recuperar contraseña: validar el código e ingresar la nueva contraseña
app.post("/api/recuperar/confirmar", async (req, res) => {
  try {
    const { email, codigo, nuevaPassword } = req.body;
    if (!email || !codigo || !nuevaPassword) {
      return res.status(400).json({ error: "Completá todos los campos." });
    }
    if (nuevaPassword.length < 6) {
      return res.status(400).json({ error: "La nueva contraseña debe tener al menos 6 caracteres." });
    }
    const emailNorm = email.trim().toLowerCase();

    const [userRows] = await pool.query("SELECT id FROM usuarios WHERE email = ?", [emailNorm]);
    if (userRows.length === 0) {
      return res.status(400).json({ error: "Código inválido o vencido." });
    }
    const usuarioId = userRows[0].id;

    const [codRows] = await pool.query(
      "SELECT * FROM codigos_recuperacion WHERE usuario_id = ? AND codigo = ? AND usado = FALSE ORDER BY creado_en DESC LIMIT 1",
      [usuarioId, codigo.trim()]
    );
    if (codRows.length === 0) {
      return res.status(400).json({ error: "Código inválido o vencido." });
    }
    const registro = codRows[0];
    if (new Date(registro.expira_en) < new Date()) {
      return res.status(400).json({ error: "Ese código venció. Pedí uno nuevo." });
    }

    const hash = await bcrypt.hash(nuevaPassword, 10);
    await pool.query("UPDATE usuarios SET password_hash = ? WHERE id = ?", [hash, usuarioId]);
    await pool.query("UPDATE codigos_recuperacion SET usado = TRUE WHERE id = ?", [registro.id]);

    res.json({ mensaje: "Contraseña actualizada. Ya podés iniciar sesión." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo actualizar la contraseña." });
  }
});

// --- LOGIN ---

app.post("/api/login", async (req, res) => {
  try {
    const { usuario, password } = req.body;
    if (!usuario || !password) {
      return res.status(400).json({ error: "Ingresá usuario y contraseña." });
    }

    const [rows] = await pool.query("SELECT * FROM usuarios WHERE usuario = ? OR email = ?", [usuario.trim(), usuario.trim().toLowerCase()]);
    if (rows.length === 0) {
      return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
    }

    const usuarioDb = rows[0];

    if (!usuarioDb.password_hash) {
      return res.status(403).json({
        error: "Tu cuenta todavía no tiene contraseña. Andá a \"¿Olvidaste tu usuario o contraseña?\" → \"Olvidé mi contraseña\" para crear la tuya con el código que te enviamos por mail.",
      });
    }

    const coincide = await bcrypt.compare(password, usuarioDb.password_hash);
    if (!coincide) {
      return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
    }

    const token = jwt.sign(
      { id: usuarioDb.id, usuario: usuarioDb.usuario, rol: usuarioDb.rol, empleadoId: usuarioDb.empleado_id },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRA_EN }
    );

    res.json({ token, usuario: usuarioDb.usuario, rol: usuarioDb.rol });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al iniciar sesión" });
  }
});

// --- MIDDLEWARE: exige un token válido para todo lo que sigue ---

function requiereLogin(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "No autenticado." });
  }

  try {
    req.usuario = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: "Sesión inválida o vencida. Iniciá sesión de nuevo." });
  }
}

app.use("/api/empleados", requiereLogin);
app.use("/api/movimientos", requiereLogin);
app.use("/api/turnos", requiereLogin);
app.use("/api/usuarios", requiereLogin);

function requiereAdmin(req, res, next) {
  if (!req.usuario || req.usuario.rol !== "admin") {
    return res.status(403).json({ error: "Esta acción requiere un usuario administrador." });
  }
  next();
}

// --- USUARIOS (gestión de accesos, solo admin) ---

// Listar todas las cuentas de acceso
app.get("/api/usuarios", requiereAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT u.id, u.usuario, u.email, u.rol, u.empleado_id AS empleadoId, u.activo,
             (u.password_hash IS NOT NULL) AS tienePassword,
             e.nombre AS empleadoNombre
      FROM usuarios u
      LEFT JOIN empleados e ON e.id = u.empleado_id
      ORDER BY u.creado_en DESC
    `);
    res.json(rows.map((r) => ({ ...r, activo: !!r.activo, tienePassword: !!r.tienePassword })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener los usuarios" });
  }
});

// Crear una cuenta de acceso nueva, eligiendo el rol (admin decide, no autoregistro)
app.post("/api/usuarios", requiereAdmin, async (req, res) => {
  try {
    const { usuario, email, rol, empleadoId } = req.body;

    if (!usuario || !usuario.trim()) return res.status(400).json({ error: "El nombre de usuario es obligatorio." });
    if (!email || !emailValido(email)) return res.status(400).json({ error: "Ingresá un email válido." });
    if (rol !== "admin" && rol !== "empleado") return res.status(400).json({ error: "El rol debe ser admin o empleado." });

    const usuarioNorm = usuario.trim();
    const emailNorm = email.trim().toLowerCase();

    let empleadoIdFinal = null;
    if (rol === "empleado") {
      if (!empleadoId) return res.status(400).json({ error: "Elegí a qué ficha de personal vincular esta cuenta." });
      const [empRows] = await pool.query("SELECT id FROM empleados WHERE id = ?", [empleadoId]);
      if (empRows.length === 0) return res.status(404).json({ error: "Esa ficha de personal no existe." });
      const [yaVinculado] = await pool.query("SELECT id FROM usuarios WHERE empleado_id = ?", [empleadoId]);
      if (yaVinculado.length > 0) return res.status(409).json({ error: "Esa ficha ya tiene una cuenta de acceso." });
      empleadoIdFinal = empleadoId;
    }

    const [existe] = await pool.query("SELECT id FROM usuarios WHERE usuario = ? OR email = ?", [usuarioNorm, emailNorm]);
    if (existe.length > 0) return res.status(409).json({ error: "Ese nombre de usuario o email ya está en uso." });

    const id = uid();
    await pool.query(
      "INSERT INTO usuarios (id, usuario, email, password_hash, rol, empleado_id, activo) VALUES (?, ?, ?, NULL, ?, ?, TRUE)",
      [id, usuarioNorm, emailNorm, rol, empleadoIdFinal]
    );

    try {
      await enviarCodigoParaEstablecerPassword(id, emailNorm, true);
    } catch (mailErr) {
      console.error("La cuenta se creó pero no se pudo enviar el mail de bienvenida:", mailErr.message);
      return res.status(201).json({
        usuario: { id, usuario: usuarioNorm, email: emailNorm, rol, empleadoId: empleadoIdFinal },
        aviso: "La cuenta se creó, pero no se pudo enviar el mail de bienvenida. Revisá la configuración de correo (.env) y pedile a la persona que use \"Olvidé mi contraseña\" con su email.",
      });
    }

    res.status(201).json({ usuario: { id, usuario: usuarioNorm, email: emailNorm, rol, empleadoId: empleadoIdFinal } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al crear el usuario" });
  }
});

// Reenviar el mail de activación (por si no le llegó o venció el código)
app.post("/api/usuarios/:id/reenviar-activacion", requiereAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT id, email FROM usuarios WHERE id = ?", [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: "Usuario no encontrado." });
    await enviarCodigoParaEstablecerPassword(rows[0].id, rows[0].email, true);
    res.json({ mensaje: "Mail de activación reenviado." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo reenviar el mail. Revisá la configuración de correo (.env)." });
  }
});

// Eliminar una cuenta de acceso (no la ficha de personal, solo el login)
app.delete("/api/usuarios/:id", requiereAdmin, async (req, res) => {
  try {
    if (req.params.id === req.usuario.id) {
      return res.status(400).json({ error: "No podés eliminar tu propia cuenta desde acá." });
    }
    await pool.query("DELETE FROM usuarios WHERE id = ?", [req.params.id]);
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al eliminar el usuario" });
  }
});

// --- TURNOS (horario esperado + tolerancia) ---

// Obtener todos los turnos (admin) o solo el propio (empleado)
app.get("/api/turnos", async (req, res) => {
  try {
    let rows;
    if (req.usuario.rol === "empleado") {
      if (!req.usuario.empleadoId) return res.json([]);
      [rows] = await pool.query(
        "SELECT empleado_id AS empleadoId, hora_entrada AS horaEntrada, tolerancia_minutos AS toleranciaMinutos FROM turnos WHERE empleado_id = ?",
        [req.usuario.empleadoId]
      );
    } else {
      [rows] = await pool.query(
        "SELECT empleado_id AS empleadoId, hora_entrada AS horaEntrada, tolerancia_minutos AS toleranciaMinutos FROM turnos"
      );
    }
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener los turnos" });
  }
});

// Crear o actualizar el turno de un empleado (solo admin)
app.post("/api/turnos", requiereAdmin, async (req, res) => {
  try {
    const { empleadoId, horaEntrada, toleranciaMinutos } = req.body;
    if (!empleadoId || !horaEntrada) {
      return res.status(400).json({ error: "Faltan datos: empleado y hora de entrada son obligatorios." });
    }
    const tolerancia = Number.isFinite(Number(toleranciaMinutos)) ? Number(toleranciaMinutos) : 0;

    const [empRows] = await pool.query("SELECT id FROM empleados WHERE id = ?", [empleadoId]);
    if (empRows.length === 0) {
      return res.status(404).json({ error: "Empleado no encontrado." });
    }

    const [existente] = await pool.query("SELECT id FROM turnos WHERE empleado_id = ?", [empleadoId]);
    if (existente.length > 0) {
      await pool.query(
        "UPDATE turnos SET hora_entrada = ?, tolerancia_minutos = ? WHERE empleado_id = ?",
        [horaEntrada, tolerancia, empleadoId]
      );
    } else {
      await pool.query(
        "INSERT INTO turnos (id, empleado_id, hora_entrada, tolerancia_minutos) VALUES (?, ?, ?, ?)",
        [uid(), empleadoId, horaEntrada, tolerancia]
      );
    }
    res.json({ empleadoId, horaEntrada, toleranciaMinutos: tolerancia });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al guardar el turno" });
  }
});

// Eliminar el turno de un empleado (solo admin)
app.delete("/api/turnos/:empleadoId", requiereAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM turnos WHERE empleado_id = ?", [req.params.empleadoId]);
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al eliminar el turno" });
  }
});

// --- EMPLEADOS ---

// Obtener todos los empleados
app.get("/api/empleados", async (req, res) => {
  try {
    let rows;
    if (req.usuario.rol === "empleado") {
      if (!req.usuario.empleadoId) {
        return res.json([]);
      }
      [rows] = await pool.query(
        "SELECT id, nombre, legajo, area, dentro FROM empleados WHERE id = ?",
        [req.usuario.empleadoId]
      );
    } else {
      [rows] = await pool.query(
        "SELECT id, nombre, legajo, area, dentro FROM empleados ORDER BY nombre"
      );
    }
    res.json(rows.map((r) => ({ ...r, dentro: !!r.dentro })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener empleados" });
  }
});

// Crear un empleado
app.post("/api/empleados", requiereAdmin, async (req, res) => {
  try {
    const { nombre, legajo, area } = req.body;
    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ error: "El nombre es obligatorio." });
    }
    if (!legajo || !legajo.trim()) {
      return res.status(400).json({ error: "El legajo o DNI es obligatorio." });
    }

    const [existentes] = await pool.query(
      "SELECT id FROM empleados WHERE legajo = ?",
      [legajo.trim()]
    );
    if (existentes.length > 0) {
      return res.status(409).json({ error: "Ya existe un empleado con ese legajo o DNI." });
    }

    const id = uid();
    await pool.query(
      "INSERT INTO empleados (id, nombre, legajo, area, dentro) VALUES (?, ?, ?, ?, FALSE)",
      [id, nombre.trim(), legajo.trim(), (area || "").trim() || "Sin área"]
    );
    res.status(201).json({ id, nombre: nombre.trim(), legajo: legajo.trim(), area: (area || "").trim() || "Sin área", dentro: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al crear empleado" });
  }
});

// Eliminar un empleado
app.delete("/api/empleados/:id", requiereAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM empleados WHERE id = ?", [req.params.id]);
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al eliminar empleado" });
  }
});

// Marcar ingreso/egreso (toggle) y registrar el movimiento
app.post("/api/empleados/:id/marcar", async (req, res) => {
  if (req.usuario.rol === "empleado" && req.usuario.empleadoId !== req.params.id) {
    return res.status(403).json({ error: "Solo podés marcar tu propio ingreso o egreso." });
  }
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query("SELECT * FROM empleados WHERE id = ?", [req.params.id]);
    if (rows.length === 0) {
      conn.release();
      return res.status(404).json({ error: "Empleado no encontrado" });
    }
    const empleado = rows[0];
    const nuevoEstado = !empleado.dentro;
    const tipo = nuevoEstado ? "ingreso" : "egreso";

    // Si viene de una marca hecha offline, usamos la hora real en la que se marcó
    // (dentro de un margen razonable), en vez de la hora en que se sincroniza.
    let ahora = new Date();
    const { timestampCliente, foto, latitud, longitud } = req.body || {};
    if (timestampCliente) {
      const propuesta = new Date(timestampCliente);
      const margenMs = 24 * 60 * 60 * 1000; // hasta 24hs de diferencia, por si estuvo offline un buen rato
      if (!isNaN(propuesta.getTime()) && Math.abs(Date.now() - propuesta.getTime()) < margenMs) {
        ahora = propuesta;
      }
    }

    const fotoGuardar = validarFoto(foto);
    const lat = Number.isFinite(Number(latitud)) ? Number(latitud) : null;
    const lng = Number.isFinite(Number(longitud)) ? Number(longitud) : null;

    let llegoTarde = false;
    let minutosTarde = null;

    if (tipo === "ingreso") {
      const [turnoRows] = await conn.query("SELECT * FROM turnos WHERE empleado_id = ?", [empleado.id]);
      if (turnoRows.length > 0) {
        const turno = turnoRows[0];
        const [h, m, s] = String(turno.hora_entrada).split(":").map(Number);
        const limite = new Date(ahora);
        limite.setHours(h, m, s || 0, 0);
        limite.setMinutes(limite.getMinutes() + turno.tolerancia_minutos);

        if (ahora > limite) {
          llegoTarde = true;
          minutosTarde = Math.round((ahora - limite) / 60000);
        }
      }
    }

    await conn.beginTransaction();
    await conn.query("UPDATE empleados SET dentro = ? WHERE id = ?", [nuevoEstado, empleado.id]);
    const movId = uid();
    await conn.query(
      "INSERT INTO movimientos (id, empleado_id, nombre, legajo, area, tipo, fecha_hora, llego_tarde, minutos_tarde, foto, latitud, longitud) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [movId, empleado.id, empleado.nombre, empleado.legajo, empleado.area, tipo, ahora, llegoTarde, minutosTarde, fotoGuardar, lat, lng]
    );
    await conn.commit();

    res.json({
      empleado: { id: empleado.id, nombre: empleado.nombre, legajo: empleado.legajo, area: empleado.area, dentro: nuevoEstado },
      movimiento: {
        id: movId,
        empleadoId: empleado.id,
        nombre: empleado.nombre,
        legajo: empleado.legajo,
        area: empleado.area,
        tipo,
        timestamp: ahora.toISOString(),
        llegoTarde,
        minutosTarde,
        foto: fotoGuardar,
        latitud: lat,
        longitud: lng,
      },
    });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: "Error al registrar el movimiento" });
  } finally {
    conn.release();
  }
});

// --- MOVIMIENTOS ---

// Exportar historial completo a Excel (.xlsx) — respeta el mismo filtro de fecha
// y las mismas restricciones de un usuario "empleado" que el resto del historial.
app.get("/api/movimientos/exportar", async (req, res) => {
  try {
    const { fecha } = req.query;
    const esEmpleado = req.usuario.rol === "empleado";
    if (esEmpleado && !req.usuario.empleadoId) {
      return res.status(403).json({ error: "No hay nada para exportar." });
    }

    let rows;
    if (fecha && esEmpleado) {
      [rows] = await pool.query(
        "SELECT nombre, legajo, area, tipo, fecha_hora, llego_tarde, minutos_tarde, latitud, longitud FROM movimientos WHERE DATE(fecha_hora) = ? AND empleado_id = ? ORDER BY fecha_hora ASC",
        [fecha, req.usuario.empleadoId]
      );
    } else if (fecha) {
      [rows] = await pool.query(
        "SELECT nombre, legajo, area, tipo, fecha_hora, llego_tarde, minutos_tarde, latitud, longitud FROM movimientos WHERE DATE(fecha_hora) = ? ORDER BY fecha_hora ASC",
        [fecha]
      );
    } else if (esEmpleado) {
      [rows] = await pool.query(
        "SELECT nombre, legajo, area, tipo, fecha_hora, llego_tarde, minutos_tarde, latitud, longitud FROM movimientos WHERE empleado_id = ? ORDER BY fecha_hora ASC",
        [req.usuario.empleadoId]
      );
    } else {
      [rows] = await pool.query(
        "SELECT nombre, legajo, area, tipo, fecha_hora, llego_tarde, minutos_tarde, latitud, longitud FROM movimientos ORDER BY fecha_hora ASC"
      );
    }

    const workbook = new ExcelJS.Workbook();
    const hoja = workbook.addWorksheet("Movimientos");
    hoja.columns = [
      { header: "Nombre", key: "nombre", width: 22 },
      { header: "Legajo", key: "legajo", width: 12 },
      { header: "Área", key: "area", width: 16 },
      { header: "Tipo", key: "tipo", width: 9 },
      { header: "Fecha", key: "fecha", width: 12 },
      { header: "Hora", key: "hora", width: 8 },
      { header: "Llegó tarde", key: "tarde", width: 11 },
      { header: "Minutos tarde", key: "minTarde", width: 13 },
      { header: "Latitud", key: "lat", width: 11 },
      { header: "Longitud", key: "lng", width: 11 },
    ];
    hoja.getRow(1).font = { bold: true };

    rows.forEach((r) => {
      hoja.addRow({
        nombre: r.nombre,
        legajo: r.legajo,
        area: r.area,
        tipo: r.tipo === "ingreso" ? "Ingreso" : "Egreso",
        fecha: new Date(r.fecha_hora).toLocaleDateString("es-AR"),
        hora: new Date(r.fecha_hora).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" }),
        tarde: r.llego_tarde ? "Sí" : "No",
        minTarde: r.minutos_tarde ?? "",
        lat: r.latitud ?? "",
        lng: r.longitud ?? "",
      });
    });

    const buffer = await workbook.xlsx.writeBuffer();

    const nombreArchivo = "movimientos" + (fecha ? "-" + fecha : "") + ".xlsx";
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${nombreArchivo}"`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al exportar el historial" });
  }
});

// Obtener historial (opcionalmente filtrado por fecha, formato YYYY-MM-DD)
app.get("/api/movimientos", async (req, res) => {
  try {
    const { fecha } = req.query;
    const esEmpleado = req.usuario.rol === "empleado";
    if (esEmpleado && !req.usuario.empleadoId) {
      return res.json([]);
    }

    let rows;
    if (fecha && esEmpleado) {
      [rows] = await pool.query(
        "SELECT id, empleado_id AS empleadoId, nombre, legajo, area, tipo, fecha_hora AS timestamp, llego_tarde AS llegoTarde, minutos_tarde AS minutosTarde, foto, latitud, longitud FROM movimientos WHERE DATE(fecha_hora) = ? AND empleado_id = ? ORDER BY fecha_hora DESC",
        [fecha, req.usuario.empleadoId]
      );
    } else if (fecha) {
      [rows] = await pool.query(
        "SELECT id, empleado_id AS empleadoId, nombre, legajo, area, tipo, fecha_hora AS timestamp, llego_tarde AS llegoTarde, minutos_tarde AS minutosTarde, foto, latitud, longitud FROM movimientos WHERE DATE(fecha_hora) = ? ORDER BY fecha_hora DESC",
        [fecha]
      );
    } else if (esEmpleado) {
      [rows] = await pool.query(
        "SELECT id, empleado_id AS empleadoId, nombre, legajo, area, tipo, fecha_hora AS timestamp, llego_tarde AS llegoTarde, minutos_tarde AS minutosTarde, foto, latitud, longitud FROM movimientos WHERE empleado_id = ? ORDER BY fecha_hora DESC LIMIT 50",
        [req.usuario.empleadoId]
      );
    } else {
      [rows] = await pool.query(
        "SELECT id, empleado_id AS empleadoId, nombre, legajo, area, tipo, fecha_hora AS timestamp, llego_tarde AS llegoTarde, minutos_tarde AS minutosTarde, foto, latitud, longitud FROM movimientos ORDER BY fecha_hora DESC LIMIT 50"
      );
    }
    res.json(rows.map((r) => ({ ...r, llegoTarde: !!r.llegoTarde })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener el historial" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor de Control de Acceso corriendo en http://localhost:${PORT}`);
});
