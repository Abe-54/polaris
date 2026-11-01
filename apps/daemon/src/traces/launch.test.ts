import { expect, test } from "bun:test";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { Effect, Schema, Stream } from "effect";
import { TraceTurn, TurnId } from "@polaris/protocol";
import { makeClaudeDriver } from "../harness/claude/ClaudeDriver.ts";
import { FakeClaude, result } from "../harness/claude/fakeClaude.ts";
import { applyClaudeTraceHooks } from "../harness/claude/traces.ts";
import { HarnessEvent } from "../harness/HarnessDriver.ts";
import { Terminals, TerminalsLive } from "../terminal/Terminals.ts";
import { TraceRuntime } from "./runtime.ts";
import {
  postTraces,
  spanFixture,
  SPAN_ID,
  TEST_SESSION,
  TRACE_ID,
  traceFixture,
  withTraceFixture,
} from "./testing.ts";

const turn2 = TraceTurn.make({ sessionId: TEST_SESSION, id: TurnId.make("turn-2"), number: 2 });

const turn5 = TraceTurn.make({ sessionId: TEST_SESSION, id: TurnId.make("turn-5"), number: 5 });

const epoch = BigInt(Date.now()) * 1_000_000n;

const instant = (offset: number) => (epoch + BigInt(offset)).toString();

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const updatedCommand = Schema.decodeUnknownSync(
  Schema.Struct({
    hookSpecificOutput: Schema.Struct({ updatedInput: Schema.Struct({ command: Schema.String }) }),
  })
);

const exportingScript = (start: string, between?: string) => {
  const spans = [spanFixture({ start })];

  if (between !== undefined) spans.push(spanFixture({ start: between, id: "abcdef1234567890" }));

  const data = traceFixture(spans);

  return `const data=${JSON.stringify(data)}; const r=await fetch(process.env.OTEL_EXPORTER_OTLP_ENDPOINT+'/v1/traces',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)}); if(r.status!==200) throw new Error('export status '+r.status);`;
};

// Claude trace hooks explicitly refuse Windows because launch rewrites require POSIX Bash.
test.skipIf(process.platform === "win32")(
  "a real Bash child launched through Claude's hook keeps Turn 2 when exporting during Turn 5",
  () =>
    withTraceFixture(async (f) => {
      f.state.turns = [{ turn: turn2, start: instant(100), end: null }];
      const fake = new FakeClaude();
      const driver = makeClaudeDriver({ query: fake.query, claudePath: () => "/opt/bin/claude" });

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* driver.open({
              sessionId: TEST_SESSION,
              cwd: f.root,
              permissionMode: "full-access",
              model: null,
              effort: null,
              resumeCursor: null,
            });

            const ended = new Promise<void>((resolve) => {
              Effect.runFork(
                session.events.pipe(
                  Stream.runForEach((event) =>
                    Effect.sync(() => {
                      if (HarnessEvent.$is("TurnEnded")(event)) resolve();
                    })
                  )
                )
              );
            });

            yield* session.sendTurn({
              turnId: turn2.id,
              prompt: "start server",
              attachments: [],
              model: null,
              effort: null,
            });
            const sent = yield* Effect.promise(() => fake.nextInput(0));
            const original = `read -r go\nexec ${quote(process.execPath)} -e ${quote(exportingScript(instant(600), instant(300)))}`;
            let command = original;

            for (const matcher of fake.options?.hooks?.PreToolUse ?? []) {
              for (const hook of matcher.hooks) {
                const output = yield* Effect.promise(() =>
                  hook(
                    {
                      hook_event_name: "PreToolUse",
                      tool_name: "Bash",
                      tool_input: { command, run_in_background: true, description: "test server" },
                      tool_use_id: "bash-server",
                      session_id: "fake-claude",
                      transcript_path: "",
                      cwd: f.root,
                    },
                    "bash-server",
                    { signal: new AbortController().signal }
                  )
                );

                command = updatedCommand(output).hookSpecificOutput.updatedInput.command;
              }
            }

            expect(command).not.toContain("/otlp/");

            const child = Bun.spawn(["/bin/bash", "-c", command], {
              cwd: f.root,
              env: { ...process.env, ...fake.options?.env },
              stdin: "pipe",
              stdout: "pipe",
              stderr: "pipe",
            });

            try {
              fake.emit(result([sent.uuid!]));
              yield* Effect.promise(() => ended);
              f.state.turns = [
                { turn: turn2, start: instant(100), end: instant(200) },
                { turn: turn5, start: instant(500), end: null },
              ];

              yield* session.sendTurn({
                turnId: turn5.id,
                prompt: "next task",
                attachments: [],
                model: null,
                effort: null,
              });
              yield* Effect.promise(async () => {
                await child.stdin.write("go\n");
                await child.stdin.end();
              });

              const exit = yield* Effect.promise(() => child.exited);
              const stderr = yield* Effect.promise(() => new Response(child.stderr).text());

              expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });

              const detail = yield* f.store.get(f.root, TRACE_ID);

              expect(detail.spans.find((span) => span.id === SPAN_ID)?.polaris).toMatchObject({
                turn: turn5,
                launchedTurn: turn2,
              });
              expect(
                detail.spans.find((span) => span.id === "abcdef1234567890")?.polaris
              ).toMatchObject({
                turn: null,
                launchedTurn: turn2,
              });
            } finally {
              child.kill();
            }
          }).pipe(Effect.provideService(TraceRuntime, f.runtime))
        )
      );
    })
);

test("a real Polaris terminal command exports with Workspace authority and no invented Turn", () =>
  withTraceFixture(async (f) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const terminals = yield* Terminals;

          const terminal = yield* terminals.open({
            cwd: f.root,
            cols: 80,
            rows: 24,
            argv: [process.execPath, "-e", exportingScript(instant(600))],
          });

          yield* terminals.attach(terminal).pipe(Stream.runDrain);
          const detail = yield* f.store.get(f.root, TRACE_ID);

          expect(detail.spans[0]?.polaris).toMatchObject({
            sessionId: null,
            launchedTurn: null,
            turn: null,
            checkout: f.root,
          });
          yield* terminals.close(terminal);
        }).pipe(Effect.provide(TerminalsLive), Effect.provideService(TraceRuntime, f.runtime))
      )
    );
  }));

test("ordinary endpoints and forged resource attributes cannot manufacture a launch Turn", () =>
  withTraceFixture(async (f) => {
    f.state.turns = [{ turn: turn5, start: instant(500), end: null }];
    const data = traceFixture([spanFixture({ start: instant(600) })]);
    data.resourceSpans[0]!.resource.attributes.push({
      key: "polaris.launch.turn",
      value: { stringValue: "turn-2" },
    });
    expect((await postTraces(f.endpoint!, data)).status).toBe(200);
    const detail = await Effect.runPromise(f.store.get(f.root, TRACE_ID));
    expect(detail.spans[0]?.polaris).toMatchObject({ turn: turn5, launchedTurn: null });
    const env = await Effect.runPromise(f.runtime.environment(TEST_SESSION, {}, turn2.id));
    expect((await postTraces(env.OTEL_EXPORTER_OTLP_ENDPOINT!)).status).toBe(401);
  }));

// Claude trace hooks explicitly refuse Windows because launch rewrites require POSIX Bash.
test.skipIf(process.platform === "win32")(
  "a late Bash hook after Harness scope close cannot recreate a private launch environment",
  () =>
    withTraceFixture(async (f) => {
      f.state.turns = [{ turn: turn2, start: instant(100), end: null }];
      const options: Options = {};

      await Effect.runPromise(
        Effect.scoped(
          applyClaudeTraceHooks(
            options,
            {
              sessionId: TEST_SESSION,
              cwd: f.root,
              permissionMode: "full-access",
              model: null,
              effort: null,
              resumeCursor: null,
            },
            () => turn2.id
          )
        ).pipe(Effect.provideService(TraceRuntime, f.runtime))
      );

      const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];

      if (hook === undefined) throw new Error("Missing managed Bash hook");

      const output = await hook(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "echo late" },
          tool_use_id: "late",
          session_id: "fake-claude",
          transcript_path: "",
          cwd: f.root,
        },
        "late",
        { signal: new AbortController().signal }
      );

      expect(output).toEqual({});
    })
);

// Claude trace hooks explicitly refuse Windows because launch rewrites require POSIX Bash.
test.skipIf(process.platform === "win32")(
  "an unbound Claude Subagent's Bash hook cannot borrow the foreground Turn",
  () =>
    withTraceFixture(async (f) => {
      f.state.turns = [{ turn: turn5, start: instant(500), end: null }];
      const options: Options = {};

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* applyClaudeTraceHooks(
              options,
              {
                sessionId: TEST_SESSION,
                cwd: f.root,
                permissionMode: "full-access",
                model: null,
                effort: null,
                resumeCursor: null,
              },
              () => turn5.id
            );

            const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];

            if (hook === undefined) throw new Error("Missing managed Bash hook");

            const output = yield* Effect.promise(() =>
              hook(
                {
                  hook_event_name: "PreToolUse",
                  tool_name: "Bash",
                  tool_input: { command: "echo background" },
                  tool_use_id: "background",
                  agent_id: "unbound-subagent",
                  session_id: "fake-claude",
                  transcript_path: "",
                  cwd: f.root,
                },
                "background",
                { signal: new AbortController().signal }
              )
            );

            expect(output).toEqual({});
          })
        ).pipe(Effect.provideService(TraceRuntime, f.runtime))
      );
    })
);
