import { expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { Effect, Redacted } from "effect";
import {
  localityProbe,
  lsofOwners,
  composePublished,
  listenerOwners,
  verifiedLocality,
} from "./listener.ts";
import { tcpInodes } from "./linuxListener.ts";
import { sources } from "./sources.ts";
import { sourceFixture, sessionId } from "./sources.testing.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const connection = {
  hostname: "127.0.0.1",
  port: 5432,
  database: "app",
  username: "reader",
  password: Redacted.make(""),
  tls: false,
} as const;

const candidate = {
  name: "app",
  url: Redacted.make("postgres://reader@127.0.0.1/app"),
  foundIn: { kind: "env" as const },
};

// Data socket URLs require POSIX absolute paths; Windows named pipes are unsupported.
for (const mode of ["TCP", "Unix"])
  test.skipIf(process.platform === "win32" && mode === "Unix")(
    `F2: a real non-database ${mode} listener stays remote through list and resolve`,
    () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { root, options } = yield* sourceFixture;

            const path = join(yield* Effect.promise(() => realpath(root)), "listener.sock");

            const listen =
              mode === "Unix" ? `unix:${JSON.stringify(path)}` : 'hostname:"127.0.0.1",port:0';

            const child = Bun.spawn(
              [
                process.execPath,
                "-e",
                `process.title="postgres"; const s = Bun.listen({${listen},socket:{data(){}}}); console.log(s.port || 5432); setInterval(()=>{},60000);`,
              ],
              { stdout: "pipe", stderr: "pipe" }
            );

            try {
              const reader = child.stdout.getReader();
              const result = yield* Effect.promise(() => reader.read());
              const port = Number(new TextDecoder().decode(result.value).trim());
              expect(port).toBeGreaterThan(0);

              const owners = yield* Effect.promise(() =>
                listenerOwners(mode === "Unix" ? { ...connection, path } : { ...connection, port })
              );

              if (process.platform === "win32") expect(owners).toEqual([]);
              else expect(owners.map((owner) => owner.pid)).toContain(child.pid);
              expect(owners.every((owner) => !owner.executable.endsWith("/postgres"))).toBe(true);
              writeFileSync(
                join(root, ".env"),
                `DATABASE_URL=postgres://reader:secret@127.0.0.1:${port}/app${mode === "Unix" ? `?socket=${encodeURIComponent(path)}` : ""}`
              );
              const service = yield* sources(options);
              expect((yield* service.list({ sessionId }))[0]).toMatchObject({
                locality: "remote",
                access: "needs-approval",
                label: { text: "REMOTE", colour: "red" },
              });
              expect((yield* service.resolve({ sessionId, source: "app" })).source).toMatchObject({
                locality: "remote",
                access: "needs-approval",
              });
              reader.releaseLock();
            } finally {
              child.kill();
              yield* Effect.promise(() => child.exited);
            }
          })
        )
      )
  );

test("F2: missing listeners and unsupported/unknown owners fail closed", async () => {
  expect(await localityProbe("/checkout")({ ...connection, port: 1 }, candidate)).toBe("remote");
  expect(
    await localityProbe("/checkout")(
      { ...connection, path: "/tmp/no-polaris-database.sock" },
      candidate
    )
  ).toBe("remote");
});

test("macOS lsof separates actual listener owners from unrelated file records", () => {
  expect(
    lsofOwners("p123\ncpostgres\nn127.0.0.1:5432\np456\ncssh\nn127.0.0.1:5544\n", connection)
  ).toEqual([{ pid: 123, executable: "postgres" }]);
  expect(
    lsofOwners("p123\ncpostgres\nn/tmp/.s.PGSQL.5432\np456\ncbun\nn/tmp/fake.sock\n", {
      ...connection,
      hostname: "/tmp",
    })
  ).toEqual([{ pid: 123, executable: "postgres" }]);
  expect(lsofOwners("p123\ncpostgres\nn192.168.0.1:5432\n", connection)).toEqual([]);
});

test("Linux proc selects LISTEN inode for loopback/wildcard only, including IPv6", () => {
  const row = (host: string, state: string, inode: number) =>
    `0: ${host}:1538 00000000:0000 ${state} 0 0 0 0 0 ${inode}`;

  expect(
    tcpInodes(
      [
        row("0100007F", "0A", 12),
        row("00000000", "0A", 13),
        row("0100007F", "01", 14),
        row("0100A8C0", "0A", 15),
        row("00000000000000000000000001000000", "0A", 16),
      ].join("\n"),
      5432
    )
  ).toEqual(["12", "13", "16"]);
});

test("Docker/OrbStack proxy proof requires the running compose checkout, database image and published port", async () => {
  const root = await realpath(process.cwd());

  const inspection = (directory: string, image = "postgres:16", port = "5432") =>
    JSON.stringify([
      {
        Config: {
          Image: image,
          Labels: {
            "com.docker.compose.project.working_dir": directory,
            "com.docker.compose.service": "db",
          },
        },
        NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: port }] } },
      },
    ]);

  expect(await composePublished(root, connection, inspection(root))).toBe(true);
  expect(await composePublished(root, connection, inspection("/tmp/other-project"))).toBe(false);
  expect(await composePublished(root, connection, inspection(root, "alpine"))).toBe(false);
  expect(await composePublished(root, connection, inspection(root, "postgres:16", "5544"))).toBe(
    false
  );
  expect(await composePublished(root, connection, "bad json")).toBe(false);
});

test("F2: only database executable owners or verified compose proxies are local", async () => {
  const owner = (executable: string) => ({ pid: 123, executable });
  expect(await verifiedLocality([owner("/usr/bin/postgres")], async () => false)).toBe("local");
  expect(await verifiedLocality([owner("/usr/bin/mysqld")], async () => false)).toBe("local");
  expect(await verifiedLocality([owner("/usr/bin/mariadbd")], async () => false)).toBe("local");
  expect(await verifiedLocality([owner("/usr/bin/ssh")], async () => true)).toBe("remote");
  expect(await verifiedLocality([owner("/usr/bin/docker-proxy")], async () => false)).toBe(
    "remote"
  );
  expect(await verifiedLocality([owner("/usr/bin/docker-proxy")], async () => true)).toBe("local");
  expect(
    await verifiedLocality([owner("/usr/bin/postgres"), owner("/usr/bin/bun")], async () => true)
  ).toBe("remote");
  expect(await verifiedLocality([], async () => true)).toBe("remote");
});
