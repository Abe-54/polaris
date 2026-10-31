import type { HookCallback, HookCallbackMatcher, Options } from "@anthropic-ai/claude-agent-sdk";
import type { SessionId, TurnId } from "@polaris/protocol";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Option, Schema, type Scope } from "effect";
import { TraceRuntime, type TraceEnvironment } from "../../traces/runtime.ts";
import type { OpenOptions } from "../HarnessDriver.ts";

const Bash = Schema.StructWithRest(Schema.Struct({ command: Schema.String }), [
  Schema.Record(Schema.String, Schema.Json),
]);

const decode = Schema.decodeUnknownOption(Bash);

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** The hook captures the Turn before awaiting; a background child keeps its own endpoint. */
const claudeTraceHooks = Effect.fnUntraced(function* (
  sessionId: SessionId,
  source: TraceEnvironment,
  currentTurn: () => TurnId | null
): Effect.fn.Return<HookCallbackMatcher[], never, Scope.Scope> {
  const runtime = yield* Effect.serviceOption(TraceRuntime);

  if (Option.isNone(runtime) || process.platform === "win32") return [];
  const traces = runtime.value;
  let directory: Promise<string> | undefined;
  let closed = false;

  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      closed = true;

      if (directory !== undefined)
        await directory.then((path) => rm(path, { recursive: true, force: true })).catch(() => {});
    })
  );

  const prepare = async (env: Record<string, string>): Promise<string | null> => {
    if (closed) return null;

    try {
      directory ??= mkdtemp(join(tmpdir(), "polaris-launch-"));
      const path = join(await directory, `${crypto.randomUUID()}.sh`);

      const exports = Object.entries(env)
        .map(([key, value]) => `export ${key}=${quote(value)}`)
        .join("\n");

      await writeFile(path, `${exports}\n/bin/rm -f -- ${quote(path)}\n`, {
        mode: 0o600,
        flag: "wx",
      });

      return closed ? null : path;
    } catch {
      return null;
    }
  };

  const hook: HookCallback = async (input) => {
    const turnId = currentTurn();

    if (
      input.hook_event_name !== "PreToolUse" ||
      input.tool_name !== "Bash" ||
      input.agent_id !== undefined ||
      turnId === null
    )
      return {};

    const bash = Option.getOrNull(decode(input.tool_input));

    if (bash === null) return {};

    const env = await Effect.runPromise(
      traces.environment(sessionId, source, turnId).pipe(Effect.orElseSucceed(() => ({})))
    );

    if (Object.keys(env).length === 0) return {};

    const path = await prepare(env);

    if (path === null) return {};

    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: {
          ...bash,
          command: `. ${quote(path)}\n${bash.command}`,
        },
      },
    };
  };

  return [{ matcher: "Bash", hooks: [hook] }];
});

export const applyClaudeTraceHooks = Effect.fnUntraced(function* (
  options: Options,
  session: OpenOptions,
  currentTurn: () => TurnId | null
) {
  if (session.readOnly === true) return;

  const hooks = yield* claudeTraceHooks(
    session.sessionId,
    {
      ...process.env,
      ...session.environment,
    },
    currentTurn
  );

  if (hooks.length === 0) return;

  options.hooks = {
    ...options.hooks,
    PreToolUse: [...(options.hooks?.PreToolUse ?? []), ...hooks],
  };
});
