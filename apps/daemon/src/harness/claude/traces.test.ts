import { expect, test } from "bun:test";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { DomainEvent } from "@polaris/protocol";
import { commit, turn } from "../../traces/authority.testing.ts";
import { withInstrumentation } from "../../traces/instrumentation/integration.testing.ts";
import { TraceSettings } from "../../traces/settings.ts";
import { TraceStore } from "../../traces/store.ts";
import { TEST_SESSION, TEST_WORKSPACE } from "../../traces/testing.ts";
import { makeClaudeDriver } from "./ClaudeDriver.ts";
import { FakeClaude } from "./fakeClaude.ts";
import { applyClaudeTraceHooks } from "./traces.ts";

const updatedCommand = Schema.decodeUnknownSync(
  Schema.Struct({
    hookSpecificOutput: Schema.Struct({ updatedInput: Schema.Struct({ command: Schema.String }) }),
  })
);

const input = (cwd: string, command: string) => ({
  hook_event_name: "PreToolUse" as const,
  tool_name: "Bash",
  tool_input: { command },
  tool_use_id: "node-app",
  session_id: "claude-test",
  transcript_path: "",
  cwd,
});

// Claude trace hooks explicitly refuse Windows because launch rewrites require POSIX Bash.

test.skipIf(process.platform === "win32")(
  "Claude and its MCP children stay uninstrumented while its Bash Node app traces the launch Turn",
  () =>
    withInstrumentation(async (f) => {
      await writeFile(join(f.checkout, "package.json"), '{"name":"bash-node-app"}');
      await writeFile(
        join(f.checkout, "app.mjs"),
        `import http from 'node:http';
      const server = http.createServer((_req,res) => res.end('node-ok'));
      server.listen(0,'127.0.0.1', async () => {
        console.log(await (await fetch('http://127.0.0.1:'+server.address().port+'/launch')).text());
        server.close();
      });`
      );
      await f.runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const settings = yield* TraceSettings;
            yield* settings.patch(TEST_WORKSPACE, { autoInstrument: "node", forwarding: false });
            const launched = turn(2);
            yield* commit([DomainEvent.cases.TurnStarted.make({ turn: launched })]);
            const fake = new FakeClaude();

            const driver = makeClaudeDriver({
              query: fake.query,
              claudePath: () => "/opt/bin/claude",
            });

            const session = yield* driver.open({
              sessionId: TEST_SESSION,
              cwd: f.checkout,
              permissionMode: "full-access",
              model: null,
              effort: null,
              resumeCursor: null,
              environment: {
                NODE_OPTIONS:
                  '--no-warnings --import "file:///tmp/node-instrumentation/old/register.mjs"',
                POLARIS_OTEL_ENDPOINT: "http://127.0.0.1:1/stale",
                POLARIS_OTEL_SERVICE_NAME: "stale",
              },
            });

            const env = fake.options?.env;

            if (env === undefined) throw new Error("Missing Claude environment");
            expect(env?.NODE_OPTIONS?.trim()).toBe("--no-warnings");
            expect(Object.keys(env ?? {}).filter((key) => key.startsWith("POLARIS_OTEL_"))).toEqual(
              []
            );

            const mcp = Bun.spawn(["node", "-e", "console.log(JSON.stringify(process.env))"], {
              env,
              stdout: "pipe",
              stderr: "pipe",
            });

            const output = yield* Effect.promise(() => new Response(mcp.stdout).text());
            expect(yield* Effect.promise(() => mcp.exited)).toBe(0);
            expect(output).not.toContain("POLARIS_OTEL_");
            expect(output).not.toContain("node-instrumentation");
            yield* session.sendTurn({
              turnId: launched.id,
              prompt: "start",
              attachments: [],
              model: null,
              effort: null,
            });
            yield* Effect.promise(() => fake.nextInput(0));

            const hook = fake.options?.hooks?.PreToolUse?.find((h) => h.matcher === "Bash")
              ?.hooks[0];

            if (!hook) throw new Error("Missing Bash trace hook");

            const result = yield* Effect.promise(() =>
              hook(input(f.checkout, "node app.mjs"), "node-app", {
                signal: new AbortController().signal,
              })
            );

            const child = Bun.spawn(
              ["/bin/bash", "-c", updatedCommand(result).hookSpecificOutput.updatedInput.command],
              {
                cwd: f.checkout,
                env,
                stdout: "pipe",
                stderr: "pipe",
              }
            );

            const stdout = yield* Effect.promise(() => new Response(child.stdout).text());
            const stderr = yield* Effect.promise(() => new Response(child.stderr).text());
            expect({ code: yield* Effect.promise(() => child.exited), stderr }).toEqual({
              code: 0,
              stderr: "",
            });
            expect(stdout).toContain("node-ok");
            const store = yield* TraceStore;
            const page = yield* store.list(f.checkout);
            expect(page.total).toBeGreaterThan(0);
            const spans = (yield* store.get(f.checkout, page.traces[0]!.id)).spans;
            expect(spans.some((span) => span.kind === "server")).toBe(true);
            expect(spans.every((span) => span.polaris.launchedTurn?.id === launched.id)).toBe(true);
          })
        )
      );
    }),
  20000
);

// Claude trace hooks explicitly refuse Windows because launch rewrites require POSIX Bash.

test.skipIf(process.platform === "win32")("entering plan mode stops Bash trace rewrites", () =>
  withInstrumentation(async (f) => {
    await f.runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const options: Options = {};
          yield* applyClaudeTraceHooks(
            options,
            {
              sessionId: TEST_SESSION,
              cwd: f.checkout,
              permissionMode: "full-access",
              model: null,
              effort: null,
              resumeCursor: null,
            },
            () => turn(2).id,
            () => "plan"
          );
          const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];

          if (!hook) throw new Error("Missing Bash trace hook");
          expect(
            yield* Effect.promise(() =>
              hook(input(f.checkout, "node app.mjs"), "node-app", {
                signal: new AbortController().signal,
              })
            )
          ).toEqual({});
        })
      )
    );
  })
);
