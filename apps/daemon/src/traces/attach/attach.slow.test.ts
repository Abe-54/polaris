import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createConnection } from "node:net";
import { Effect, Schema } from "effect";
import {
  ApprovalDecision,
  ApprovalRequest,
  Profile,
  DomainEvent,
  TraceAvailability,
} from "@polaris/protocol";
import { withProfiles } from "../profiles/testing.ts";
import { TraceRuntime } from "../runtime.ts";
import { Profiles } from "../profiles/index.ts";
import { TEST_SESSION } from "../testing.ts";
import { commit, turn } from "../authority.testing.ts";
import { patchTurn } from "../../store/model.ts";
import { EventStore } from "../../store/EventStore.ts";
import { decideSession } from "../../engine/session.ts";
import { TraceSessions, TraceStore } from "../index.ts";
import { sessionProfileTools } from "../../mcp/sessions/profiles.ts";
import { unavailableSessions } from "../../mcp/sessions/index.ts";
import { profileTool } from "../../mcp/tools/profile.ts";

const native = test.skipIf(process.platform !== "darwin" && process.platform !== "linux");

const eventually = async <A>(read: () => Promise<A>, accept: (value: A) => boolean) => {
  for (let n = 0; n < 250; n++) {
    const value = await read();

    if (accept(value)) return value;
    await Bun.sleep(20);
  }

  throw new Error("condition did not become true");
};

const decodeState = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ url: Schema.NullOr(Schema.String), pid: Schema.Int }))
);

const program = `const fs = require('node:fs'); const inspector = require('node:inspector');
setInterval(() => { fs.writeFileSync(process.argv[2]+'.tmp', JSON.stringify({url:inspector.url() ?? null,pid:process.pid})); fs.renameSync(process.argv[2]+'.tmp',process.argv[2]);
const end=Date.now()+5; while(Date.now()<end) Math.sqrt(Math.random()); },20);`;

native(
  "MCP cooperative Node approval captures into P4, closes the inspector and leaves the process running",
  () =>
    withProfiles(async ({ root, runtime, targets }) => {
      await runtime.runPromise(commit([DomainEvent.cases.TurnStarted.make({ turn: turn(0) })]));
      const script = join(root, "target.cjs");
      const state = join(root, "state.json");
      await writeFile(script, program);

      const child = Bun.spawn([Bun.which("node")!, script, state], {
        env: { ...process.env, ...(await targets.environment(TEST_SESSION)) },
        stdout: "ignore",
        stderr: "pipe",
      });

      try {
        await eventually(
          async () => {
            try {
              return targets.get(TEST_SESSION, child.pid);
            } catch {
              return null;
            }
          },
          (v) => v !== null
        );

        const tools = await runtime.runPromise(
          Effect.gen(function* () {
            return sessionProfileTools(yield* Profiles, yield* TraceSessions, yield* TraceStore);
          })
        );

        const running = profileTool(TEST_SESSION, { ...unavailableSessions, profiles: tools })
          .call({ attach: child.pid, seconds: 1 })
          .then((result) => Schema.decodeUnknownSync(Profile)(result.structuredContent?.profile));

        const request = await eventually(
          () =>
            runtime.runPromise(
              Effect.flatMap(EventStore, (store) =>
                Effect.map(
                  store.model,
                  (m) => [...m.sessions.get(TEST_SESSION)!.pending.values()][0]
                )
              )
            ),
          (v) => v !== undefined
        );

        expect(request!.detail).toContain("without opening a network port");
        expect(request!.profileAttach?.pid).toBe(child.pid);
        expect(decodeState(await readFile(state, "utf8")).url).toBeNull();
        await runtime.runPromise(
          Effect.flatMap(EventStore, (store) =>
            store.commit({
              commandId: null,
              decide: (model) =>
                Effect.succeed(
                  decideSession(model.sessions.get(TEST_SESSION), {
                    type: "approval.respond",
                    requestId: request!.id,
                    decision: ApprovalDecision.cases.Allow.make({ remember: false }),
                    resolvedBy: "test user",
                  }).events
                ),
            })
          )
        );
        const profile = await running;
        expect(profile.origin).toBe("attach");
        expect(profile.status).toBe("completed");
        expect(profile.durationMs).toBeGreaterThan(500);

        const detail = await runtime.runPromise(
          Effect.flatMap(Profiles, (p) => p.get(TEST_SESSION, profile.id))
        );

        expect(detail.hotFunctions.length).toBeGreaterThan(0);
        await eventually(
          async () => decodeState(await readFile(state, "utf8")).url,
          (v) => v === null
        );
        expect(child.exitCode).toBeNull();
      } finally {
        child.kill();
        await child.exited;
      }
    }),
  15000
);

native(
  "deny never opens Node's inspector; unknown and Bun pids are refused",
  () =>
    withProfiles(async ({ root, runtime, targets }) => {
      await runtime.runPromise(commit([DomainEvent.cases.TurnStarted.make({ turn: turn(0) })]));
      const script = join(root, "target.cjs");
      const state = join(root, "state.json");
      await writeFile(script, program);
      const env = { ...process.env, ...(await targets.environment(TEST_SESSION)) };

      const child = Bun.spawn([Bun.which("node")!, script, state], {
        env,
        stdout: "ignore",
        stderr: "ignore",
      });

      const bun = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], {
        env,
        stdout: "ignore",
        stderr: "ignore",
      });

      try {
        await eventually(
          async () => {
            try {
              return targets.get(TEST_SESSION, child.pid);
            } catch {
              return null;
            }
          },
          (v) => v !== null
        );

        const running = runtime.runPromise(
          Effect.flatMap(Profiles, (p) => p.attach(TEST_SESSION, child.pid, 1)).pipe(Effect.exit)
        );

        const request = await eventually(
          () =>
            runtime.runPromise(
              Effect.flatMap(EventStore, (s) =>
                Effect.map(s.model, (m) => [...m.sessions.get(TEST_SESSION)!.pending.values()][0])
              )
            ),
          (v) => v !== undefined
        );

        await runtime.runPromise(
          Effect.flatMap(EventStore, (s) =>
            s.commit({
              commandId: null,
              decide: (m) =>
                Effect.succeed(
                  decideSession(m.sessions.get(TEST_SESSION), {
                    type: "approval.respond",
                    requestId: request!.id,
                    decision: ApprovalDecision.cases.Deny.make({ reason: null }),
                    resolvedBy: "test user",
                  }).events
                ),
            })
          )
        );
        expect((await running)._tag).toBe("Failure");
        expect(decodeState(await readFile(state, "utf8")).url).toBeNull();

        for (const pid of [bun.pid, 2147483647]) {
          const result = await runtime.runPromise(
            Effect.flatMap(Profiles, (p) => p.attach(TEST_SESSION, pid, 1)).pipe(Effect.exit)
          );

          expect(result._tag).toBe("Failure");
        }

        expect(bun.exitCode).toBeNull();
        expect(
          await runtime.runPromise(Effect.flatMap(Profiles, (p) => p.list(TEST_SESSION)))
        ).toEqual([]);
      } finally {
        child.kill();
        bun.kill();
        await Promise.all([child.exited, bun.exited]);
      }
    }),
  15000
);

native(
  "P9-9: a sibling with the same launch capability cannot forge the registering peer PID",
  () =>
    withProfiles(async ({ root, targets }) => {
      const state = join(root, "unrelated.json");
      const script = join(root, "unrelated.cjs");
      await writeFile(script, program);

      const registration = await targets.environment(TEST_SESSION);

      const child = Bun.spawn([Bun.which("node")!, script, state], {
        env: {
          ...process.env,
          NODE_OPTIONS: "",
          POLARIS_PROFILE_SOCKET: "",
          POLARIS_PROFILE_TOKEN: registration.POLARIS_PROFILE_TOKEN!,
        },
        stdout: "ignore",
        stderr: "ignore",
      });

      try {
        await eventually(
          () => Bun.file(state).exists(),
          (v) => v
        );

        const socket = createConnection({ path: registration.POLARIS_PROFILE_SOCKET! });

        try {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error("forged registration remained connected")),
              2000
            );

            socket.once("error", () => {});
            socket.once("close", () => {
              clearTimeout(timeout);
              resolve();
            });
            socket.once("connect", () =>
              socket.write(
                JSON.stringify({
                  kind: "register",
                  token: registration.POLARIS_PROFILE_TOKEN,
                  pid: child.pid,
                  runtime: "node",
                }) + "\n"
              )
            );
          });
        } finally {
          socket.destroy();
        }

        expect(() => targets.get(TEST_SESSION, child.pid)).toThrow("not registered");
        expect(decodeState(await readFile(state, "utf8")).url).toBeNull();
        expect(child.exitCode).toBeNull();
      } finally {
        child.kill();
        await child.exited;
      }
    }),
  15000
);

test("ProfileAttach metadata is additive and old approval records still decode", () => {
  const prior = {
    id: "request",
    sessionId: "session",
    turnId: "turn",
    kind: "tool",
    title: "tool",
    detail: null,
    options: [],
    openedAt: "2026-10-31T00:00:00.000Z",
  };

  expect(Schema.decodeUnknownSync(ApprovalRequest)(prior).profileAttach).toBeUndefined();

  const attached = Schema.decodeUnknownSync(ApprovalRequest)({
    ...prior,
    profileAttach: { pid: 42, command: "node server.js", runtime: "node", seconds: 5 },
  });

  expect(attached.profileAttach?.runtime).toBe("node");

  const { profileAttach: _, ...olderFields } = ApprovalRequest.fields;

  const decodedByOlderClient = Schema.decodeUnknownSync(Schema.Struct(olderFields))(
    Schema.encodeSync(ApprovalRequest)(attached)
  );

  expect(decodedByOlderClient.title).toBe("tool");
  expect(decodedByOlderClient.kind).toBe("tool");
  expect("profileAttach" in decodedByOlderClient).toBe(false);
});

native(
  "an existing inspector is refused without closing it",
  () =>
    withProfiles(async ({ root, targets }) => {
      const script = join(root, "target.cjs");
      const state = join(root, "state.json");
      await writeFile(script, program);

      const child = Bun.spawn([Bun.which("node")!, "--inspect=127.0.0.1:0", script, state], {
        env: { ...process.env, ...(await targets.environment(TEST_SESSION)) },
        stdout: "ignore",
        stderr: "ignore",
      });

      try {
        const target = await eventually(
          async () => {
            try {
              return targets.get(TEST_SESSION, child.pid);
            } catch {
              return null;
            }
          },
          (v) => v !== null
        );

        const before = await eventually(
          async () => {
            try {
              return decodeState(await readFile(state, "utf8")).url;
            } catch {
              return null;
            }
          },
          (v) => v !== null
        );

        await Promise.resolve(expect(targets.open(target!, 1)).rejects.toThrow());
        expect(decodeState(await readFile(state, "utf8")).url).toBe(before);

        const response = await fetch(
          before!.replace(/^ws:/, "http:").replace(/\/[^/]*$/, "/json/list")
        );

        expect(response.status).toBe(200);
      } finally {
        child.kill();
        await child.exited;
      }
    }),
  15000
);

native.each(["original argv", "changed title"])(
  "disable-sigusr1 is respected without signalling the process: %s",
  (mode) =>
    withProfiles(async ({ root, targets }) => {
      const state = join(root, "disabled.json");
      const script = join(root, "target.cjs");
      await writeFile(script, program);

      const preload = join(root, "title.cjs");
      await writeFile(preload, mode === "changed title" ? "process.title='node opaque';" : "");

      const child = Bun.spawn(
        [Bun.which("node")!, "--disable-sigusr1", "--require", preload, script, state],
        {
          env: { ...process.env, ...(await targets.environment(TEST_SESSION)) },
          stdout: "ignore",
          stderr: "ignore",
        }
      );

      try {
        await eventually(
          async () => {
            try {
              return decodeState(await readFile(state, "utf8"));
            } catch {
              return null;
            }
          },
          (v) => v !== null
        );
        expect(() => targets.get(TEST_SESSION, child.pid)).toThrow("not registered");
        expect(decodeState(await readFile(state, "utf8")).url).toBeNull();
        expect(child.exitCode).toBeNull();
      } finally {
        child.kill();
        await child.exited;
      }
    }),
  15000
);

native.each(["pending", "recording", "turn ended"])(
  "cancelling %s revokes attach authority and leaves no inspector or Profile",
  (phase) =>
    withProfiles(async ({ root, runtime, targets }) => {
      await runtime.runPromise(commit([DomainEvent.cases.TurnStarted.make({ turn: turn(0) })]));
      const script = join(root, "target.cjs");
      const state = join(root, "state.json");
      await writeFile(script, program);

      const child = Bun.spawn([Bun.which("node")!, script, state], {
        env: { ...process.env, ...(await targets.environment(TEST_SESSION)) },
        stdout: "ignore",
        stderr: "ignore",
      });

      const abort = new AbortController();

      try {
        await eventually(
          async () => {
            try {
              return targets.get(TEST_SESSION, child.pid);
            } catch {
              return null;
            }
          },
          (v) => v !== null
        );

        const running = runtime.runPromiseExit(
          Effect.flatMap(Profiles, (p) => p.attach(TEST_SESSION, child.pid, 30)),
          { signal: abort.signal }
        );

        const request = await eventually(
          () =>
            runtime.runPromise(
              Effect.flatMap(EventStore, (s) =>
                Effect.map(s.model, (m) => [...m.sessions.get(TEST_SESSION)!.pending.values()][0])
              )
            ),
          (v) => v !== undefined
        );

        if (phase !== "pending") {
          await runtime.runPromise(
            Effect.flatMap(EventStore, (s) =>
              s.commit({
                commandId: null,
                decide: (m) =>
                  Effect.succeed(
                    decideSession(m.sessions.get(TEST_SESSION), {
                      type: "approval.respond",
                      requestId: request!.id,
                      decision: ApprovalDecision.cases.Allow.make({ remember: false }),
                      resolvedBy: "test user",
                    }).events
                  ),
              })
            )
          );
          await eventually(
            () => runtime.runPromise(Effect.flatMap(Profiles, (p) => p.list(TEST_SESSION))),
            (profiles) => profiles.some((p) => p.status === "recording")
          );
        }

        if (phase === "turn ended") {
          await runtime.runPromise(
            commit([
              DomainEvent.cases.TurnEnded.make({
                turn: patchTurn(turn(0), {
                  status: "completed",
                  endedAt: new Date().toISOString(),
                }),
              }),
            ])
          );
        } else abort.abort();
        expect((await running)._tag).toBe("Failure");
        await eventually(
          async () => decodeState(await readFile(state, "utf8")).url,
          (v) => v === null
        );
        expect(
          await runtime.runPromise(Effect.flatMap(Profiles, (p) => p.list(TEST_SESSION)))
        ).toEqual([]);
        expect(child.exitCode).toBeNull();
        expect(
          await runtime.runPromise(
            Effect.flatMap(EventStore, (s) =>
              Effect.map(s.model, (m) => m.sessions.get(TEST_SESSION)!.pending.size)
            )
          )
        ).toBe(0);
        expect(decodeState(await readFile(state, "utf8")).url).toBeNull();
      } finally {
        child.kill();
        await child.exited;
      }
    }),
  15000
);

native(
  "bootstrap injection is independent of trace availability and skips user exports, plan and reviewer sessions",
  () =>
    withProfiles(async ({ runtime, addSession }) => {
      const plan = await addSession("readonly", { mode: "plan" });
      const reviewer = await addSession("reviewer", { origin: "reviewer" });
      await runtime.runPromise(
        Effect.gen(function* () {
          const traces = yield* TraceRuntime;

          // ENG-702: another process holding the receiver's port must not cost attach its bootstrap.
          yield* traces.setAvailability(
            TraceAvailability.cases.Unavailable.make({
              code: "EADDRINUSE",
              message: "Traces is unavailable: port 4319 is in use.",
              owner: null,
            })
          );
          const unavailable = yield* traces.environment(TEST_SESSION, {});
          expect(unavailable.NODE_OPTIONS).toContain("--import");
          expect(unavailable.POLARIS_PROFILE_TOKEN?.length).toBe(64);
          expect(unavailable.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
          yield* traces.setAvailability(TraceAvailability.cases.Listening.make({}));

          for (const id of [plan, reviewer])
            expect((yield* traces.environment(id, {})).NODE_OPTIONS).toBeUndefined();
          expect(
            (yield* traces.environment(TEST_SESSION, {
              OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:1000",
            })).NODE_OPTIONS
          ).toBeUndefined();

          const env = yield* traces.environment(TEST_SESSION, {
            NODE_OPTIONS: "--max-old-space-size=256",
          });

          expect(env.NODE_OPTIONS).toContain("--max-old-space-size=256 --import");
          expect(env.POLARIS_PROFILE_TOKEN?.length).toBe(64);
        })
      );
    })
);
