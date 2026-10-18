require("dotenv").config();
// Railway corre en horario UTC. Fijamos SIEMPRE la zona horaria del negocio (por defecto Argentina)
// para que las horas guardadas, la tolerancia y los "llegó tarde" usen el horario local.
const ZONA_HORARIA = process.env.ZONA_HORARIA || "America/Argentina/Buenos_Aires";
process.env.TZ = ZONA_HORARIA;
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const path = require("path");
const ExcelJS = require("exceljs");
const { enviarEmail } = require("./correo");
const { asegurarEsquema, generarCodigoEmpresa, uid } = require("./esquema");

const app = express();
app.set("trust proxy", 1); // Railway pone un proxy delante: así vemos la IP real de cada visita
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

// --- Utilidades ---

const EMAIL_REGEX = /^[^\s@<>\r\n]+@[^\s@<>\r\n]+\.[^\s@<>\r\n]+$/;

function emailValido(email) {
  return typeof email === "string" && EMAIL_REGEX.test(email.trim()) && email.length <= 150;
}

// Si no hay JWT_SECRET cargado, usamos uno al azar (las sesiones se cierran si el servidor reinicia).
// Nunca usamos un valor fijo conocido: cualquiera podría fabricarse un token de administrador.
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET === "cambiar-este-secreto") {
  JWT_SECRET = crypto.randomBytes(32).toString("hex");
  console.warn("AVISO: falta la variable JWT_SECRET en Railway. Cargala para que las sesiones no se cierren al reiniciar.");
}
const JWT_EXPIRA_EN = "12h";

function validarFoto(fotoBase64) {
  if (!fotoBase64 || typeof fotoBase64 !== "string") return null;
  if (fotoBase64.length > 3 * 1024 * 1024) return null;
  var match = fotoBase64.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
  if (!match) return null;
  return fotoBase64; // se guarda tal cual (data URI completa) directamente en la base de datos
}

// Límite de intentos en memoria: frena a quien prueba contraseñas o códigos sin parar.
function limitar({ max, ventanaMs, clave }) {
  const registro = new Map();
  setInterval(() => {
    const ahora = Date.now();
    for (const [k, lista] of registro) {
      const vigentes = lista.filter((t) => ahora - t < ventanaMs);
      if (vigentes.length === 0) registro.delete(k);
      else registro.set(k, vigentes);
    }
  }, 10 * 60 * 1000).unref();

  return (req, res, next) => {
    const k = clave ? clave(req) : req.ip;
    const ahora = Date.now();
    const lista = (registro.get(k) || []).filter((t) => ahora - t < ventanaMs);
    if (lista.length >= max) {
      return res.status(429).json({ error: "Demasiados intentos. Esperá unos minutos y probá de nuevo." });
    }
    lista.push(ahora);
    registro.set(k, lista);
    next();
  };
}

// Normaliza el texto (sin mayúsculas ni tildes) para que "Víctima@x.com" y "victima@x.com" cuenten como lo mismo.
const textoClave = (req, campo) =>
  String((req.body && req.body[campo]) || "").trim().toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");

async function nombreDeEmpresa(empresaId) {
  const [r] = await pool.query("SELECT nombre FROM empresas WHERE id = ?", [empresaId]);
  return r.length > 0 ? r[0].nombre : "tu empresa";
}

function firmarToken(u) {
  return jwt.sign(
    { id: u.id, usuario: u.usuario, rol: u.rol, empleadoId: u.empleado_id, empresaId: u.empresa_id },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRA_EN }
  );
}

// --- SALUD (para que el frontend detecte si hay conexión con el backend) ---
app.get("/api/salud", (req, res) => {
  res.json({ ok: true });
});

// --- CÓDIGOS POR MAIL (activar cuenta / restablecer contraseña) ---

function generarCodigo() {
  return String(crypto.randomInt(100000, 1000000)); // 6 dígitos
}

// tipo: "verificacion" (alta de empresa), "bienvenida" (cuenta creada por un admin) o "recuperacion"
async function enviarCodigoPorMail(usuarioId, email, empresaId, tipo) {
  const codigo = generarCodigo();
  const expiraEn = new Date(Date.now() + 24 * 60 * 60 * 1000);

  // Un código nuevo anula los anteriores de esa persona.
  await pool.query("UPDATE codigos_recuperacion SET usado = TRUE WHERE usuario_id = ? AND usado = FALSE", [usuarioId]);
  await pool.query(
    "INSERT INTO codigos_recuperacion (id, usuario_id, codigo, expira_en) VALUES (?, ?, ?, ?)",
    [uid(), usuarioId, codigo, expiraEn]
  );

  const empresa = await nombreDeEmpresa(empresaId);
  let asunto;
  let cuerpo;
  if (tipo === "verificacion") {
    asunto = "Confirmá tu cuenta - Control de acceso";
    cuerpo = `Hola,\n\nGracias por crear la empresa "${empresa}" en Control de acceso.\n\nTu código para confirmar tu email es: ${codigo}\n\nIngresalo en la pantalla donde te lo pedimos. Vence en 24 horas.\n\nSi no fuiste vos, podés ignorar este mensaje.`;
  } else if (tipo === "bienvenida") {
    asunto = `Bienvenido/a a ${empresa} - Activá tu cuenta`;
    cuerpo = `Hola,\n\nSe creó una cuenta para vos en la app de Control de acceso de "${empresa}".\n\nPara activarla, entrá a la app, tocá "¿Olvidaste tu usuario o contraseña?" → "Olvidé mi contraseña", poné tu email (${email}) y usá este código para elegir tu contraseña: ${codigo}\n\nVence en 24 horas.`;
  } else {
    asunto = "Código para restablecer tu contraseña - Control de acceso";
    cuerpo = `Hola,\n\nTu código para restablecer tu contraseña es: ${codigo}\n\nVence en 24 horas. Si no pediste esto, podés ignorar este mensaje.`;
  }

  await enviarEmail(email, asunto, cuerpo);
}

// Intentos fallidos por persona: a los 5 errores se anulan sus códigos y hay que pedir uno nuevo.
const intentosFallidos = new Map();

// Valida un código vigente de un usuario. Devuelve { registro } o { error }.
async function validarCodigo(usuarioId, codigo) {
  const [codRows] = await pool.query(
    "SELECT * FROM codigos_recuperacion WHERE usuario_id = ? AND codigo = ? AND usado = FALSE ORDER BY creado_en DESC LIMIT 1",
    [usuarioId, String(codigo).trim()]
  );
  if (codRows.length === 0) {
    const fallos = (intentosFallidos.get(usuarioId) || 0) + 1;
    if (fallos >= 5) {
      intentosFallidos.delete(usuarioId);
      await pool.query("UPDATE codigos_recuperacion SET usado = TRUE WHERE usuario_id = ?", [usuarioId]);
      return { error: "Demasiados intentos incorrectos. Pedí un código nuevo." };
    }
    intentosFallidos.set(usuarioId, fallos);
    return { error: "Código inválido o vencido." };
  }
  if (new Date(codRows[0].expira_en) < new Date()) return { error: "Ese código venció. Pedí uno nuevo." };
  intentosFallidos.delete(usuarioId);
  return { registro: codRows[0] };
}

// Marca el código como usado de forma atómica: si dos pedidos llegan juntos, solo uno lo consigue.
async function consumirCodigo(registroId) {
  const [r] = await pool.query("UPDATE codigos_recuperacion SET usado = TRUE WHERE id = ? AND usado = FALSE", [registroId]);
  return r.affectedRows === 1;
}

// --- ALTA DE UNA EMPRESA NUEVA (el cliente se registra y elige a su administrador) ---

app.post(
  "/api/empresas/registro",
  limitar({ max: 10, ventanaMs: 60 * 60 * 1000 }),
  async (req, res) => {
    const { empresa, usuario, email, password } = req.body || {};

    if (typeof empresa !== "string" || !empresa.trim()) return res.status(400).json({ error: "Escribí el nombre de la empresa." });
    if (empresa.trim().length > 100) return res.status(400).json({ error: "El nombre de la empresa es demasiado largo." });
    if (typeof usuario !== "string" || !usuario.trim()) return res.status(400).json({ error: "El nombre de usuario es obligatorio." });
    if (usuario.trim().length > 50) return res.status(400).json({ error: "El nombre de usuario es demasiado largo." });
    if (!emailValido(email)) return res.status(400).json({ error: "Ingresá un email válido." });
    if (typeof password !== "string" || password.length < 6 || password.length > 100) {
      return res.status(400).json({ error: "La contraseña debe tener entre 6 y 100 caracteres." });
    }

    const emailNorm = email.trim().toLowerCase();
    const usuarioNorm = usuario.trim();
    const empresaNorm = empresa.trim();
    const verificar = process.env.VERIFICAR_EMAIL !== "false";

    const empresaId = uid();
    const usuarioId = uid();
    let empresaCreada = false;

    try {
      // Un alta que nunca se confirmó solo se descarta cuando ya venció (más de 24 horas).
      // Antes de eso nadie puede pisarla: si no, un tercero podría robarle el alta a su dueño real.
      const [existe] = await pool.query("SELECT id, empresa_id, rol, activo, creado_en FROM usuarios WHERE usuario = ? OR email = ?", [usuarioNorm, emailNorm]);
      for (const u of existe) {
        let descartable = false;
        const vencida = Date.now() - new Date(u.creado_en).getTime() > 24 * 60 * 60 * 1000;
        if (!u.activo && u.rol === "admin" && vencida) {
          const [[{ usuarios }]] = await pool.query("SELECT COUNT(*) AS usuarios FROM usuarios WHERE empresa_id = ?", [u.empresa_id]);
          const [[{ empleados }]] = await pool.query("SELECT COUNT(*) AS empleados FROM empleados WHERE empresa_id = ?", [u.empresa_id]);
          descartable = Number(usuarios) === 1 && Number(empleados) === 0;
        }
        if (!descartable) return res.status(409).json({ error: "Ese nombre de usuario o email ya está en uso." });
      }
      for (const u of existe) {
        await pool.query("DELETE FROM usuarios WHERE id = ?", [u.id]);
        await pool.query("DELETE FROM empresas WHERE id = ?", [u.empresa_id]);
      }

      const hash = await bcrypt.hash(password, 10);

      for (let intento = 0; intento < 5 && !empresaCreada; intento++) {
        try {
          await pool.query("INSERT INTO empresas (id, nombre, codigo) VALUES (?, ?, ?)", [empresaId, empresaNorm, generarCodigoEmpresa()]);
          empresaCreada = true;
        } catch (e) {
          if (e.code !== "ER_DUP_ENTRY") throw e; // código repetido: probamos con otro
        }
      }
      if (!empresaCreada) throw new Error("No se pudo generar el código de empresa");

      await pool.query(
        "INSERT INTO usuarios (id, empresa_id, usuario, email, password_hash, rol, empleado_id, activo) VALUES (?, ?, ?, ?, ?, 'admin', NULL, ?)",
        [usuarioId, empresaId, usuarioNorm, emailNorm, hash, !verificar]
      );

      if (!verificar) {
        const token = firmarToken({ id: usuarioId, usuario: usuarioNorm, rol: "admin", empleado_id: null, empresa_id: empresaId });
        return res.status(201).json({ token, usuario: usuarioNorm, rol: "admin", empresa: empresaNorm });
      }

      try {
        await enviarCodigoPorMail(usuarioId, emailNorm, empresaId, "verificacion");
      } catch (mailErr) {
        console.error("No se pudo enviar el mail de verificación:", mailErr.message);
        await pool.query("DELETE FROM usuarios WHERE id = ?", [usuarioId]);
        await pool.query("DELETE FROM empresas WHERE id = ?", [empresaId]);
        return res.status(502).json({ error: "No pudimos enviar el mail de confirmación. Probá de nuevo en unos minutos." });
      }

      res.status(201).json({ requiereVerificacion: true, email: emailNorm });
    } catch (err) {
      console.error(err);
      if (err.code === "ER_DUP_ENTRY") {
        // Alguien registró el mismo usuario/email justo en el mismo momento: limpiamos lo que quedó a medias.
        await pool.query("DELETE FROM empresas WHERE id = ?", [empresaId]).catch(() => {});
        return res.status(409).json({ error: "Ese nombre de usuario o email ya está en uso." });
      }
      if (empresaCreada) await pool.query("DELETE FROM empresas WHERE id = ?", [empresaId]).catch(() => {});
      res.status(500).json({ error: "No se pudo crear la empresa." });
    }
  }
);

// Confirmar el email con el código recibido: activa la cuenta y entra directo
app.post(
  "/api/empresas/verificar",
  limitar({ max: 8, ventanaMs: 15 * 60 * 1000, clave: (req) => "verif:" + textoClave(req, "email") }),
  async (req, res) => {
    try {
      const { email, codigo } = req.body || {};
      if (!emailValido(email) || !codigo) return res.status(400).json({ error: "Completá el email y el código." });
      const emailNorm = email.trim().toLowerCase();

      const [rows] = await pool.query("SELECT * FROM usuarios WHERE email = ?", [emailNorm]);
      if (rows.length === 0) return res.status(400).json({ error: "Código inválido o vencido." });
      const u = rows[0];

      const valido = await validarCodigo(u.id, codigo);
      if (valido.error) return res.status(400).json({ error: valido.error });

      if (!(await consumirCodigo(valido.registro.id))) return res.status(400).json({ error: "Código inválido o vencido." });
      await pool.query("UPDATE usuarios SET activo = TRUE WHERE id = ?", [u.id]);

      const empresa = await nombreDeEmpresa(u.empresa_id);
      res.json({ token: firmarToken(u), usuario: u.usuario, rol: u.rol, empresa });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "No se pudo confirmar la cuenta." });
    }
  }
);

// Pedir de nuevo el código de confirmación
app.post(
  "/api/empresas/reenviar",
  limitar({ max: 3, ventanaMs: 10 * 60 * 1000, clave: (req) => "reenv:" + textoClave(req, "email") }),
  async (req, res) => {
    try {
      const { email } = req.body || {};
      if (!emailValido(email)) return res.status(400).json({ error: "Ingresá un email válido." });
      const emailNorm = email.trim().toLowerCase();

      const [rows] = await pool.query("SELECT id, empresa_id FROM usuarios WHERE email = ? AND activo = FALSE", [emailNorm]);
      if (rows.length > 0) {
        await enviarCodigoPorMail(rows[0].id, emailNorm, rows[0].empresa_id, "verificacion");
      }
      res.json({ mensaje: "Si hay una cuenta pendiente de confirmar con ese email, te enviamos un código nuevo." });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "No pudimos enviar el mail. Probá de nuevo en unos minutos." });
    }
  }
);

// --- REGISTRO DE EMPLEADOS ---
// Autoregistro: solo funciona con el código de la empresa y si el documento coincide
// con una ficha de personal ya cargada por un administrador de esa empresa.

app.post(
  "/api/registro",
  limitar({ max: 20, ventanaMs: 60 * 60 * 1000 }),
  async (req, res) => {
    try {
      const { usuario, email, password, documento, codigoEmpresa } = req.body || {};

      if (!codigoEmpresa || !String(codigoEmpresa).trim()) return res.status(400).json({ error: "Ingresá el código de tu empresa." });
      if (!usuario || !usuario.trim()) return res.status(400).json({ error: "El nombre de usuario es obligatorio." });
      if (!emailValido(email)) return res.status(400).json({ error: "Ingresá un email válido." });
      if (!password || password.length < 6) return res.status(400).json({ error: "La contraseña debe tener al menos 6 caracteres." });
      if (!documento || !documento.trim()) return res.status(400).json({ error: "El documento es obligatorio." });

      const emailNorm = email.trim().toLowerCase();
      const usuarioNorm = usuario.trim();
      const documentoNorm = documento.trim();

      const [empresaRows] = await pool.query("SELECT id FROM empresas WHERE codigo = ?", [String(codigoEmpresa).trim().toUpperCase()]);
      if (empresaRows.length === 0) {
        return res.status(404).json({ error: "No encontramos esa empresa. Pedile el código a tu administrador." });
      }
      const empresaId = empresaRows[0].id;

      const [empRows] = await pool.query("SELECT id, nombre FROM empleados WHERE legajo = ? AND empresa_id = ?", [documentoNorm, empresaId]);
      if (empRows.length === 0) {
        return res.status(404).json({
          error: "No encontramos a nadie con ese documento en el personal registrado. Pedile a un administrador que te agregue primero.",
        });
      }
      const empleado = empRows[0];

      const [yaVinculado] = await pool.query("SELECT id FROM usuarios WHERE empleado_id = ?", [empleado.id]);
      if (yaVinculado.length > 0) {
        return res.status(409).json({ error: "Ese documento ya tiene una cuenta creada. Iniciá sesión en vez de registrarte." });
      }

      const [usuarioExiste] = await pool.query("SELECT id FROM usuarios WHERE usuario = ? OR email = ?", [usuarioNorm, emailNorm]);
      if (usuarioExiste.length > 0) {
        return res.status(409).json({ error: "Ese nombre de usuario o email ya está en uso." });
      }

      const hash = await bcrypt.hash(password, 10);
      await pool.query(
        "INSERT INTO usuarios (id, empresa_id, usuario, email, password_hash, rol, empleado_id) VALUES (?, ?, ?, ?, ?, 'empleado', ?)",
        [uid(), empresaId, usuarioNorm, emailNorm, hash, empleado.id]
      );

      res.status(201).json({ mensaje: `Cuenta creada para ${empleado.nombre}. Ya podés iniciar sesión.` });
    } catch (err) {
      console.error(err);
      if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "Ese nombre de usuario o email ya está en uso." });
      res.status(500).json({ error: "Error al registrar la cuenta" });
    }
  }
);

// --- RECUPERAR USUARIO / CONTRASEÑA (por email) ---

// Enviar por mail el nombre de usuario asociado a ese email
app.post(
  "/api/recuperar/usuario",
  limitar({ max: 5, ventanaMs: 15 * 60 * 1000, clave: (req) => "recu:" + textoClave(req, "email") }),
  async (req, res) => {
    try {
      const { email } = req.body || {};
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
      res.status(500).json({ error: "No se pudo procesar la solicitud. Probá de nuevo en unos minutos." });
    }
  }
);

// Paso 1 de recuperar contraseña: pedir un código y enviarlo por mail
app.post(
  "/api/recuperar/solicitar-codigo",
  limitar({ max: 5, ventanaMs: 15 * 60 * 1000, clave: (req) => "sol:" + textoClave(req, "email") }),
  async (req, res) => {
    try {
      const { email } = req.body || {};
      if (!email || !emailValido(email)) {
        return res.status(400).json({ error: "Ingresá un email válido." });
      }
      const emailNorm = email.trim().toLowerCase();

      const [rows] = await pool.query("SELECT id, empresa_id FROM usuarios WHERE email = ?", [emailNorm]);
      if (rows.length > 0) {
        await enviarCodigoPorMail(rows[0].id, emailNorm, rows[0].empresa_id, "recuperacion");
      }
      res.json({ mensaje: "Si ese email está registrado, te enviamos un código de verificación." });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "No se pudo procesar la solicitud. Probá de nuevo en unos minutos." });
    }
  }
);

// Paso 2 de recuperar contraseña: validar el código e ingresar la nueva contraseña
app.post(
  "/api/recuperar/confirmar",
  limitar({ max: 8, ventanaMs: 15 * 60 * 1000, clave: (req) => "conf:" + textoClave(req, "email") }),
  async (req, res) => {
    try {
      const { email, codigo, nuevaPassword } = req.body || {};
      if (!email || !codigo || !nuevaPassword) {
        return res.status(400).json({ error: "Completá todos los campos." });
      }
      if (nuevaPassword.length < 6 || nuevaPassword.length > 100) {
        return res.status(400).json({ error: "La nueva contraseña debe tener al menos 6 caracteres." });
      }
      const emailNorm = email.trim().toLowerCase();

      const [userRows] = await pool.query("SELECT id FROM usuarios WHERE email = ?", [emailNorm]);
      if (userRows.length === 0) {
        return res.status(400).json({ error: "Código inválido o vencido." });
      }
      const usuarioId = userRows[0].id;

      const valido = await validarCodigo(usuarioId, codigo);
      if (valido.error) return res.status(400).json({ error: valido.error });

      const hash = await bcrypt.hash(nuevaPassword, 10);
      if (!(await consumirCodigo(valido.registro.id))) return res.status(400).json({ error: "Código inválido o vencido." });
      // Tener el código prueba que el email es de la persona: también deja la cuenta activa.
      await pool.query("UPDATE usuarios SET password_hash = ?, activo = TRUE WHERE id = ?", [hash, usuarioId]);

      res.json({ mensaje: "Contraseña actualizada. Ya podés iniciar sesión." });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "No se pudo actualizar la contraseña." });
    }
  }
);

// --- LOGIN ---

app.post(
  "/api/login",
  limitar({ max: 10, ventanaMs: 15 * 60 * 1000, clave: (req) => "login:" + req.ip + ":" + textoClave(req, "usuario") }),
  async (req, res) => {
    try {
      const { usuario, password } = req.body || {};
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

      if (!usuarioDb.activo) {
        return res.status(403).json({
          error: "Tu cuenta todavía no está confirmada. Te pedimos el código que te enviamos por mail.",
          noVerificado: true,
          email: usuarioDb.email,
        });
      }

      const empresa = await nombreDeEmpresa(usuarioDb.empresa_id);
      res.json({ token: firmarToken(usuarioDb), usuario: usuarioDb.usuario, rol: usuarioDb.rol, empresa });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Error al iniciar sesión" });
    }
  }
);

// --- MIDDLEWARE: exige un token válido para todo lo que sigue ---

async function requiereLogin(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "No autenticado." });
  }

  let datos;
  try {
    datos = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: "Sesión inválida o vencida. Iniciá sesión de nuevo." });
  }
  // Sesiones anteriores a la versión multiempresa no traen empresa: que inicien sesión de nuevo.
  if (!datos.empresaId) {
    return res.status(401).json({ error: "Sesión inválida o vencida. Iniciá sesión de nuevo." });
  }

  // Confirmamos en la base que la cuenta siga existiendo y activa: si la eliminan, pierde el acceso enseguida.
  try {
    const [rows] = await pool.query("SELECT rol, activo, empresa_id, empleado_id FROM usuarios WHERE id = ?", [datos.id]);
    if (rows.length === 0 || !rows[0].activo || rows[0].empresa_id !== datos.empresaId) {
      return res.status(401).json({ error: "Sesión inválida o vencida. Iniciá sesión de nuevo." });
    }
    req.usuario = { ...datos, rol: rows[0].rol, empleadoId: rows[0].empleado_id };
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Error de conexión con la base de datos." });
  }
  next();
}

app.use("/api/empresa", requiereLogin);
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

// --- EMPRESA (datos de la empresa de quien inició sesión) ---

app.get("/api/empresa", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT nombre, codigo FROM empresas WHERE id = ?", [req.usuario.empresaId]);
    if (rows.length === 0) return res.status(404).json({ error: "Empresa no encontrada." });
    // El código para que los empleados se registren solo lo ven los administradores.
    res.json(req.usuario.rol === "admin" ? rows[0] : { nombre: rows[0].nombre });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener la empresa" });
  }
});

// --- USUARIOS (gestión de accesos, solo admin) ---

// Listar las cuentas de acceso de la empresa
app.get("/api/usuarios", requiereAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.usuario, u.email, u.rol, u.empleado_id AS empleadoId, u.activo,
              (u.password_hash IS NOT NULL) AS tienePassword,
              e.nombre AS empleadoNombre
         FROM usuarios u
         LEFT JOIN empleados e ON e.id = u.empleado_id
        WHERE u.empresa_id = ?
        ORDER BY u.creado_en DESC`,
      [req.usuario.empresaId]
    );
    res.json(rows.map((r) => ({ ...r, activo: !!r.activo, tienePassword: !!r.tienePassword })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener los usuarios" });
  }
});

// Crear una cuenta de acceso nueva, eligiendo el rol (el admin decide, no autoregistro)
app.post("/api/usuarios", requiereAdmin, async (req, res) => {
  try {
    const { usuario, email, rol, empleadoId } = req.body || {};
    const empresaId = req.usuario.empresaId;

    if (!usuario || !usuario.trim()) return res.status(400).json({ error: "El nombre de usuario es obligatorio." });
    if (!emailValido(email)) return res.status(400).json({ error: "Ingresá un email válido." });
    if (rol !== "admin" && rol !== "empleado") return res.status(400).json({ error: "El rol debe ser admin o empleado." });

    const usuarioNorm = usuario.trim();
    const emailNorm = email.trim().toLowerCase();

    let empleadoIdFinal = null;
    if (rol === "empleado") {
      if (!empleadoId) return res.status(400).json({ error: "Elegí a qué ficha de personal vincular esta cuenta." });
      const [empRows] = await pool.query("SELECT id FROM empleados WHERE id = ? AND empresa_id = ?", [empleadoId, empresaId]);
      if (empRows.length === 0) return res.status(404).json({ error: "Esa ficha de personal no existe." });
      const [yaVinculado] = await pool.query("SELECT id FROM usuarios WHERE empleado_id = ?", [empleadoId]);
      if (yaVinculado.length > 0) return res.status(409).json({ error: "Esa ficha ya tiene una cuenta de acceso." });
      empleadoIdFinal = empleadoId;
    }

    const [existe] = await pool.query("SELECT id FROM usuarios WHERE usuario = ? OR email = ?", [usuarioNorm, emailNorm]);
    if (existe.length > 0) return res.status(409).json({ error: "Ese nombre de usuario o email ya está en uso." });

    const id = uid();
    await pool.query(
      "INSERT INTO usuarios (id, empresa_id, usuario, email, password_hash, rol, empleado_id, activo) VALUES (?, ?, ?, ?, NULL, ?, ?, TRUE)",
      [id, empresaId, usuarioNorm, emailNorm, rol, empleadoIdFinal]
    );

    try {
      await enviarCodigoPorMail(id, emailNorm, empresaId, "bienvenida");
    } catch (mailErr) {
      console.error("La cuenta se creó pero no se pudo enviar el mail de bienvenida:", mailErr.message);
      return res.status(201).json({
        usuario: { id, usuario: usuarioNorm, email: emailNorm, rol, empleadoId: empleadoIdFinal },
        aviso: "La cuenta se creó, pero no se pudo enviar el mail de bienvenida. Podés definirle la contraseña vos con el botón \"Definir clave\", o pedirle que use \"Olvidé mi contraseña\" con su email.",
      });
    }

    res.status(201).json({ usuario: { id, usuario: usuarioNorm, email: emailNorm, rol, empleadoId: empleadoIdFinal } });
  } catch (err) {
    console.error(err);
    if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "Ese nombre de usuario o email ya está en uso." });
    res.status(500).json({ error: "Error al crear el usuario" });
  }
});

// Reenviar el mail de activación (por si no le llegó o venció el código)
app.post("/api/usuarios/:id/reenviar-activacion", requiereAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT id, email FROM usuarios WHERE id = ? AND empresa_id = ?", [req.params.id, req.usuario.empresaId]);
    if (rows.length === 0) return res.status(404).json({ error: "Usuario no encontrado." });
    await enviarCodigoPorMail(rows[0].id, rows[0].email, req.usuario.empresaId, "bienvenida");
    res.json({ mensaje: "Mail de activación reenviado." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo reenviar el mail. Podés definirle la contraseña con el botón \"Definir clave\"." });
  }
});

// Definir una contraseña a mano (sin mail): el administrador se la pasa a la persona
app.post("/api/usuarios/:id/password", requiereAdmin, async (req, res) => {
  try {
    const { password } = req.body || {};
    if (typeof password !== "string" || password.length < 6 || password.length > 100) {
      return res.status(400).json({ error: "La contraseña debe tener entre 6 y 100 caracteres." });
    }
    const [rows] = await pool.query("SELECT id FROM usuarios WHERE id = ? AND empresa_id = ?", [req.params.id, req.usuario.empresaId]);
    if (rows.length === 0) return res.status(404).json({ error: "Usuario no encontrado." });
    const hash = await bcrypt.hash(password, 10);
    await pool.query("UPDATE usuarios SET password_hash = ?, activo = TRUE WHERE id = ?", [hash, req.params.id]);
    res.json({ mensaje: "Contraseña definida. Pasásela a la persona." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo definir la contraseña." });
  }
});

// Eliminar una cuenta de acceso (no la ficha de personal, solo el login)
app.delete("/api/usuarios/:id", requiereAdmin, async (req, res) => {
  try {
    if (req.params.id === req.usuario.id) {
      return res.status(400).json({ error: "No podés eliminar tu propia cuenta desde acá." });
    }
    await pool.query("DELETE FROM usuarios WHERE id = ? AND empresa_id = ?", [req.params.id, req.usuario.empresaId]);
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
        "SELECT empleado_id AS empleadoId, hora_entrada AS horaEntrada, tolerancia_minutos AS toleranciaMinutos FROM turnos WHERE empleado_id = ? AND empresa_id = ?",
        [req.usuario.empleadoId, req.usuario.empresaId]
      );
    } else {
      [rows] = await pool.query(
        "SELECT empleado_id AS empleadoId, hora_entrada AS horaEntrada, tolerancia_minutos AS toleranciaMinutos FROM turnos WHERE empresa_id = ?",
        [req.usuario.empresaId]
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
    const { empleadoId, horaEntrada, toleranciaMinutos } = req.body || {};
    const empresaId = req.usuario.empresaId;
    if (!empleadoId || !horaEntrada) {
      return res.status(400).json({ error: "Faltan datos: empleado y hora de entrada son obligatorios." });
    }
    const tolerancia = Number.isFinite(Number(toleranciaMinutos)) ? Number(toleranciaMinutos) : 0;

    const [empRows] = await pool.query("SELECT id FROM empleados WHERE id = ? AND empresa_id = ?", [empleadoId, empresaId]);
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
        "INSERT INTO turnos (id, empresa_id, empleado_id, hora_entrada, tolerancia_minutos) VALUES (?, ?, ?, ?, ?)",
        [uid(), empresaId, empleadoId, horaEntrada, tolerancia]
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
    await pool.query("DELETE FROM turnos WHERE empleado_id = ? AND empresa_id = ?", [req.params.empleadoId, req.usuario.empresaId]);
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al eliminar el turno" });
  }
});

// --- EMPLEADOS ---

// Obtener los empleados de la empresa
app.get("/api/empleados", async (req, res) => {
  try {
    let rows;
    if (req.usuario.rol === "empleado") {
      if (!req.usuario.empleadoId) {
        return res.json([]);
      }
      [rows] = await pool.query(
        "SELECT id, nombre, legajo, area, dentro FROM empleados WHERE id = ? AND empresa_id = ?",
        [req.usuario.empleadoId, req.usuario.empresaId]
      );
    } else {
      [rows] = await pool.query(
        "SELECT id, nombre, legajo, area, dentro FROM empleados WHERE empresa_id = ? ORDER BY nombre",
        [req.usuario.empresaId]
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
    const { nombre, legajo, area } = req.body || {};
    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ error: "El nombre es obligatorio." });
    }
    if (!legajo || !legajo.trim()) {
      return res.status(400).json({ error: "El legajo o DNI es obligatorio." });
    }

    const [existentes] = await pool.query(
      "SELECT id FROM empleados WHERE legajo = ? AND empresa_id = ?",
      [legajo.trim(), req.usuario.empresaId]
    );
    if (existentes.length > 0) {
      return res.status(409).json({ error: "Ya existe un empleado con ese legajo o DNI." });
    }

    const id = uid();
    const areaFinal = (area || "").trim() || "Sin área";
    await pool.query(
      "INSERT INTO empleados (id, empresa_id, nombre, legajo, area, dentro) VALUES (?, ?, ?, ?, ?, FALSE)",
      [id, req.usuario.empresaId, nombre.trim(), legajo.trim(), areaFinal]
    );
    res.status(201).json({ id, nombre: nombre.trim(), legajo: legajo.trim(), area: areaFinal, dentro: false });
  } catch (err) {
    console.error(err);
    if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "Ya existe un empleado con ese legajo o DNI." });
    res.status(500).json({ error: "Error al crear empleado" });
  }
});

// Eliminar un empleado
app.delete("/api/empleados/:id", requiereAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM empleados WHERE id = ? AND empresa_id = ?", [req.params.id, req.usuario.empresaId]);
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al eliminar empleado" });
  }
});

// --- MOVIMIENTOS: utilidades ---

// Calcula si un ingreso en la fecha dada es tarde, según el turno del empleado
// Fecha y hora "de pared" en la zona horaria del negocio (no depende de la zona del servidor)
const formateadorZona = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZONA_HORARIA, hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});

function partesEnZona(fecha) {
  const p = {};
  formateadorZona.formatToParts(fecha).forEach((x) => { p[x.type] = Number(x.value); });
  return p;
}

// Diferencia (en ms) entre la hora de pared de la zona y UTC en ese instante
function desfaseZonaMs(fecha) {
  const p = partesEnZona(fecha);
  const comoUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return comoUTC - Math.floor(fecha.getTime() / 1000) * 1000;
}

// Convierte "YYYY-MM-DDTHH:mm" (hora de pared del negocio) en el instante real; null si no existe
function fechaLocalAInstante(texto) {
  const m = texto.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/);
  if (!m) return null;
  const [anio, mes, dia, hora, min] = m.slice(1).map(Number);
  const supuesto = Date.UTC(anio, mes - 1, dia, hora, min);
  let instante = supuesto - desfaseZonaMs(new Date(supuesto));
  instante = supuesto - desfaseZonaMs(new Date(instante));
  const fecha = new Date(instante);
  const p = partesEnZona(fecha);
  if (p.year !== anio || p.month !== mes || p.day !== dia || p.hour !== hora || p.minute !== min) return null;
  return fecha;
}

// Calcula si un ingreso en la fecha dada es tarde, según el turno del empleado
// Solo cuenta el PRIMER ingreso del día: quien vuelve de almorzar no llega "tarde".
async function calcularTarde(conn, empleadoId, fecha, excluirId = "") {
  const [turnoRows] = await conn.query("SELECT * FROM turnos WHERE empleado_id = ?", [empleadoId]);
  if (turnoRows.length === 0) return { llegoTarde: false, minutosTarde: null };
  const turno = turnoRows[0];
  const [h, m, s] = String(turno.hora_entrada).split(":").map(Number);
  const p = partesEnZona(fecha);

  const dos = (n) => String(n).padStart(2, "0");
  const diaLocal = `${p.year}-${dos(p.month)}-${dos(p.day)}`;
  const [previos] = await conn.query(
    "SELECT 1 FROM movimientos WHERE empleado_id = ? AND tipo = 'ingreso' AND DATE(fecha_hora) = ? AND fecha_hora < ? AND id <> ? LIMIT 1",
    [empleadoId, diaLocal, fecha, excluirId]
  );
  if (previos.length > 0) return { llegoTarde: false, minutosTarde: null };

  const segundosDelDia = p.hour * 3600 + p.minute * 60 + p.second;
  const limite = h * 3600 + m * 60 + (s || 0) + Number(turno.tolerancia_minutos || 0) * 60;
  if (segundosDelDia > limite) {
    return { llegoTarde: true, minutosTarde: Math.round((segundosDelDia - limite) / 60) };
  }
  return { llegoTarde: false, minutosTarde: null };
}

// Interpreta la fecha/hora que manda el administrador y valida que sea razonable.
// Acepta un instante con zona ("2026-10-17T11:30:00.000Z") o una hora de pared ("2026-10-17T08:30").
function parsearFechaHora(valor) {
  if (typeof valor !== "string") return null;
  let f;
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(valor)) f = new Date(valor);
  else f = fechaLocalAInstante(valor);
  if (!f || isNaN(f.getTime())) return null;
  if (f.getTime() > Date.now() + 5 * 60 * 1000) return null; // no se permiten horas futuras
  if (f.getTime() < Date.now() - 400 * 24 * 60 * 60 * 1000) return null; // ni de hace más de ~13 meses
  return f;
}

// Lee de la base lo que realmente quedó guardado de un movimiento
async function leerMovimientoGuardado(conn, id) {
  const [r] = await conn.query("SELECT fecha_hora, llego_tarde, minutos_tarde FROM movimientos WHERE id = ?", [id]);
  if (r.length === 0) return null;
  return {
    timestamp: new Date(r[0].fecha_hora).toISOString(),
    llegoTarde: !!r[0].llego_tarde,
    minutosTarde: r[0].minutos_tarde,
  };
}

// Deja el estado "dentro" del empleado según su último movimiento
async function recalcularDentro(conn, empleadoId) {
  const [ult] = await conn.query(
    "SELECT tipo FROM movimientos WHERE empleado_id = ? ORDER BY fecha_hora DESC LIMIT 1",
    [empleadoId]
  );
  const dentro = ult.length > 0 && ult[0].tipo === "ingreso";
  await conn.query("UPDATE empleados SET dentro = ? WHERE id = ?", [dentro, empleadoId]);
  return dentro;
}

// Arma el WHERE de las consultas de historial: siempre limitado a la empresa,
// y a la persona misma si quien consulta es un empleado.
function filtroMovimientos(req) {
  const condiciones = ["empresa_id = ?"];
  const params = [req.usuario.empresaId];
  if (req.usuario.rol === "empleado") {
    condiciones.push("empleado_id = ?");
    params.push(req.usuario.empleadoId);
  }
  const { fecha } = req.query;
  const hayFecha = typeof fecha === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fecha);
  if (hayFecha) {
    condiciones.push("DATE(fecha_hora) = ?");
    params.push(fecha);
  }
  return { where: condiciones.join(" AND "), params, hayFecha, fecha: hayFecha ? fecha : null };
}

// Marcar ingreso/egreso (toggle) y registrar el movimiento
app.post("/api/empleados/:id/marcar", async (req, res) => {
  if (req.usuario.rol === "empleado" && req.usuario.empleadoId !== req.params.id) {
    return res.status(403).json({ error: "Solo podés marcar tu propio ingreso o egreso." });
  }
  const conn = await pool.getConnection();
  try {
    // Transacción con bloqueo de la ficha: dos toques seguidos no pueden crear dos ingresos.
    await conn.beginTransaction();
    const [rows] = await conn.query("SELECT * FROM empleados WHERE id = ? AND empresa_id = ? FOR UPDATE", [req.params.id, req.usuario.empresaId]);
    if (rows.length === 0) {
      await conn.rollback();
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
      // Solo se acepta una hora pasada (hasta 24 h atrás, por si estuvo sin conexión). Nunca una futura.
      const atras = Date.now() - propuesta.getTime();
      if (!isNaN(propuesta.getTime()) && atras > -60 * 1000 && atras < margenMs) {
        ahora = propuesta;
      }
    }

    const fotoGuardar = validarFoto(foto);
    // Number(null) da 0, así que primero verificamos que realmente venga un valor
    const coordenadaValida = (v, max) =>
      v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) && Math.abs(Number(v)) <= max;
    let lat = coordenadaValida(latitud, 90) ? Number(latitud) : null;
    let lng = coordenadaValida(longitud, 180) ? Number(longitud) : null;
    if (lat === null || lng === null || (lat === 0 && lng === 0)) { lat = null; lng = null; }

    let llegoTarde = false;
    let minutosTarde = null;
    if (tipo === "ingreso") {
      ({ llegoTarde, minutosTarde } = await calcularTarde(conn, empleado.id, ahora));
    }

    await conn.query("UPDATE empleados SET dentro = ? WHERE id = ?", [nuevoEstado, empleado.id]);
    const movId = uid();
    await conn.query(
      "INSERT INTO movimientos (id, empresa_id, empleado_id, nombre, legajo, area, tipo, fecha_hora, llego_tarde, minutos_tarde, foto, latitud, longitud) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [movId, req.usuario.empresaId, empleado.id, empleado.nombre, empleado.legajo, empleado.area, tipo, ahora, llegoTarde, minutosTarde, fotoGuardar, lat, lng]
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
    await conn.rollback().catch(() => {});
    console.error(err);
    res.status(500).json({ error: "Error al registrar el movimiento" });
  } finally {
    conn.release();
  }
});

// --- MOVIMIENTOS ---

// Cargar a mano un ingreso/egreso olvidado (solo admin)
app.post("/api/movimientos/manual", requiereAdmin, async (req, res) => {
  const { empleadoId, tipo, fechaHora } = req.body || {};
  if (!empleadoId) return res.status(400).json({ error: "Elegí a la persona." });
  if (tipo !== "ingreso" && tipo !== "egreso") return res.status(400).json({ error: "El tipo debe ser ingreso o egreso." });
  const fecha = parsearFechaHora(fechaHora);
  if (!fecha) return res.status(400).json({ error: "Ingresá una fecha y hora válidas (no pueden ser futuras)." });

  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query("SELECT * FROM empleados WHERE id = ? AND empresa_id = ?", [empleadoId, req.usuario.empresaId]);
    if (rows.length === 0) return res.status(404).json({ error: "Empleado no encontrado." });
    const emp = rows[0];

    let llegoTarde = false;
    let minutosTarde = null;
    if (tipo === "ingreso") {
      ({ llegoTarde, minutosTarde } = await calcularTarde(conn, emp.id, fecha));
    }

    await conn.beginTransaction();
    const movId = uid();
    await conn.query(
      "INSERT INTO movimientos (id, empresa_id, empleado_id, nombre, legajo, area, tipo, fecha_hora, llego_tarde, minutos_tarde, foto, latitud, longitud) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)",
      [movId, req.usuario.empresaId, emp.id, emp.nombre, emp.legajo, emp.area, tipo, fecha, llegoTarde, minutosTarde]
    );
    const dentro = await recalcularDentro(conn, emp.id);
    await conn.commit();

    const guardado = (await leerMovimientoGuardado(conn, movId)) || { timestamp: fecha.toISOString(), llegoTarde, minutosTarde };

    res.status(201).json({
      empleado: { id: emp.id, nombre: emp.nombre, legajo: emp.legajo, area: emp.area, dentro },
      movimiento: {
        id: movId, empleadoId: emp.id, nombre: emp.nombre, legajo: emp.legajo, area: emp.area, tipo,
        timestamp: guardado.timestamp, llegoTarde: guardado.llegoTarde, minutosTarde: guardado.minutosTarde,
        foto: null, latitud: null, longitud: null,
      },
    });
  } catch (err) {
    await conn.rollback().catch(() => {});
    console.error(err);
    res.status(500).json({ error: "No se pudo cargar el fichaje." });
  } finally {
    conn.release();
  }
});

// Cambiar la fecha/hora de un movimiento ya registrado (solo admin)
app.put("/api/movimientos/:id", requiereAdmin, async (req, res) => {
  const fecha = parsearFechaHora((req.body || {}).fechaHora);
  if (!fecha) return res.status(400).json({ error: "Ingresá una fecha y hora válidas (no pueden ser futuras)." });

  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query("SELECT * FROM movimientos WHERE id = ? AND empresa_id = ?", [req.params.id, req.usuario.empresaId]);
    if (rows.length === 0) return res.status(404).json({ error: "Movimiento no encontrado." });
    const mov = rows[0];

    let llegoTarde = false;
    let minutosTarde = null;
    if (mov.tipo === "ingreso") {
      ({ llegoTarde, minutosTarde } = await calcularTarde(conn, mov.empleado_id, fecha, mov.id));
    }

    await conn.beginTransaction();
    await conn.query(
      "UPDATE movimientos SET fecha_hora = ?, llego_tarde = ?, minutos_tarde = ? WHERE id = ? AND empresa_id = ?",
      [fecha, llegoTarde, minutosTarde, mov.id, req.usuario.empresaId]
    );
    const dentro = await recalcularDentro(conn, mov.empleado_id);
    await conn.commit();

    // Devolvemos lo que realmente quedó guardado en la base, así la pantalla muestra la verdad.
    const guardado = (await leerMovimientoGuardado(conn, mov.id)) || { timestamp: fecha.toISOString(), llegoTarde, minutosTarde };
    console.log("Horario editado:", mov.id, "pedido:", fecha.toISOString(), "guardado:", guardado.timestamp);

    res.json({
      empleadoId: mov.empleado_id,
      dentro,
      movimiento: { id: mov.id, timestamp: guardado.timestamp, llegoTarde: guardado.llegoTarde, minutosTarde: guardado.minutosTarde },
    });
  } catch (err) {
    await conn.rollback().catch(() => {});
    console.error(err);
    res.status(500).json({ error: "No se pudo cambiar el horario." });
  } finally {
    conn.release();
  }
});

// Exportar historial a Excel (.xlsx) — respeta el mismo filtro de fecha
// y las mismas restricciones de un usuario "empleado" que el resto del historial.
app.get("/api/movimientos/exportar", async (req, res) => {
  try {
    if (req.usuario.rol === "empleado" && !req.usuario.empleadoId) {
      return res.status(403).json({ error: "No hay nada para exportar." });
    }
    const { where, params, fecha } = filtroMovimientos(req);

    const [rows] = await pool.query(
      `SELECT nombre, legajo, area, tipo, fecha_hora, llego_tarde, minutos_tarde, latitud, longitud
         FROM movimientos WHERE ${where} ORDER BY fecha_hora ASC`,
      params
    );

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
    if (req.usuario.rol === "empleado" && !req.usuario.empleadoId) {
      return res.json([]);
    }
    const { where, params, hayFecha } = filtroMovimientos(req);

    const [rows] = await pool.query(
      `SELECT id, empleado_id AS empleadoId, nombre, legajo, area, tipo, fecha_hora AS timestamp,
              llego_tarde AS llegoTarde, minutos_tarde AS minutosTarde, foto, latitud, longitud
         FROM movimientos WHERE ${where} ORDER BY fecha_hora DESC${hayFecha ? "" : " LIMIT 50"}`,
      params
    );
    res.json(rows.map((r) => ({ ...r, llegoTarde: !!r.llegoTarde })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener el historial" });
  }
});

// --- PANEL DE LA PLATAFORMA (solo para quien vende la app) ---
// Se activa cargando la variable PLATAFORMA_CLAVE en Railway. Sin esa variable, no existe.
// Muestra las empresas registradas y su actividad, nunca los datos de las personas.

function clavePlataformaValida(clave) {
  const esperada = process.env.PLATAFORMA_CLAVE;
  if (!esperada || esperada.length < 12 || typeof clave !== "string") return false;
  const a = crypto.createHash("sha256").update(clave).digest();
  const b = crypto.createHash("sha256").update(esperada).digest();
  return crypto.timingSafeEqual(a, b);
}

app.post(
  "/api/plataforma/empresas",
  limitar({ max: 10, ventanaMs: 15 * 60 * 1000 }),
  async (req, res) => {
    if (!process.env.PLATAFORMA_CLAVE) return res.status(404).json({ error: "No encontrado." });
    if (!clavePlataformaValida((req.body || {}).clave)) return res.status(401).json({ error: "Clave incorrecta." });
    try {
      const [rows] = await pool.query(
        `SELECT e.id, e.nombre, e.codigo, e.creado_en,
                (SELECT COUNT(*) FROM empleados x WHERE x.empresa_id = e.id) AS empleados,
                (SELECT COUNT(*) FROM usuarios u WHERE u.empresa_id = e.id) AS cuentas,
                (SELECT GROUP_CONCAT(u.email SEPARATOR ', ') FROM usuarios u WHERE u.empresa_id = e.id AND u.rol = 'admin') AS admins,
                (SELECT MAX(m.fecha_hora) FROM movimientos m WHERE m.empresa_id = e.id) AS ultimoMovimiento,
                (SELECT COUNT(*) FROM movimientos m WHERE m.empresa_id = e.id AND m.fecha_hora >= (NOW() - INTERVAL 30 DAY)) AS movimientos30d
           FROM empresas e
          ORDER BY e.creado_en DESC`
      );
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "No se pudo obtener la lista." });
    }
  }
);

const PORT = process.env.PORT || 3000;

async function iniciar() {
  // Si la base todavía está arrancando, reintentamos. Si no se logra, frenamos: es mejor no levantar
  // la app que levantarla con la base a medio preparar.
  let listo = false;
  for (let intento = 1; intento <= 6 && !listo; intento++) {
    try {
      await asegurarEsquema(pool);
      listo = true;
      console.log("Base de datos lista.");
    } catch (err) {
      console.error(`No se pudo preparar la base de datos (intento ${intento} de 6):`, err.message);
      if (intento < 6) await new Promise((r) => setTimeout(r, 5000));
    }
  }
  if (!listo) {
    console.error("La base de datos no quedó lista. Se detiene el servidor.");
    process.exit(1);
  }
  app.listen(PORT, () => {
    console.log(`Servidor de Control de Acceso corriendo en http://localhost:${PORT}`);
  });
}

iniciar();
