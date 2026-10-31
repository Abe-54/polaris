// RT1 repros (ENG-656) for the receiver and token lifetime. Expected to FAIL on 08798fa8f.
import { expect, test } from "bun:test";
import { connect, type Socket } from "node:net";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { sessionTraceEnvironment } from "../../../apps/daemon/src/traces/environment.ts";
import { TraceRuntime } from "../../../apps/daemon/src/traces/runtime.ts";
import { TraceTokenVault } from "../../../apps/daemon/src/traces/tokens.ts";
import {
  postTraces,
  TEST_SESSION,
  TEST_WORKSPACE,
  withTraceFixture,
} from "../../../apps/daemon/src/traces/testing.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** An unauthenticated local process: no token, a path that 404s, and a body dripped below idleTimeout. */
const slowPost = (port: number): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        `POST /not-otlp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n`
      );
      resolve(socket);
    });

    socket.on("error", reject);
  });

test(
  "an unauthenticated local process holding two slow bodies cannot keep every exporter out",
  () =>
    withTraceFixture(async (f) => {
      let running = true;
      const sockets = new Set<Socket>();

      // Bun closes each slow request after ~10-12 s; the attacker simply reconnects.
      const hold = async () => {
        while (running) {
          const socket = await slowPost(f.port);
          sockets.add(socket);
          await new Promise((resolve) => socket.once("close", resolve));
          sockets.delete(socket);
        }
      };

      void hold();
      void hold();

      try {
        await sleep(15_000);
        expect((await postTraces(f.endpoint!)).status).toBe(200);
      } finally {
        running = false;
        for (const socket of sockets) socket.destroy();
      }
    }),
  30_000
);

test("closing a Harness scope (dormancy, graceful Daemon shutdown) keeps an active session's endpoint", () =>
  withTraceFixture(async (f) => {
    const env = await Effect.runPromise(
      Effect.scoped(sessionTraceEnvironment(TEST_SESSION, {})).pipe(
        Effect.provideService(TraceRuntime, f.runtime)
      )
    );
    // The session is still active (f.state.active); only its Harness process went away.
    const response = await postTraces(env.OTEL_EXPORTER_OTLP_ENDPOINT!);
    expect(response.status).toBe(200);
  }));

test("a storage failure answers a retryable status, not 400", () =>
  withTraceFixture(async (f) => {
    // A directory where the database belongs makes SQLite fail to open.
    await mkdir(join(f.root, "traces.sqlite"));
    const response = await postTraces(f.endpoint!);
    expect([429, 503]).toContain(response.status);
  }));

test("trace-tokens.json does not gain a hash per Daemon restart for the same binding", async () => {
  const filename = `/tmp/rt1-vault-${crypto.randomUUID()}.json`;
  const binding = { checkout: "/repo", workspaceId: TEST_WORKSPACE, sessionId: null };

  for (let restart = 0; restart < 5; restart++) new TraceTokenVault(filename).issue(binding);
  const saved = (await Bun.file(filename).json()) as { bindings: Record<string, unknown> };
  await Bun.file(filename).delete();
  expect(Object.keys(saved.bindings)).toHaveLength(1);
});

test("the receiver binds once the port is freed after a conflict", async () => {
  const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = holder.port!;
  let seen = "";

  await withTraceFixture(
    async (f) => {
      holder.stop(true);
      await sleep(3000);
      const page = await Effect.runPromise(f.runtime.setup(TEST_SESSION));
      seen = page.availability._tag;
    },
    { port, owner: async () => null }
  );
  expect(seen).toBe("Listening");
});
