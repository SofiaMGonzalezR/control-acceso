-- Script de creación de base de datos para el sistema de Control de Acceso
-- Ejecutar en MySQL Workbench o en la terminal de MySQL (mysql -u root -p < schema.sql)

CREATE DATABASE IF NOT EXISTS control_accesos
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE control_accesos;

CREATE TABLE IF NOT EXISTS empleados (
  id VARCHAR(20) PRIMARY KEY,
  nombre VARCHAR(150) NOT NULL,
  legajo VARCHAR(50) NOT NULL UNIQUE,
  area VARCHAR(100) NOT NULL DEFAULT 'Sin área',
  dentro BOOLEAN NOT NULL DEFAULT FALSE,
  creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS movimientos (
  id VARCHAR(20) PRIMARY KEY,
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
  INDEX idx_empleado (empleado_id)
);

CREATE TABLE IF NOT EXISTS usuarios (
  id VARCHAR(20) PRIMARY KEY,
  usuario VARCHAR(50) NOT NULL UNIQUE,
  email VARCHAR(150) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NULL,
  rol ENUM('admin', 'empleado') NOT NULL DEFAULT 'empleado',
  empleado_id VARCHAR(20) NULL,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (empleado_id) REFERENCES empleados(id) ON DELETE SET NULL
);

-- Si ya tenías la tabla usuarios creada antes de que existieran estas columnas,
-- ejecutá estas líneas aparte para agregarlas sin perder los usuarios existentes:
-- ALTER TABLE usuarios ADD COLUMN rol ENUM('admin', 'empleado') NOT NULL DEFAULT 'empleado';
-- ALTER TABLE usuarios ADD COLUMN empleado_id VARCHAR(20) NULL;
-- ALTER TABLE usuarios ADD FOREIGN KEY (empleado_id) REFERENCES empleados(id) ON DELETE SET NULL;
-- ALTER TABLE usuarios ADD COLUMN email VARCHAR(150) NULL UNIQUE;
-- ALTER TABLE usuarios MODIFY COLUMN password_hash VARCHAR(255) NULL;
-- ALTER TABLE usuarios ADD COLUMN activo BOOLEAN NOT NULL DEFAULT TRUE;
-- (si ya tenés usuarios cargados sin email, vas a tener que completarles uno manualmente
--  antes de poder hacer la columna NOT NULL; podés dejarla NULL por ahora sin problema)

CREATE TABLE IF NOT EXISTS turnos (
  id VARCHAR(20) PRIMARY KEY,
  empleado_id VARCHAR(20) NOT NULL UNIQUE,
  hora_entrada TIME NOT NULL,
  tolerancia_minutos INT NOT NULL DEFAULT 0,
  creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (empleado_id) REFERENCES empleados(id) ON DELETE CASCADE
);

-- Si ya tenías la tabla movimientos creada antes, agregá estas columnas aparte:
-- ALTER TABLE movimientos ADD COLUMN llego_tarde BOOLEAN NOT NULL DEFAULT FALSE;
-- ALTER TABLE movimientos ADD COLUMN minutos_tarde INT NULL;
-- ALTER TABLE movimientos ADD COLUMN foto LONGTEXT NULL;
-- ALTER TABLE movimientos ADD COLUMN latitud DECIMAL(10,7) NULL;
-- ALTER TABLE movimientos ADD COLUMN longitud DECIMAL(10,7) NULL;

CREATE TABLE IF NOT EXISTS codigos_recuperacion (
  id VARCHAR(20) PRIMARY KEY,
  usuario_id VARCHAR(20) NOT NULL,
  codigo VARCHAR(10) NOT NULL,
  expira_en DATETIME NOT NULL,
  usado BOOLEAN NOT NULL DEFAULT FALSE,
  creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
);

-- Vista útil para Power BI: movimientos con fecha y hora separadas,
-- así se pueden usar directamente como columnas para filtros y gráficos.
CREATE OR REPLACE VIEW vista_movimientos AS
SELECT
  id,
  empleado_id,
  nombre,
  legajo,
  area,
  tipo,
  fecha_hora,
  DATE(fecha_hora) AS fecha,
  TIME(fecha_hora) AS hora,
  llego_tarde,
  minutos_tarde,
  foto,
  latitud,
  longitud
FROM movimientos;
