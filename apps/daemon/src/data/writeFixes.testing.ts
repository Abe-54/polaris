import { SQL } from "bun";
import { DataSource, type DataValue } from "@polaris/protocol";
import { Redacted } from "effect";
import { parseConnection } from "./connection.ts";
import { DataPools, sqlOptions } from "./pools.ts";
import { executeWrite, type WriteInput } from "./writeExecution.ts";

export const databaseUrl = (engine: "postgres" | "mysql") =>
  process.env[engine === "postgres" ? "POLARIS_TEST_PG_URL" : "POLARIS_TEST_MYSQL_URL"];

export function writeFixture(engine: "postgres" | "mysql") {
  const url = databaseUrl(engine)!;

  const { connection } = parseConnection({
    name: "WF",
    url: Redacted.make(url),
    foundIn: { kind: "manual" },
  })!;

  const name = `wf_${crypto.randomUUID().replaceAll("-", "")}`;

  const source = new DataSource({
    id: name,
    name,
    engine,
    host: connection.hostname,
    port: connection.port,
    database: connection.database,
    user: connection.username,
    locality: "local",
    foundIn: { kind: "manual" },
    access: "read",
    writes: "ask",
    label: { text: "", colour: "none" },
  });

  const admin = new SQL({
    ...sqlOptions(source, connection),
    allowPublicKeyRetrieval: engine === "mysql",
  });

  const pools = new DataPools();
  const signal = new AbortController().signal;

  const write = (
    sql: string,
    options: Partial<WriteInput> = {},
    params: ReadonlyArray<DataValue> = []
  ) =>
    executeWrite(
      pools,
      { source, connection, sql, dryRun: true, params, ...options },
      options.signal ?? signal
    );

  return {
    source,
    connection,
    name,
    admin,
    pools,
    signal,
    write,
    url,
    close: async () => {
      await pools.close();
      await admin.close();
    },
  };
}
