import { expect, test } from "bun:test";
import { exists, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import {
  ApprovalDecision,
  DomainEvent,
  ProfileDetail,
} from "../../../../packages/protocol/src/index.ts";
import { TEST_SESSION } from "../../../../apps/daemon/src/traces/testing.ts";
import { TargetRegistry } from "../../../../apps/daemon/src/traces/attach/registry.ts";
import { withProfiles } from "../../../../apps/daemon/src/traces/profiles/testing.ts";
import { Profiles } from "../../../../apps/daemon/src/traces/profiles/index.ts";
import { TraceSessions, TraceStore } from "../../../../apps/daemon/src/traces/index.ts";
import { commit, turn } from "../../../../apps/daemon/src/traces/authority.testing.ts";
import { EventStore } from "../../../../apps/daemon/src/store/EventStore.ts";
import { decideSession, stateOf } from "../../../../apps/daemon/src/engine/session.ts";
import {
  initialSnapshot,
  stepModel,
  type Step,
} from "../../../../apps/daemon/src/engine/session.testing.ts";
import { sessionProfileTools } from "../../../../apps/daemon/src/mcp/sessions/profiles.ts";
import { unavailableSessions } from "../../../../apps/daemon/src/mcp/sessions/index.ts";
import { profileTool } from "../../../../apps/daemon/src/mcp/tools/profile.ts";

// Real Node children loading the real bootstrap through a real TargetRegistry (P9's own fixtures).
const native = test.skipIf(process.platform !== "darwin" && process.platform !== "linux");
const node = Bun.which("node")!;

const until = async <A>(read: () => A | Promise<A>, ms = 5000): Promise<NonNullable<A>> => {
  const deadline = Date.now() + ms;

  for (;;) {
    try {
      const value = await read();

      if (value !== undefined && value !== null) return value;
    } catch {}

    if (Date.now() > deadline) throw new Error("condition not reached");
    await Bun.sleep(20);
  }
};

const scratch = async (run: (root: string, registry: TargetRegistry) => Promise<void>) => {
  const root = await mkdtemp("/tmp/rp4p9-");
  const registry = new TargetRegistry(join(root, "bootstrap"));

  try {
    await run(root, registry);
  } finally {
    await registry.close();
    await rm(root, { recursive: true, force: true });
  }
};

const spawnNode = async (registry: TargetRegistry, script: string, stdout: "pipe" | "ignore") =>
  Bun.spawn([node, script], {
    env: { ...process.env, ...(await registry.environment(TEST_SESSION)) },
    stdout,
    stderr: "pipe",
  });

native(
  "finding P9-1: an inspector the Daemon can no longer close runs no code sent after the Daemon is gone",
  () =>
    scratch(async (root, registry) => {
      const script = join(root, "target.cjs");
      const marker = join(root, "attacker-ran");
      // Like better-sqlite3, execSync or scryptSync: the main thread blocks in native code once.
      await writeFile(
        script,
        `const i = require('node:inspector'), cp = require('node:child_process'); let once = false;
setInterval(() => { if (i.url() && !once) { once = true; cp.execSync('sleep 6'); } }, 20);`
      );
      const child = await spawnNode(registry, script, "ignore");

      try {
        const target = await until(() => registry.get(TEST_SESSION, child.pid));
        const { url } = await registry.open(target, 1);

        await Bun.sleep(200);
        // The Daemon disappears (crash, upgrade); the bootstrap claims a 1.5 s lease closes it.
        await registry.close();
        await Bun.sleep(2500);

        // Any local process, well after the lease: finds the endpoint and queues code.
        const listed = await fetch(url.replace(/^ws:/, "http:").replace(/\/[^/]*$/, "/json/list"))
          .then((r) => r.status)
          .catch(() => null);

        const socket = new WebSocket(url);
        await new Promise((resolve) => {
          socket.onopen = resolve;
          socket.onerror = resolve;
        });

        if (socket.readyState === WebSocket.OPEN)
          socket.send(
            JSON.stringify({
              id: 1,
              method: "Runtime.evaluate",
              params: {
                expression: `process.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`,
              },
            })
          );
        await Bun.sleep(5000);
        socket.close();

        expect({ listed, attackerRan: await exists(marker) }).toEqual({
          listed: null,
          attackerRan: false,
        });
      } finally {
        child.kill();
        await child.exited;
      }
    }),
  25000
);

native(
  "finding P9-2: a Node server that sets process.title after startup (next-server) can still be attached",
  () =>
    scratch(async (root, registry) => {
      const script = join(root, "server.cjs");
      // next@16.3.8 start-server.js:180 does `process.title = \`next-server (v16.3.8)\`` at load.
      await writeFile(
        script,
        "setTimeout(() => { process.title = 'next-server (v16.3.8)'; }, 200); setInterval(() => {}, 1000);"
      );
      const child = await spawnNode(registry, script, "ignore");

      try {
        await until(() => registry.get(TEST_SESSION, child.pid));
        await Bun.sleep(500);

        let refusal: string | null = null;

        try {
          registry.get(TEST_SESSION, child.pid);
        } catch (error) {
          refusal = (error as Error).message;
        }

        expect(refusal).toBeNull();
      } finally {
        child.kill();
        await child.exited;
      }
    }),
  15000
);

native(
  "finding P9-3: a process registered before 1024 later launches can still be captured after approval",
  () =>
    scratch(async (root, registry) => {
      const script = join(root, "server.cjs");
      await writeFile(script, "setInterval(() => {}, 1000);");
      const child = await spawnNode(registry, script, "ignore");

      try {
        const target = await until(() => registry.get(TEST_SESSION, child.pid));

        // Claude's PreToolUse hook mints one launch environment per Bash command.
        for (let n = 0; n < 1024; n++) await registry.environment(TEST_SESSION);

        const opened = await registry.open(target, 1).then(
          async (capture) => {
            await capture.close();

            return "opened";
          },
          (error: Error) => error.message
        );

        expect(opened).toBe("opened");
      } finally {
        child.kill();
        await child.exited;
      }
    }),
  15000
);

native(
  "finding P9-8: a registered process can still be captured while 255 other Node processes hold registrations",
  () =>
    scratch(async (root, registry) => {
      const script = join(root, "server.cjs");
      await writeFile(script, "setInterval(() => {}, 1000);");
      const child = await spawnNode(registry, script, "ignore");
      const { POLARIS_PROFILE_SOCKET: path } = await registry.environment(TEST_SESSION);
      const others: Array<ReturnType<typeof connect>> = [];

      try {
        const target = await until(() => registry.get(TEST_SESSION, child.pid));

        // Stand-ins for live registered children (test workers, watchers): one idle socket each.
        for (let n = 0; n < 255; n++) {
          const socket = connect(path!);
          await new Promise((resolve) => socket.once("connect", resolve));
          others.push(socket);
        }

        const opened = await registry.open(target, 1).then(
          async (capture) => {
            await capture.close();

            return "opened";
          },
          (error: Error) => error.message
        );

        expect(opened).toBe("opened");
      } finally {
        for (const socket of others) socket.destroy();
        child.kill();
        await child.exited;
      }
    }),
  15000
);

native(
  "finding P9-4: the bootstrap leaves a user Worker whose workerData has a nonce field alone",
  () =>
    scratch(async (root, registry) => {
      const script = join(root, "app.mjs");
      await writeFile(
        script,
        `import { Worker, isMainThread, parentPort } from 'node:worker_threads';
if (isMainThread) {
  const w = new Worker(new URL(import.meta.url), { workerData: { nonce: 'a1b2', seconds: 5 } });
  w.on('message', (m) => { console.log(m); w.terminate(); });
} else setTimeout(() => parentPort.postMessage('worker replied'), 300);`
      );
      const child = await spawnNode(registry, script, "pipe");
      const timer = setTimeout(() => child.kill(), 5000);
      const out = await new Response(child.stdout).text();
      clearTimeout(timer);
      await child.exited;

      expect(out.trim()).toBe("worker replied");
    }),
  15000
);

test("finding P9-5: a Polaris-opened inspector approval leaves an In Terminal session In Terminal", () => {
  const options = { harness: "codex", liveCoAttach: true, switchModel: false } as const;

  const reach = (steps: ReadonlyArray<Step["type"]>) => {
    let snapshot = initialSnapshot();

    for (const type of steps) {
      const { next, rejection } = stepModel(snapshot, { type } as Step, options);

      if (rejection !== null) throw new Error(`${type}: ${rejection}`);
      snapshot = next;
    }

    return snapshot;
  };

  // Codex live co-attach: a TUI Turn reaches Polaris and its MCP `profile {attach}` opens the card.
  const harness = reach(["start", "complete", "openTerminal", "terminalTurn", "requestApproval"]);
  const inspector = reach(["start", "complete", "openTerminal", "terminalTurn", "requestAttach"]);

  expect(stateOf(harness.machine)).toBe("in-terminal");
  expect(inspector.machine.context.record!.pending.size).toBe(1);
  expect(stateOf(inspector.machine)).toBe("in-terminal");
});

native(
  "finding P9-6: Profile ‹service› for 5 s from the Traces sidebar opens an approval while the agent is idle",
  () =>
    withProfiles(async ({ root, runtime, targets }) => {
      // The agent's last Turn ended; its dev server is still running (the usual time to profile).
      await runtime.runPromise(commit([DomainEvent.cases.TurnStarted.make({ turn: turn(0) })]));
      await runtime.runPromise(
        Effect.flatMap(EventStore, (store) =>
          store.commit({
            commandId: null,
            decide: (model) =>
              Effect.succeed(
                decideSession(model.sessions.get(TEST_SESSION), {
                  type: "harness.turnEnded",
                  turnId: turn(0).id,
                  status: "completed",
                  error: null,
                  checkpoint: null,
                  at: new Date().toISOString(),
                }).events
              ),
          })
        )
      );
      const script = join(root, "server.cjs");
      await writeFile(script, "setInterval(() => {}, 1000);");

      const child = Bun.spawn([node, script], {
        env: { ...process.env, ...(await targets.environment(TEST_SESSION)) },
        stdout: "ignore",
        stderr: "ignore",
      });

      const abort = new AbortController();

      try {
        await until(() => targets.get(TEST_SESSION, child.pid));

        // AttachButton → profiles.attach RPC → Profiles.attach(sessionId, pid, 5).
        const running = runtime.runPromiseExit(
          Effect.flatMap(Profiles, (p) => p.attach(TEST_SESSION, child.pid, 5)),
          { signal: abort.signal }
        );

        const outcome = await Promise.race([
          running.then((exit) => `ended: ${JSON.stringify(exit.toJSON()).slice(0, 300)}`),
          until(() =>
            runtime.runPromise(
              Effect.flatMap(EventStore, (s) =>
                Effect.map(s.model, (m) =>
                  m.sessions.get(TEST_SESSION)!.pending.size > 0 ? "approval opened" : null
                )
              )
            )
          ),
        ]);

        expect(outcome).toBe("approval opened");
        abort.abort();
        await running;
      } finally {
        child.kill();
        await child.exited;
      }
    }),
  15000
);

native(
  "finding P9-7: an approved capture writes nothing to the target's stderr",
  () =>
    withProfiles(async ({ root, runtime, targets }) => {
      await runtime.runPromise(commit([DomainEvent.cases.TurnStarted.make({ turn: turn(0) })]));
      const script = join(root, "server.cjs");
      await writeFile(script, "setInterval(() => {}, 50);");

      const child = Bun.spawn([node, script], {
        env: { ...process.env, ...(await targets.environment(TEST_SESSION)) },
        stdout: "ignore",
        stderr: "pipe",
      });

      try {
        await until(() => targets.get(TEST_SESSION, child.pid));

        const tools = await runtime.runPromise(
          Effect.gen(function* () {
            return sessionProfileTools(yield* Profiles, yield* TraceSessions, yield* TraceStore);
          })
        );

        const running = profileTool(TEST_SESSION, { ...unavailableSessions, profiles: tools }).call(
          { attach: child.pid, seconds: 1 }
        );

        const request = await until(() =>
          runtime.runPromise(
            Effect.flatMap(EventStore, (s) =>
              Effect.map(s.model, (m) => [...m.sessions.get(TEST_SESSION)!.pending.values()][0])
            )
          )
        );

        await runtime.runPromise(
          Effect.flatMap(EventStore, (s) =>
            s.commit({
              commandId: null,
              decide: (m) =>
                Effect.succeed(
                  decideSession(m.sessions.get(TEST_SESSION), {
                    type: "approval.respond",
                    requestId: request.id,
                    decision: ApprovalDecision.cases.Allow.make({ remember: false }),
                    resolvedBy: "test user",
                  }).events
                ),
            })
          )
        );
        const result = await running;
        expect(Schema.decodeUnknownSync(ProfileDetail)(result.structuredContent).profile.status).toBe(
          "completed"
        );
        child.kill();
        await child.exited;

        // The app's own stderr (its terminal, its log file, the agent's tool output).
        expect(await new Response(child.stderr).text()).toBe("");
      } finally {
        child.kill();
        await child.exited;
      }
    }),
  20000
);
