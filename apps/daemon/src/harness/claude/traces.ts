import type { HookCallback, HookCallbackMatcher, Options } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionMode, SessionId, TurnId } from "@polaris/protocol";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Option, Schema, type Scope } from "effect";
import { TraceRuntime, type TraceEnvironment } from "../../traces/runtimeService.ts";
import type { OpenOptions } from "../HarnessDriver.ts";

const Bash = Schema.StructWithRest(Schema.Struct({ command: Schema.String }), [
  Schema.Record(Schema.String, Schema.Json),
]);

const decode = Schema.decodeUnknownOption(Bash);

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** The hook captures the Turn before awaiting; a background child keeps its own endpoint. */
const claudeTraceHooks = Effect.fnUntraced(function* (
  options: Options,
  sessionId: SessionId,
  source: TraceEnvironment,
  currentTurn: () => TurnId | null,
  currentMode: () => PermissionMode
): Effect.fn.Return<HookCallbackMatcher[], never, Scope.Scope> {
  const runtime = yield* Effect.serviceOption(TraceRuntime);

  if (Option.isNone(runtime) || process.platform === "win32") return [];
  const traces = runtime.value;
  let directory: Promise<string> | undefined;
  let closed = false;
  const pending = new Map<string, { turnId: TurnId; command: string }>();

  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      closed = true;
      pending.clear();

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

  const rewrite = async (bash: typeof Bash.Type, turnId: TurnId) => {
    if (closed || currentMode() === "plan") return bash;

    const env = await Effect.runPromise(
      traces.environment(sessionId, source, turnId).pipe(Effect.orElseSucceed(() => ({})))
    );

    if (Object.keys(env).length === 0) return bash;

    const path = await prepare(env);

    if (path === null || closed || currentMode() === "plan") return bash;

    return { ...bash, command: `. ${quote(path)}\n${bash.command}` };
  };

  const permission = options.canUseTool;

  if (permission !== undefined)
    options.canUseTool = async (name, input, context) => {
      const launch = pending.get(context.toolUseID);
      pending.delete(context.toolUseID);
      const result = await permission(name, input, context);

      if (name !== "Bash" || result?.behavior !== "allow" || !launch || context.signal.aborted)
        return result;
      const bash = Option.getOrNull(decode(result.updatedInput ?? input));

      if (bash === null || bash.command !== launch.command) return result;

      return { ...result, updatedInput: await rewrite(bash, launch.turnId) };
    };

  const forget: HookCallback = async (input) => {
    if (input.hook_event_name === "PostToolUse" || input.hook_event_name === "PostToolUseFailure")
      pending.delete(input.tool_use_id);

    return {};
  };

  options.hooks = {
    ...options.hooks,
    PostToolUse: [...(options.hooks?.PostToolUse ?? []), { matcher: "Bash", hooks: [forget] }],
    PostToolUseFailure: [
      ...(options.hooks?.PostToolUseFailure ?? []),
      { matcher: "Bash", hooks: [forget] },
    ],
  };

  const hook: HookCallback = async (input) => {
    const turnId = currentTurn();

    if (
      closed ||
      currentMode() === "plan" ||
      input.hook_event_name !== "PreToolUse" ||
      input.tool_name !== "Bash" ||
      input.agent_id !== undefined ||
      turnId === null
    )
      return {};

    const bash = Option.getOrNull(decode(input.tool_input));

    if (bash === null) return {};

    if (currentMode() !== "full-access") {
      // Auto-approved calls never enter canUseTool; their completion hook discards this entry.
      if (pending.size >= 1024) pending.delete(pending.keys().next().value!);
      pending.set(input.tool_use_id, { turnId, command: bash.command });

      return {};
    }

    const updatedInput = await rewrite(bash, turnId);

    if (updatedInput === bash || currentMode() !== "full-access") return {};

    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput,
      },
    };
  };

  return [{ matcher: "Bash", hooks: [hook] }];
});

export const applyClaudeTraceHooks = Effect.fnUntraced(function* (
  options: Options,
  session: OpenOptions,
  currentTurn: () => TurnId | null,
  currentMode: () => PermissionMode = () => session.permissionMode
) {
  if (session.readOnly === true) return;

  const hooks = yield* claudeTraceHooks(
    options,
    session.sessionId,
    {
      ...process.env,
      ...session.environment,
    },
    currentTurn,
    currentMode
  );

  if (hooks.length === 0) return;

  options.hooks = {
    ...options.hooks,
    PreToolUse: [...(options.hooks?.PreToolUse ?? []), ...hooks],
  };
});
