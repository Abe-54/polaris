import { SQL } from "bun";
import { engine, connect, emit, observe, query, url, single } from "./report.mjs";

export async function transactions(sql) {
  const setter = engine === "postgres" ? "SET TRANSACTION READ ONLY" : "START TRANSACTION READ ONLY";
  const statements = [
    "SELECT * FROM probe",
    "INSERT INTO probe VALUES (2, 1)",
    "UPDATE probe SET v = 1 WHERE id = 1",
    "CREATE TABLE forbidden (id INT)",
    "SELECT nextval('probe_seq')",
    "SELECT * FROM probe FOR UPDATE",
    engine === "postgres"
      ? "WITH changed AS (UPDATE probe SET v = 2 RETURNING *) SELECT * FROM changed"
      : "WITH chosen AS (SELECT 1 AS id) UPDATE probe SET v = 2 WHERE id IN (SELECT id FROM chosen)",
  ];
  for (const statement of statements) {
    await observe("read-only", ["sql.begin", setter, statement], () => sql.begin(async (tx) => {
      await tx.unsafe(setter);
      return [...await single(tx, statement)];
    }));
  }
  await query(sql, "read-only-postcondition", "SELECT * FROM probe");
  if (engine === "mysql")
    await observe("mysql-set-inside-begin", ["sql.begin", "SET TRANSACTION READ ONLY"], () => sql.begin(tx => tx.unsafe("SET TRANSACTION READ ONLY")));
  await observe("begin-read-only-option", ['sql.begin("read only")', "UPDATE probe SET v = 3 WHERE id = 1"], () => sql.begin("read only", tx => tx.unsafe("UPDATE probe SET v = 3 WHERE id = 1")));
  if (engine === "mysql") await mysqlDdl(sql);
  const multiple = "SELECT 1; UPDATE probe SET v = 42 WHERE id = 1";
  await observe("unsafe-default-multiple-statements", [multiple], async () => [...await sql.unsafe(multiple)]);
  await query(sql, "unsafe-empty-params-multiple-statements", multiple);
  await sql.unsafe("UPDATE probe SET v=0");
}

async function mysqlDdl(sql) {
  await observe("begin-read-only-ddl", ['sql.begin("read only")', "CREATE TABLE forbidden_option (id INT)"], () => sql.begin("read only", tx => tx.unsafe("CREATE TABLE forbidden_option (id INT)")));
  await query(sql, "ddl-persisted", "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('forbidden','forbidden_option') ORDER BY TABLE_NAME");
  await sql.unsafe("CREATE USER 'spike_reader'@'%' IDENTIFIED BY 'spike'");
  await sql.unsafe("GRANT SELECT ON spike.* TO 'spike_reader'@'%'");
  const readerUrl = new URL(url);
  readerUrl.username = "spike_reader";
  const reader = new SQL(readerUrl.href, { max: 1, allowPublicKeyRetrieval: true });
  try {
    await observe("reader-ddl", ['sql.begin("read only")', "CREATE TABLE forbidden_reader (id INT)"], () => reader.begin("read only", tx => tx.unsafe("CREATE TABLE forbidden_reader (id INT)")));
    await observe("reader-update", ['sql.begin("read only")', "UPDATE probe SET v = 42"], () => reader.begin("read only", tx => tx.unsafe("UPDATE probe SET v = 42")));
  } finally { await reader.close(); }
}

export async function timeouts(sql) {
  if (engine === "postgres") {
    for (const statement of ["SELECT pg_sleep(1)", "UPDATE probe SET v = 4 FROM pg_sleep(1)"])
      await observe("statement-timeout", ["sql.begin", "SET LOCAL statement_timeout = '100ms'", statement], () => sql.begin(async tx => {
        await tx.unsafe("SET LOCAL statement_timeout = '100ms'");
        return [...await tx.unsafe(statement)];
      }));
    await query(sql, "timeout-reset", "SHOW statement_timeout");
  } else {
    await sql.unsafe("SET SESSION max_execution_time = 100");
    await query(sql, "select-timeout", "SELECT SUM(a.id*b.id) AS total FROM million a CROSS JOIN million b");
    await query(sql, "benchmark-timeout-special-case", "SELECT BENCHMARK(100000000, SHA2('spike', 256)) AS work");
    await query(sql, "nonselect-no-timeout", "DO SLEEP(0.4)");
    await query(sql, "update-no-timeout", "UPDATE probe SET v = v + SLEEP(0.4) WHERE id = 1");
    await sql.unsafe("SET SESSION max_execution_time = 0");
  }
  await cancellation();
  if (engine === "mysql") await killQuery();
}

async function killQuery() {
  const worker = connect();
  const control = connect();
  const [{ id }] = await worker.unsafe("SELECT CONNECTION_ID() AS id");
  const statement = "UPDATE probe SET v = 42 + SLEEP(2) WHERE id = 1";
  const outcome = observe("mysql-kill-query", ["sql.begin", statement, `KILL QUERY ${id} at 100ms`, "ROLLBACK"], () => worker.begin(tx => tx.unsafe(statement)));
  const timer = setTimeout(() => { void control.unsafe(`KILL QUERY ${id}`).execute(); }, 100);
  try {
    await outcome;
    await query(control, "kill-update-postcondition", "SELECT * FROM probe");
  } finally {
    clearTimeout(timer);
    await worker.close({ timeout: 0 });
    await control.close({ timeout: 0 });
  }
}

async function cancellation() {
  const statement = engine === "postgres" ? "SELECT pg_sleep(1)" : "SELECT SLEEP(1) AS slept";
  for (const method of ["cancel", "abort-signal", "close"]) {
    const sql = connect();
    await sql.unsafe("SELECT 1");
    const controller = new AbortController();
    const pending = sql.unsafe(statement, [], { signal: controller.signal });
    const result = observe(`client-${method}`, [statement, `${method} at 100ms`], async () => {
      await pending;
      return { cancelled: pending.cancelled, resolved: true };
    });
    const timer = setTimeout(() => {
      if (method === "cancel") pending.cancel();
      if (method === "abort-signal") controller.abort();
      if (method === "close") void sql.close({ timeout: 0 });
    }, 100);
    await result;
    clearTimeout(timer);
    await sql.close({ timeout: 0 });
  }
  const sql = connect();
  const pending = sql.unsafe(statement);
  pending.cancel();
  await observe("cancel-before-start", [statement, "cancel before awaiting"], () => pending);
  emit("query-api", { cursor: typeof sql.unsafe("SELECT 1").cursor });
  await sql.close();
}
