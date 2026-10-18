// Prepara la base de datos al arrancar el servidor.
// - En una base nueva: crea todas las tablas (ya con soporte para varias empresas).
// - En una base que ya tenía datos (versión de una sola empresa): agrega lo que falta
//   y pasa todos los datos existentes a una empresa inicial, sin perder nada.
// Se puede ejecutar todas las veces que haga falta: no repite cambios ya hechos.

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Código corto que los empleados usan para registrarse en SU empresa.
// Sin letras/números que se confundan (0/O, 1/I).
function generarCodigoEmpresa() {
  const letras = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let codigo = "";
  for (let i = 0; i < 6; i++) codigo += letras[Math.floor(Math.random() * letras.length)];
  return codigo;
}

async function columnaExiste(pool, tabla, columna) {
  const [r] = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?",
    [tabla, columna]
  );
  return r.length > 0;
}

async function columnaAceptaNull(pool, tabla, columna) {
  const [r] = await pool.query(
    "SELECT is_nullable AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?",
    [tabla, columna]
  );
  return r.length > 0 && String(r[0].n).toUpperCase() === "YES";
}

async function asegurarEsquema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS empresas (
      id VARCHAR(20) PRIMARY KEY,
      nombre VARCHAR(100) NOT NULL,
      codigo VARCHAR(10) NOT NULL UNIQUE,
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS empleados (
      id VARCHAR(20) PRIMARY KEY,
      empresa_id VARCHAR(20) NOT NULL,
      nombre VARCHAR(150) NOT NULL,
      legajo VARCHAR(50) NOT NULL,
      area VARCHAR(100) NOT NULL DEFAULT 'Sin área',
      dentro BOOLEAN NOT NULL DEFAULT FALSE,
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_empresa_legajo (empresa_id, legajo),
      INDEX idx_empresa (empresa_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS movimientos (
      id VARCHAR(20) PRIMARY KEY,
      empresa_id VARCHAR(20) NOT NULL,
      empleado_id VARCHAR(20) NOT NULL,
      nombre VARCHAR(150) NOT NULL,
      legajo VARCHAR(50) NOT NULL,
      area VARCHAR(100) NOT NULL,
      tipo ENUM('ingreso', 'egreso') NOT NULL,
      fecha_hora TIMESTAMP NOT NULL,
      llego_tarde BOOLEAN NOT NULL DEFAULT FALSE,
      minutos_tarde INT NULL,
      foto LONGTEXT NULL,
      latitud DECIMAL(10,7) NULL,
      longitud DECIMAL(10,7) NULL,
      FOREIGN KEY (empleado_id) REFERENCES empleados(id) ON DELETE CASCADE,
      INDEX idx_fecha_hora (fecha_hora),
      INDEX idx_empleado (empleado_id),
      INDEX idx_empresa (empresa_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id VARCHAR(20) PRIMARY KEY,
      empresa_id VARCHAR(20) NOT NULL,
      usuario VARCHAR(50) NOT NULL UNIQUE,
      email VARCHAR(150) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NULL,
      rol ENUM('admin', 'empleado') NOT NULL DEFAULT 'empleado',
      empleado_id VARCHAR(20) NULL,
      activo BOOLEAN NOT NULL DEFAULT TRUE,
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (empleado_id) REFERENCES empleados(id) ON DELETE SET NULL,
      INDEX idx_empresa (empresa_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS turnos (
      id VARCHAR(20) PRIMARY KEY,
      empresa_id VARCHAR(20) NOT NULL,
      empleado_id VARCHAR(20) NOT NULL UNIQUE,
      hora_entrada TIME NOT NULL,
      tolerancia_minutos INT NOT NULL DEFAULT 0,
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (empleado_id) REFERENCES empleados(id) ON DELETE CASCADE,
      INDEX idx_empresa (empresa_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS codigos_recuperacion (
      id VARCHAR(20) PRIMARY KEY,
      usuario_id VARCHAR(20) NOT NULL,
      codigo VARCHAR(10) NOT NULL,
      expira_en DATETIME NOT NULL,
      usado BOOLEAN NOT NULL DEFAULT FALSE,
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
    )
  `);

  // --- Bases que ya existían (una sola empresa): agregar empresa_id y migrar los datos ---
  const tablas = ["empleados", "usuarios", "turnos", "movimientos"];
  for (const tabla of tablas) {
    if (!(await columnaExiste(pool, tabla, "empresa_id"))) {
      await pool.query(`ALTER TABLE ${tabla} ADD COLUMN empresa_id VARCHAR(20) NULL`);
      await pool.query(`ALTER TABLE ${tabla} ADD INDEX idx_empresa (empresa_id)`);
    }
  }

  let hayHuerfanos = false;
  for (const tabla of tablas) {
    const [r] = await pool.query(`SELECT 1 FROM ${tabla} WHERE empresa_id IS NULL LIMIT 1`);
    if (r.length > 0) hayHuerfanos = true;
  }

  if (hayHuerfanos) {
    let [emp] = await pool.query("SELECT id FROM empresas ORDER BY creado_en LIMIT 1");
    let empresaId;
    if (emp.length > 0) {
      empresaId = emp[0].id;
    } else {
      empresaId = uid();
      await pool.query("INSERT INTO empresas (id, nombre, codigo) VALUES (?, ?, ?)", [
        empresaId,
        process.env.EMPRESA_INICIAL || "Mi empresa",
        generarCodigoEmpresa(),
      ]);
    }
    for (const tabla of tablas) {
      await pool.query(`UPDATE ${tabla} SET empresa_id = ? WHERE empresa_id IS NULL`, [empresaId]);
    }
    console.log("Se migraron los datos existentes a la empresa inicial.");
  }

  for (const tabla of tablas) {
    if (await columnaAceptaNull(pool, tabla, "empresa_id")) {
      await pool.query(`ALTER TABLE ${tabla} MODIFY COLUMN empresa_id VARCHAR(20) NOT NULL`);
    }
  }

  // El legajo/DNI pasa a ser único dentro de cada empresa (antes era único en toda la base).
  const [indices] = await pool.query(
    `SELECT index_name AS nombre, column_name AS columna
       FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = 'empleados'
        AND non_unique = 0 AND index_name <> 'PRIMARY'
      ORDER BY index_name, seq_in_index`
  );
  const porIndice = {};
  for (const i of indices) {
    (porIndice[i.nombre] = porIndice[i.nombre] || []).push(i.columna);
  }
  for (const nombre of Object.keys(porIndice)) {
    const cols = porIndice[nombre];
    if (cols.length === 1 && cols[0] === "legajo") {
      await pool.query(`ALTER TABLE empleados DROP INDEX \`${nombre}\``);
    }
  }
  if (!porIndice["uq_empresa_legajo"]) {
    await pool.query("ALTER TABLE empleados ADD UNIQUE KEY uq_empresa_legajo (empresa_id, legajo)");
  }

  // Una ficha de personal no puede tener dos cuentas (ni siquiera si dos registros llegan a la vez).
  // Si ya hubiera cuentas duplicadas de antes, se saltea este paso en vez de frenar el arranque.
  try {
    const [uq] = await pool.query(
      `SELECT 1 FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name = 'usuarios' AND index_name = 'uq_usuario_empleado' LIMIT 1`
    );
    if (uq.length === 0) {
      const [dup] = await pool.query(
        "SELECT empleado_id FROM usuarios WHERE empleado_id IS NOT NULL GROUP BY empleado_id HAVING COUNT(*) > 1 LIMIT 1"
      );
      if (dup.length === 0) {
        await pool.query("ALTER TABLE usuarios ADD UNIQUE KEY uq_usuario_empleado (empleado_id)");
      } else {
        console.warn("AVISO: hay fichas con más de una cuenta; no se pudo agregar la restricción de unicidad.");
      }
    }
  } catch (e) {
    console.warn("AVISO: no se pudo agregar la restricción de una cuenta por ficha:", e.message);
  }

  // Vista para Power BI: incluye la empresa para poder separar por cliente.
  await pool.query(`
    CREATE OR REPLACE VIEW vista_movimientos AS
    SELECT
      m.id,
      m.empresa_id,
      e.nombre AS empresa,
      m.empleado_id,
      m.nombre,
      m.legajo,
      m.area,
      m.tipo,
      m.fecha_hora,
      DATE(m.fecha_hora) AS fecha,
      TIME(m.fecha_hora) AS hora,
      m.llego_tarde,
      m.minutos_tarde,
      m.foto,
      m.latitud,
      m.longitud
    FROM movimientos m
    JOIN empresas e ON e.id = m.empresa_id
  `);
}

module.exports = { asegurarEsquema, generarCodigoEmpresa, uid };
