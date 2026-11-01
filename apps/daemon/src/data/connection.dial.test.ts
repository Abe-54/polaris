import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Redacted } from "effect";
import { parseConnection } from "./connection.ts";

const environment = {
  PGHOST: "unreachable.invalid",
  PGPORT: "9",
  PGUSER: "wrong",
  PGDATABASE: "wrong",
  PGSSLMODE: "verify-full",
  DATABASE_URL: "postgres://wrong@unreachable.invalid/wrong",
};

test.each([
  ["postgres", "path"],
  ["mysql", "socket"],
  ["postgres", "host"],
  ["postgres", "tcp"],
] as const)(
  "R6: %s %s dials the explicit target despite Host database environment",
  async (engine, route) => {
    const root = await mkdtemp("/tmp/data-dial-");
    const hits: string[] = [];

    const tcp = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          hits.push("tcp");
          socket.end();
        },
        data() {},
      },
    });

    const socketPath =
      route === "host" ? join(root, `.s.PGSQL.${tcp.port}`) : join(root, "db.sock");

    const unix = Bun.listen({
      unix: socketPath,
      socket: {
        open(socket) {
          hits.push("unix");
          socket.end();
        },
        data() {},
      },
    });

    const previous = Object.fromEntries(
      Object.keys(environment).map((key) => [key, process.env[key]])
    );

    const url = new URL(`${engine}://reader:secret@127.0.0.1:${tcp.port}/app`);

    if (route !== "tcp") url.searchParams.set(route, route === "host" ? root : socketPath);

    const parsed = parseConnection({
      name: "app",
      url: Redacted.make(url.href),
      foundIn: { kind: "env" },
    })!;

    Object.assign(process.env, environment);

    const sql = new Bun.SQL({
      adapter: parsed.engine,
      ...parsed.connection,
      password: Redacted.value(parsed.connection.password),
      max: 1,
      connectionTimeout: 1,
    });

    try {
      await sql.unsafe("SELECT 1").catch(() => undefined);
      expect(hits.length).toBeGreaterThan(0);
      expect([...new Set(hits)]).toEqual([route === "tcp" ? "tcp" : "unix"]);
    } finally {
      await sql.close({ timeout: 0 });
      tcp.stop(true);
      unix.stop(true);

      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }

      await rm(root, { recursive: true, force: true });
    }
  }
);
