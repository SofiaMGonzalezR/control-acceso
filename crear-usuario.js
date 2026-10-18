// Herramienta de administración para crear empresas y cuentas desde la consola.
// Se corre con: node crear-usuario.js
// Sirve, por ejemplo, para dar de alta a mano a un cliente nuevo y a su administrador.
// (Los clientes también pueden crear su propia empresa desde la pantalla "Crear empresa" de la app.)

require("dotenv").config();
const readline = require("readline");
const bcrypt = require("bcrypt");
const mysql = require("mysql2/promise");
const { asegurarEsquema, generarCodigoEmpresa, uid } = require("./esquema");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function pregunta(texto) {
  return new Promise((resolve) => rl.question(texto, resolve));
}

async function salir(pool, codigo, mensaje) {
  if (mensaje) console.error(mensaje);
  rl.close();
  if (pool) await pool.end();
  process.exit(codigo);
}

async function main() {
  console.log("=== Crear empresa / cuenta de acceso ===");

  const pool = mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "control_accesos",
  });

  await asegurarEsquema(pool);

  const [empresas] = await pool.query("SELECT id, nombre, codigo FROM empresas ORDER BY creado_en");
  if (empresas.length > 0) {
    console.log("\nEmpresas existentes:");
    empresas.forEach((e) => console.log(`  ${e.codigo}  ${e.nombre}`));
  }

  const codigoIngresado = (await pregunta("\nCódigo de la empresa (dejalo vacío para crear una empresa nueva): ")).trim().toUpperCase();

  let empresa;
  if (codigoIngresado) {
    empresa = empresas.find((e) => e.codigo === codigoIngresado);
    if (!empresa) return salir(pool, 1, `No existe ninguna empresa con el código "${codigoIngresado}".`);
  } else {
    const nombreEmpresa = (await pregunta("Nombre de la empresa nueva: ")).trim();
    if (!nombreEmpresa) return salir(pool, 1, "El nombre de la empresa no puede estar vacío.");
    // Se crea recién al final, cuando ya se validó todo lo demás (así no quedan empresas sueltas).
    empresa = { id: uid(), nombre: nombreEmpresa, codigo: generarCodigoEmpresa(), nueva: true };
  }

  const usuario = (await pregunta("Nombre de usuario: ")).trim();
  const email = (await pregunta("Email: ")).trim().toLowerCase();
  const password = (await pregunta("Contraseña: ")).trim();
  let rol = (await pregunta("Rol (admin / empleado) [admin]: ")).trim().toLowerCase() || "admin";
  if (rol !== "admin" && rol !== "empleado") return salir(pool, 1, "El rol debe ser 'admin' o 'empleado'.");

  let empleadoId = null;
  if (rol === "empleado") {
    const legajo = (await pregunta("Legajo o DNI de la persona a vincular (debe existir en 'Agregar persona' de la app): ")).trim();
    const [empRows] = await pool.query("SELECT id, nombre FROM empleados WHERE legajo = ? AND empresa_id = ?", [legajo, empresa.id]);
    if (empRows.length === 0) {
      return salir(pool, 1, `No encontré ningún empleado con legajo "${legajo}" en ${empresa.nombre}. Agregalo primero desde la app (como admin) y volvé a correr este script.`);
    }
    empleadoId = empRows[0].id;
    console.log(`Vinculando este usuario con: ${empRows[0].nombre}`);
  }

  if (!usuario || !email || !password) return salir(pool, 1, "El usuario, el email y la contraseña no pueden estar vacíos.");
  if (password.length < 6) return salir(pool, 1, "La contraseña debe tener al menos 6 caracteres.");

  const hash = await bcrypt.hash(password, 10);
  const [existentes] = await pool.query("SELECT id, empresa_id FROM usuarios WHERE usuario = ?", [usuario]);
  const [emailUsado] = await pool.query("SELECT id, usuario FROM usuarios WHERE email = ? AND usuario <> ?", [email, usuario]);
  if (emailUsado.length > 0) {
    return salir(pool, 1, `El email "${email}" ya lo usa otra cuenta ("${emailUsado[0].usuario}"). Elegí otro.`);
  }

  if (empresa.nueva) {
    if (existentes.length > 0) {
      return salir(pool, 1, `El usuario "${usuario}" ya existe en otra empresa. Elegí otro nombre de usuario.`);
    }
    await pool.query("INSERT INTO empresas (id, nombre, codigo) VALUES (?, ?, ?)", [empresa.id, empresa.nombre, empresa.codigo]);
    console.log(`Empresa "${empresa.nombre}" creada. Su código es: ${empresa.codigo}`);
  }

  if (existentes.length > 0) {
    if (existentes[0].empresa_id !== empresa.id) {
      return salir(pool, 1, `El usuario "${usuario}" ya existe en otra empresa. Elegí otro nombre de usuario.`);
    }
    await pool.query(
      "UPDATE usuarios SET password_hash = ?, email = ?, rol = ?, empleado_id = ?, activo = TRUE WHERE usuario = ?",
      [hash, email, rol, empleadoId, usuario]
    );
    console.log(`Usuario "${usuario}" actualizado (rol: ${rol}).`);
  } else {
    await pool.query(
      "INSERT INTO usuarios (id, empresa_id, usuario, email, password_hash, rol, empleado_id, activo) VALUES (?, ?, ?, ?, ?, ?, ?, TRUE)",
      [uid(), empresa.id, usuario, email, hash, rol, empleadoId]
    );
    console.log(`Usuario "${usuario}" creado en "${empresa.nombre}" (rol: ${rol}).`);
  }

  console.log(`\nCódigo de la empresa (para que sus empleados se registren): ${empresa.codigo}`);
  await salir(pool, 0);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
