import { tempDir } from "../platform/tempDir.testing.ts";
// RT1 repros (ENG-656) for the receiver and token lifetime. Expected to FAIL on 08798fa8f.
import { expect, test } from "bun:test";
import { connect, type Socket } from "node:net";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { TraceTokenVault } from "./tokens.ts";
import { postTraces, TEST_SESSION, TEST_WORKSPACE, until, withTraceFixture } from "./testing.ts";

/** An unauthenticated local process: no token, a path that 404s, and a body that never arrives. */
const slowPost = (port: number): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        `POST /not-otlp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n`,
        () => resolve(socket)
      );
    });

    socket.on("error", reject);
  });

test("an unauthenticated local process holding two slow bodies cannot keep every exporter out", () =>
  withTraceFixture(async (f) => {
    const sockets = await Promise.all([slowPost(f.port), slowPost(f.port)]);

    try {
      // Answered after the slow requests, so the receiver has seen both before the exporter posts.
      expect((await fetch(f.endpoint!)).status).toBe(405);
      expect((await postTraces(f.endpoint!)).status).toBe(200);
    } finally {
      for (const socket of sockets) socket.destroy();
    }
  }));

test("a storage failure answers a retryable status, not 400", () =>
  withTraceFixture(async (f) => {
    // A directory where the database belongs makes SQLite fail to open.
    await mkdir(join(f.root, "traces.sqlite"));
    const response = await postTraces(f.endpoint!);
    expect(response.status).toBe(503);
    await rm(join(f.root, "traces.sqlite"), { recursive: true });
    expect((await postTraces(f.endpoint!)).status).toBe(200);
  }));

test("trace-tokens.json does not gain a hash per Daemon restart for the same binding", async () => {
  const filename = join(tempDir("rt1-vault-"), "trace-tokens.json");
  const binding = { checkout: "/repo", workspaceId: TEST_WORKSPACE, sessionId: null };

  const first = new TraceTokenVault(filename).issue(binding);

  for (let restart = 0; restart < 5; restart++) {
    const vault = new TraceTokenVault(filename);
    expect(vault.issue(binding)).toBe(first);
    expect(vault.authenticate(first)).toEqual(binding);
  }

  const revoked = new TraceTokenVault(filename);
  revoked.revokeWorkspace(TEST_WORKSPACE);
  const restarted = new TraceTokenVault(filename);
  expect(restarted.authenticate(first)).toBeNull();
  expect(restarted.issue(binding)).not.toBe(first);

  const saved = Schema.decodeUnknownSync(
    Schema.Struct({ bindings: Schema.Record(Schema.String, Schema.Json) })
  )(await Bun.file(filename).json());

  expect(Object.keys(saved.bindings)).toHaveLength(1);
});

test("the receiver binds once the port is freed after a conflict", async () => {
  const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = holder.port!;
  let seen = "";

  await withTraceFixture(
    async (f) => {
      await holder.stop(true);

      await until(async () => {
        seen = (await Effect.runPromise(f.runtime.setup(TEST_SESSION))).availability._tag;

        return seen === "Listening";
      });
    },
    { port, owner: async () => null }
  );
  expect(seen).toBe("Listening");
});
