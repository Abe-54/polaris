import { expect, test } from "bun:test";
import type { Options, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { TraceTurn, TurnId, type PermissionMode } from "@polaris/protocol";
import { Effect, Schema } from "effect";
import { TEST_SESSION, withTraceFixture } from "../../traces/testing.ts";
import { TraceRuntime } from "../../traces/runtime.ts";
import { describeToolCall } from "./permissions.ts";
import { applyClaudeTraceHooks } from "./traces.ts";

const turn2 = TraceTurn.make({ sessionId: TEST_SESSION, id: TurnId.make("turn-2"), number: 2 });

const turn5 = TraceTurn.make({ sessionId: TEST_SESSION, id: TurnId.make("turn-5"), number: 5 });

const command = 'printf "%s" "$OTEL_EXPORTER_OTLP_ENDPOINT"';

const input = { command, description: "Print the endpoint" };

const context = {
  toolUseID: "bash-2",
  requestId: "request-2",
  signal: new AbortController().signal,
};

const resultInput = Schema.decodeUnknownSync(Schema.Struct({ command: Schema.String }));

const hookInput = (cwd: string) => ({
  hook_event_name: "PreToolUse" as const,
  tool_name: "Bash",
  tool_input: input,
  tool_use_id: context.toolUseID,
  session_id: "claude",
  transcript_path: "",
  cwd,
});

for (const mode of ["supervised", "auto-edits", "auto"] as const) {
  test(`${mode}: the permission boundary sees the original; execution keeps the hook's launch Turn`, () =>
    withTraceFixture(async (f) => {
      f.state.turns = [
        { turn: turn2, start: "0", end: "10" },
        { turn: turn5, start: "20", end: null },
      ];
      let current = turn2.id;
      let approve: (result: PermissionResult) => void = () => {};

      const answer = new Promise<PermissionResult>((resolve) => {
        approve = resolve;
      });

      const seen: unknown[] = [];

      const options: Options = {
        canUseTool: async (_name, value) => {
          seen.push(describeToolCall("Bash", value));

          return answer;
        },
      };

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* applyClaudeTraceHooks(
              options,
              {
                sessionId: TEST_SESSION,
                cwd: f.root,
                permissionMode: mode,
                model: null,
                effort: null,
                resumeCursor: null,
              },
              () => current
            );
            const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];

            if (!hook || !options.canUseTool) throw new Error("Missing trace callbacks");
            expect(
              yield* Effect.promise(() => hook(hookInput(f.root), context.toolUseID, context))
            ).toEqual({});
            const result = options.canUseTool("Bash", input, context);
            current = turn5.id;
            approve({ behavior: "allow", updatedInput: input });
            const allowed = yield* Effect.promise(() => result);

            if (allowed?.behavior !== "allow") throw new Error("Expected permission grant");
            expect(seen).toEqual([{ title: input.description, detail: command }]);

            const child = Bun.spawn(
              ["/bin/bash", "-c", resultInput(allowed.updatedInput).command],
              { env: {}, stdout: "pipe", stderr: "pipe" }
            );

            const endpoint = yield* Effect.promise(() => new Response(child.stdout).text());
            expect(yield* Effect.promise(() => child.exited)).toBe(0);
            expect(
              (yield* f.runtime.authenticate(endpoint.split("/").at(-1)!))?.launchedTurn
            ).toEqual(turn2);
          })
        ).pipe(Effect.provideService(TraceRuntime, f.runtime))
      );
    }));
}

test("a plan-mode transition during approval, denial and cancellation cannot inject", () =>
  withTraceFixture(async (f) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          for (const outcome of ["plan", "deny", "abort"] as const) {
            let mode: PermissionMode = "supervised";
            const abort = new AbortController();
            const ctx = { ...context, signal: abort.signal };

            const options: Options = {
              canUseTool: async () => {
                if (outcome === "deny") return { behavior: "deny", message: "declined" };

                if (outcome === "plan") mode = "plan";

                if (outcome === "abort") abort.abort();

                return { behavior: "allow", updatedInput: input };
              },
            };

            yield* applyClaudeTraceHooks(
              options,
              {
                sessionId: TEST_SESSION,
                cwd: f.root,
                permissionMode: "supervised",
                model: null,
                effort: null,
                resumeCursor: null,
              },
              () => turn2.id,
              () => mode
            );
            const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];

            if (!hook || !options.canUseTool) throw new Error("Missing trace callbacks");
            yield* Effect.promise(() => hook(hookInput(f.root), ctx.toolUseID, ctx));
            const result = yield* Effect.promise(() => options.canUseTool!("Bash", input, ctx));
            expect(result).toEqual(
              outcome === "deny"
                ? { behavior: "deny", message: "declined" }
                : { behavior: "allow", updatedInput: input }
            );
          }
        })
      ).pipe(Effect.provideService(TraceRuntime, f.runtime))
    );
  }));

test("an auto-approved command stays unchanged and completion discards its pending launch", () =>
  withTraceFixture(async (f) => {
    const options: Options = {
      canUseTool: async () => ({ behavior: "allow", updatedInput: input }),
    };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* applyClaudeTraceHooks(
            options,
            {
              sessionId: TEST_SESSION,
              cwd: f.root,
              permissionMode: "supervised",
              model: null,
              effort: null,
              resumeCursor: null,
            },
            () => turn2.id
          );
          const before = options.hooks?.PreToolUse?.[0]?.hooks[0];
          const after = options.hooks?.PostToolUse?.[0]?.hooks[0];

          if (!before || !after || !options.canUseTool) throw new Error("Missing trace callbacks");
          expect(
            yield* Effect.promise(() => before(hookInput(f.root), context.toolUseID, context))
          ).toEqual({});

          const child = Bun.spawn(["/bin/bash", "-c", command], {
            env: {},
            stdout: "pipe",
            stderr: "pipe",
          });

          expect(yield* Effect.promise(() => new Response(child.stdout).text())).toBe("");
          expect(yield* Effect.promise(() => child.exited)).toBe(0);
          yield* Effect.promise(() =>
            after(
              { ...hookInput(f.root), hook_event_name: "PostToolUse", tool_response: {} },
              context.toolUseID,
              context
            )
          );
          expect(yield* Effect.promise(() => options.canUseTool!("Bash", input, context))).toEqual({
            behavior: "allow",
            updatedInput: input,
          });
        })
      ).pipe(Effect.provideService(TraceRuntime, f.runtime))
    );
  }));
