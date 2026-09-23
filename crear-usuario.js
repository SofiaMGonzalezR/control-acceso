// Script para crear (o actualizar) un usuario que pueda iniciar sesión en la app.
// Se corre desde la consola: node crear-usuario.js
// Pide usuario, contraseña, rol (admin o empleado), y si es "empleado" pide el
// legajo para vincularlo con su propia ficha de personal.

require("dotenv").config();
const readline = require("readline");
const bcrypt = require("bcrypt");
const mysql = require("mysql2/promise");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function pregunta(texto) {
  return new Promise((resolve) => rl.question(texto, resolve));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

async function main() {
  console.log("=== Crear / actualizar usuario de acceso a la app ===");
  const usuario = (await pregunta("Nombre de usuario: ")).trim();
  const email = (await pregunta("Email: ")).trim().toLowerCase();
  const password = (await pregunta("Contraseña: ")).trim();
  let rol = (await pregunta("Rol (admin / empleado) [empleado]: ")).trim().toLowerCase();

  if (rol !== "admin" && rol !== "empleado") {
    if (rol === "") {
      rol = "empleado";
    } else {
      console.error("El rol debe ser 'admin' o 'empleado'.");
      rl.close();
      process.exit(1);
    }
  }

  const pool = mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "control_accesos",
  });

  let empleadoId = null;

  if (rol === "empleado") {
    const legajo = (await pregunta("Legajo o DNI de la persona a vincular (debe existir en 'Agregar persona' de la app): ")).trim();
    const [empRows] = await pool.query("SELECT id, nombre FROM empleados WHERE legajo = ?", [legajo]);
    if (empRows.length === 0) {
      console.error(`No encontré ningún empleado con legajo "${legajo}". Agregalo primero desde la app (como admin) y volvé a correr este script.`);
      rl.close();
      await pool.end();
      process.exit(1);
    }
    empleadoId = empRows[0].id;
    console.log(`Vinculando este usuario con: ${empRows[0].nombre}`);
  }

  rl.close();

  if (!usuario || !password) {
    console.error("El usuario y la contraseña no pueden estar vacíos.");
    await pool.end();
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 10);

  const [existentes] = await pool.query("SELECT id FROM usuarios WHERE usuario = ?", [usuario]);

  if (existentes.length > 0) {
    await pool.query(
      "UPDATE usuarios SET password_hash = ?, email = ?, rol = ?, empleado_id = ? WHERE usuario = ?",
      [hash, email, rol, empleadoId, usuario]
    );
    console.log(`Usuario "${usuario}" actualizado (rol: ${rol}).`);
  } else {
    await pool.query(
      "INSERT INTO usuarios (id, usuario, email, password_hash, rol, empleado_id) VALUES (?, ?, ?, ?, ?, ?)",
      [uid(), usuario, email, hash, rol, empleadoId]
    );
    console.log(`Usuario "${usuario}" creado correctamente (rol: ${rol}).`);
  }

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
