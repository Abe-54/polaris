/** Lazy pools use Bun's one-shot idle deadlines and close when credentials change. */
import { SQL } from "bun";
import { DataError, type DataSource } from "@polaris/protocol";
import { Redacted } from "effect";
import type { DataConnection } from "./connection.ts";

export function sqlOptions(
  source: Pick<DataSource, "engine">,
  connection: DataConnection
): SQL.PostgresOrMySQLOptions {
  return {
    adapter: source.engine,
    ...connection,
    password: Redacted.value(connection.password),
    max: 2,
    idleTimeout: 5,
    maxLifetime: 0,
    connectionTimeout: 5,
    prepare: true,
    ...(source.engine === "mysql" ? { foundRows: true } : undefined),
  };
}

interface Entry {
  sql: SQL;
  control: SQL;
  users: number;
  stale: boolean;
}

export class DataPools {
  private readonly entries = new Map<string, Entry>();
  private readonly sources = new Map<string, string>();
  async acquire(source: DataSource, connection: DataConnection) {
    const options = sqlOptions(source, connection);
    const key = Bun.CryptoHasher.hash("sha256", JSON.stringify(options), "hex");
    const previous = this.sources.get(source.id);

    if (previous !== undefined && previous !== key) await this.evict(previous);
    let entry = this.entries.get(key);

    if (entry === undefined) {
      for (const [id, old] of this.entries) {
        if (this.entries.size < 16) break;

        if (old.users === 0) await this.evict(id);
      }

      if (this.entries.size >= 16)
        throw new DataError({
          code: "E-DATA-UNREACHABLE",
          message: "All data source pools are busy.",
          fix: "Wait for an active query to finish and retry.",
        });
      entry = {
        sql: new SQL(options),
        control: new SQL({ ...options, max: 1 }),
        users: 0,
        stale: false,
      };
      this.entries.set(key, entry);
    }

    entry.users++;
    this.sources.set(source.id, key);
    const current = entry;

    return {
      sql: entry.sql,
      control: entry.control,
      release: async () => {
        current.users--;

        if (current.users === 0 && current.stale) await this.closeEntry(current);
      },
    };
  }
  private closeEntry(entry: Entry) {
    return Promise.all([entry.sql.close({ timeout: 0 }), entry.control.close({ timeout: 0 })]);
  }
  private async evict(key: string) {
    const entry = this.entries.get(key);

    if (!entry) return;
    this.entries.delete(key);

    for (const [source, id] of this.sources) if (id === key) this.sources.delete(source);
    entry.stale = true;

    if (entry.users === 0) await this.closeEntry(entry);
  }
  async close() {
    await Promise.all([...this.entries.values()].map((entry) => this.closeEntry(entry)));
    this.entries.clear();
    this.sources.clear();
  }
}
