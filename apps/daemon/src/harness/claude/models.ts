/**
 * Claude's Models and effort levels, as Claude Code reports them.
 *
 * Listing starts a `claude` child with no prompt, asks `supportedModels()` and
 * closes it: no transcript (`persistSession: false`), no MCP servers, no hooks,
 * run from `~/.polaris` so no project settings apply. It costs one short
 * process (~0.5 s) and whatever Claude Code itself fetches to answer; nothing
 * is sent to a model.
 */
import { harnessEnv } from "../environment.ts";
import { mkdirSync } from "node:fs";
import type { EffortLevel, ModelInfo, Options } from "@anthropic-ai/claude-agent-sdk";
import { Model } from "@polaris/protocol";
import { Effect } from "effect";
import { polarisHome } from "../../paths.ts";
import { HarnessError } from "../HarnessDriver.ts";
import type { QueryFn } from "./ClaudeDriver.ts";
import { Inbox } from "./inbox.ts";
import { claudeExecutable } from "./executable.ts";
import { claudeNotInstalled } from "./notInstalled.ts";

const EFFORT_LEVELS: ReadonlyArray<EffortLevel> = ["low", "medium", "high", "xhigh", "max"];

export const isEffortLevel = (effort: string): effort is EffortLevel =>
  EFFORT_LEVELS.some((level) => level === effort);

/** Claude Code's row for "whatever Claude Code picks"; its `value` is `default`. */
const DEFAULT_ROW = "default";

export const toModel = (info: ModelInfo): Model =>
  new Model({
    id: info.value,
    name: info.displayName,
    description: info.description === "" ? null : info.description,
    efforts: info.supportsEffort === true ? [...(info.supportedEffortLevels ?? [])] : [],
    // Claude Code doesn't say which level a Model defaults to.
    defaultEffort: null,
    isDefault: info.value === DEFAULT_ROW,
  });

const LIST_TIMEOUT = "30 seconds";

export const listClaudeModels = (driver: {
  readonly query: QueryFn;
  readonly claudePath: () => string | null;
}): Effect.Effect<ReadonlyArray<Model>, HarnessError> =>
  Effect.gen(function* () {
    const claudePath = driver.claudePath();

    if (claudePath === null) {
      return yield* new HarnessError({
        harness: "claude",
        message: claudeNotInstalled(),
      });
    }

    const cwd = polarisHome();
    mkdirSync(cwd, { recursive: true });

    const options: Options = {
      cwd,
      ...claudeExecutable(claudePath),
      persistSession: false,
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: ["user"],
      settings: { disableAllHooks: true },
      env: harnessEnv({ ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "polaris-daemon" }),
    };

    const infos = yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const inbox = new Inbox<never>();

        return { inbox, q: driver.query({ prompt: inbox, options }) };
      }),
      ({ q }) =>
        Effect.tryPromise({
          try: () => q.supportedModels(),
          catch: (cause) =>
            new HarnessError({
              harness: "claude",
              message: "Could not list Claude's Models",
              cause,
            }),
        }),
      ({ inbox, q }) =>
        Effect.sync(() => {
          inbox.end();
          q.close();
        })
    ).pipe(
      Effect.timeoutOrElse({
        duration: LIST_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new HarnessError({
              harness: "claude",
              message: "Claude Code took too long to list its Models",
            })
          ),
      })
    );

    return infos.map(toModel);
  });
