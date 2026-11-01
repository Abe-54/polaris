import { shortTemp } from "../../platform/testing.ts";
import { expect, test } from "bun:test";
import { exists, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { ApprovalDecision, DomainEvent, Profile, ProfilesRpcs } from "@polaris/protocol";
import { TEST_SESSION } from "../testing.ts";
import { RpcTest } from "effect/rpc";
import { ProfilesRpcsLive } from "../profiles/rpcs.ts";
import { TargetRegistry } from "./registry.ts";
import { withProfiles } from "../profiles/testing.ts";
import { Profiles } from "../profiles/index.ts";
import { TraceSessions, TraceStore } from "../index.ts";
import { commit, turn } from "../authority.testing.ts";
import { EventStore } from "../../store/EventStore.ts";
import { decideSession, stateOf } from "../../engine/session.ts";
import { initialSnapshot, stepModel, type Step } from "../../engine/session.testing.ts";
import { sessionProfileTools } from "../../mcp/sessions/profiles.ts";
import { unavailableSessions } from "../../mcp/sessions/index.ts";
import { profileTool } from "../../mcp/tools/profile.ts";

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
  const root = await mkdtemp(shortTemp("rp4p9-"));
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

native.each(["busy JS", "native block"])(
  "P9-1: cooperative capture opens no TCP listener during %s or after Daemon loss",
  (mode) =>
    scratch(async (root, registry) => {
      const script = join(root, "target.cjs");
      const trigger = join(root, "block");
      const active = join(root, "active");
      await writeFile(
        script,
        `const fs = require('node:fs');
setInterval(() => { if (fs.existsSync(${JSON.stringify(trigger)})) {
fs.unlinkSync(${JSON.stringify(trigger)}); fs.writeFileSync(${JSON.stringify(active)}, '1');
${mode === "busy JS" ? "const end=Date.now()+4000; while(Date.now()<end) Math.sqrt(Math.random());" : "require('node:child_process').execSync('sleep 4');"}
} }, 20);`
      );
      const child = await spawnNode(registry, script, "ignore");

      const noListener = async () => {
        const probe = Bun.spawn(
          ["lsof", "-nP", "-a", "-p", String(child.pid), "-iTCP", "-sTCP:LISTEN"],
          { stdout: "pipe", stderr: "pipe" }
        );

        const out = await new Response(probe.stdout).text();
        expect(await probe.exited).toBe(1);
        expect(out).toBe("");
      };

      try {
        const target = await until(() => registry.get(TEST_SESSION, child.pid));
        await noListener();
        const capture = await registry.open(target, 1);
        await writeFile(trigger, "1");
        await until(async () => ((await exists(active)) ? true : null));
        await noListener();

        if (mode === "busy JS") expect(await capture.profile).toContain('"nodes"');
        await registry.close();
        await Bun.sleep(1800);
        await noListener();
        expect(child.exitCode).toBeNull();
      } finally {
        child.kill();
        await child.exited;
      }
    }),
  15000
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
          refusal = error instanceof Error ? error.message : String(error);
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
      const { next, rejection } = stepModel(snapshot, { type }, options);

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
  "finding P9-6: a user capture completes while idle without creating a Pending Approval",
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

      try {
        await until(() => targets.get(TEST_SESSION, child.pid));

        // The production user RPC must neither open nor resolve a Pending Approval.
        const capture = runtime.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const rpc = yield* RpcTest.makeClient(ProfilesRpcs);

              return yield* rpc["profiles.attach"]({
                sessionId: TEST_SESSION,
                pid: child.pid,
                seconds: 1,
              });
            })
          ).pipe(Effect.provide(ProfilesRpcsLive))
        );

        const profile = await capture;
        expect(profile.status).toBe("completed");

        const record = await runtime.runPromise(
          Effect.flatMap(EventStore, (s) =>
            Effect.map(s.model, (m) => m.sessions.get(TEST_SESSION)!)
          )
        );

        expect(record.pending.size).toBe(0);
        expect(record.session.state).toBe("idle");

        const approvals = await runtime.runPromise(
          Effect.flatMap(EventStore, (store) =>
            store.readEvents({
              after: 0,
              upTo: Number.MAX_SAFE_INTEGER,
              sessionId: TEST_SESSION,
              eventTypes: ["ApprovalRequested"],
            })
          )
        );

        expect(approvals).toEqual([]);
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
        expect(Schema.decodeUnknownSync(Profile)(result.structuredContent?.profile).status).toBe(
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

native(
  "P9-1: a native-blocked capture times out without stopping the application",
  () =>
    scratch(async (root, registry) => {
      const script = join(root, "blocked.cjs");
      const trigger = join(root, "trigger");
      await writeFile(
        script,
        `const fs=require('node:fs'); setInterval(() => {
if(fs.existsSync(${JSON.stringify(trigger)})) { fs.unlinkSync(${JSON.stringify(trigger)}); require('node:child_process').execSync('sleep 8'); }
}, 10);`
      );
      const child = await spawnNode(registry, script, "ignore");

      try {
        const target = await until(() => registry.get(TEST_SESSION, child.pid));
        const capture = await registry.open(target, 1);
        await writeFile(trigger, "1");
        await Promise.resolve(expect(capture.profile).rejects.toThrow("capture expired"));
        expect(child.exitCode).toBeNull();
        await capture.close();
      } finally {
        child.kill();
        await child.exited;
      }
    }),
  15000
);
