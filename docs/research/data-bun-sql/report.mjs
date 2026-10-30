import { SQL } from "bun";

export const engine = process.argv[2];
export const url = engine === "postgres" ? process.env.SPIKE_PG_URL : process.env.SPIKE_MYSQL_URL;
// Only these disposable, loopback fixtures use plaintext RSA key retrieval.
export const connect = (options = {}) => new SQL(url, { max: 1, idleTimeout: 0, allowPublicKeyRetrieval: engine === "mysql", ...options });
export const emit = (label, data) => console.log(JSON.stringify({ label, engine, ...data }));
export const single = (sql, text) => sql`${sql.unsafe(text)}`;
export const errorFields = (error) => ({
  name: error.name,
  code: error.code,
  errno: error.errno,
  sqlState: error.sqlState,
  message: error.message,
  hint: error.hint,
});

export async function observe(label, statements, action) {
  const start = performance.now();
  try {
    const result = await action();
    emit(label, { statements, ms: performance.now() - start, result });
    return result;
  } catch (error) {
    emit(label, { statements, ms: performance.now() - start, error: errorFields(error) });
    return undefined;
  }
}

export const query = (sql, label, statement) =>
  observe(label, [statement], async () => {
    const rows = await single(sql, statement);
    return { rows: [...rows], columns: rows.columns, count: rows.count };
  });

export function describe(value) {
  if (value === null) return { js: "null", value: "NULL" };
  if (value instanceof Date) return { js: "Date", value: value.toISOString() };
  if (ArrayBuffer.isView(value))
    return { js: value.constructor.name, bytes: value.byteLength, hex: Buffer.from(value).toString("hex") };
  if (typeof value === "bigint") return { js: "bigint", value: value.toString() };
  if (Array.isArray(value)) return { js: "Array", value: value.map(describe) };
  return { js: typeof value, value };
}
