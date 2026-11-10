import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Effect } from "effect";
import { HarnessError, type OpenOptions } from "../HarnessDriver.ts";
import type { QueryFn } from "./ClaudeDriver.ts";
import { Inbox } from "./inbox.ts";
import { claudeExecutable } from "./executable.ts";
import { claudeNotInstalled } from "./notInstalled.ts";

const failure = (message: string, cause?: unknown) =>
  new HarnessError(
    cause === undefined ? { harness: "claude", message } : { harness: "claude", message, cause }
  );

/** Ask the running binary, including its account and alias resolution, rather than pinning a model list. */
export const validateAutoModel = Effect.fn("Claude.validateAutoModel")(function* (
  q: Pick<Query, "supportedModels">,
  model: string | null
) {
  const models = yield* Effect.tryPromise({
    try: () => q.supportedModels(),
    catch: (cause) => failure("Could not verify Claude's auto permission mode", cause),
  }).pipe(
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.fail(failure("Claude Code took too long to verify auto model support")),
    })
  );

  const selected = model ?? "default";
  const info = models.find((row) => row.value === selected || row.resolvedModel === selected);
  const name = info?.displayName ?? selected;

  if (info?.supportsAutoMode === true) return;

  return yield* failure(
    info?.supportsAutoMode === false
      ? `Claude model ${name} does not support the auto permission mode.`
      : `Claude Code could not verify auto support for model ${name}; update Claude Code or choose a model advertising auto support.`
  );
});

export const validateClaudePermissionMode = Effect.fn("Claude.validatePermissionMode")(function* (
  driver: { readonly query: QueryFn; readonly claudePath: () => string | null },
  requested: Pick<OpenOptions, "cwd" | "model" | "permissionMode">
) {
  if (requested.permissionMode !== "auto") return;
  const path = driver.claudePath();

  if (path === null) return yield* failure(claudeNotInstalled());

  const options: Options = {
    cwd: requested.cwd,
    ...claudeExecutable(path),
    persistSession: false,
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: ["user", "project", "local"],
    settings: { disableAllHooks: true },
  };

  if (requested.model !== null) options.model = requested.model;

  yield* Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        const inbox = new Inbox<never>();

        return { inbox, q: driver.query({ prompt: inbox, options }) };
      },
      catch: (cause) => failure("Could not verify Claude's auto permission mode", cause),
    }),
    ({ q }) =>
      validateAutoModel(q, requested.model).pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: () => q.setPermissionMode("auto"),
            catch: (cause) =>
              failure("Claude Code refused the auto permission mode for this Workspace", cause),
          })
        )
      ),
    ({ inbox, q }) =>
      Effect.sync(() => {
        inbox.end();
        q.close();
      })
  ).pipe(
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () =>
        Effect.fail(failure("Claude Code took too long to verify the auto permission mode")),
    })
  );
});

/** Claude can silently fall back on resume or after a model/setting change. Stop before tool execution. */
export const autoFallbackError = (
  requested: OpenOptions["permissionMode"],
  actual: string
): string | null =>
  requested === "auto" && actual !== "auto"
    ? `Claude Code selected ${actual} permissions instead of auto; choose a model supporting auto or change the permission mode.`
    : null;

export const validateRequestedAuto = (
  q: Pick<Query, "supportedModels">,
  mode: OpenOptions["permissionMode"],
  model: string | null,
  readOnly?: boolean
) => (readOnly !== true && mode === "auto" ? validateAutoModel(q, model) : Effect.void);

export const messageAutoFallback = (
  mode: OpenOptions["permissionMode"],
  message: SDKMessage,
  readOnly?: boolean
): string | null => {
  if (readOnly === true || message.type !== "system") return null;

  if (message.subtype !== "init" && message.subtype !== "status") return null;

  if (message.permissionMode === undefined) return null;

  return autoFallbackError(mode, message.permissionMode);
};
