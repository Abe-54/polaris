import { engine, emit, query } from "./report.mjs";

export async function setup(sql) {
  await query(sql, "version", engine === "postgres" ? "SELECT version()" : "SELECT VERSION() AS version");
  await sql.unsafe("CREATE TABLE probe (id INT PRIMARY KEY, v INT NOT NULL)");
  await sql.unsafe("INSERT INTO probe VALUES (1, 0)");
  if (engine === "postgres") await setupPostgres(sql);
  else await setupMysql(sql);
  const start = performance.now();
  for (let n = 0; n < 300; n++) {
    await sql.unsafe(`CREATE TABLE t_${n} (id INT PRIMARY KEY, parent_id INT, label VARCHAR(80) DEFAULT 'x', amount DECIMAL(30,10), FOREIGN KEY (parent_id) REFERENCES probe(id), CHECK (amount >= 0))`);
    await sql.unsafe(`CREATE INDEX t_${n}_label ON t_${n}(label)`);
  }
  await sql.unsafe("INSERT INTO t_0 VALUES (1, 1, 'first', 12.5000)");
  await sql.unsafe("CREATE VIEW probe_view AS SELECT id, v FROM probe");
  if (engine === "postgres") {
    await sql.unsafe("ANALYZE t_0");
    await sql.unsafe("CREATE FUNCTION spike_add(a integer) RETURNS integer LANGUAGE SQL IMMUTABLE AS 'SELECT a + 1'");
  } else {
    await sql.unsafe("ANALYZE TABLE t_0");
    await sql.unsafe("CREATE FUNCTION spike_add(a INT) RETURNS INT DETERMINISTIC RETURN a + 1");
  }
  emit("setup-300-tables", { ms: performance.now() - start, tables: 300 });
}

async function setupPostgres(sql) {
  await sql.unsafe("CREATE SEQUENCE probe_seq");
  await sql.unsafe("CREATE TYPE mood AS ENUM ('calm', 'busy')");
  await sql.unsafe("CREATE TABLE type_probe (n NUMERIC(40,20), big BIGINT, ts TIMESTAMPTZ, j JSON, jb JSONB, bytes BYTEA, arr INT[], texts TEXT[], uid UUID, mood mood, nullable TEXT, f FLOAT8)");
  await sql.unsafe(`INSERT INTO type_probe VALUES (12345678901234567890.12345678901234567890, 9223372036854775807, '2026-10-30 12:34:56.123456+05:30', '{"n":9007199254740993}', '{"n":9007199254740993}', decode('00ff4142','hex'), ARRAY[1,2,NULL], ARRAY['a','b'], '123e4567-e89b-12d3-a456-426614174000', 'calm', NULL, 1.2345678901234567)`);
  await sql.unsafe("CREATE TABLE million AS SELECT i AS id, repeat('x',64) AS payload FROM generate_series(1,1000000) i");
}

async function setupMysql(sql) {
  await sql.unsafe("SET SESSION time_zone = '+00:00'");
  await sql.unsafe("CREATE TABLE type_probe (n DECIMAL(40,20), big BIGINT, ts TIMESTAMP(6), dt DATETIME(6), j JSON, bytes BLOB, uid CHAR(36), mood ENUM('calm','busy'), bit_value BIT(8), tiny TINYINT(1), nullable TEXT, f DOUBLE)");
  await sql.unsafe(`INSERT INTO type_probe VALUES (12345678901234567890.12345678901234567890, 9223372036854775807, '2026-10-30 12:34:56.123456', '2026-10-30 12:34:56.123456', '{"n":9007199254740993}', X'00FF4142', '123e4567-e89b-12d3-a456-426614174000', 'calm', b'10000001', 2, NULL, 1.2345678901234567)`);
  await sql.unsafe("CREATE TABLE digits (n INT)");
  await sql.unsafe("INSERT INTO digits VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)");
  await sql.unsafe("CREATE TABLE million AS SELECT a.n+10*b.n+100*c.n+1000*d.n+10000*e.n+100000*f.n+1 AS id, REPEAT('x',64) AS payload FROM digits a CROSS JOIN digits b CROSS JOIN digits c CROSS JOIN digits d CROSS JOIN digits e CROSS JOIN digits f");
}
