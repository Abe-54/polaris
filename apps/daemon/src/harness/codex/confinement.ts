/**
 * The Reviewer's Codex thread runs under a permission profile that reads only its checkout
 * (plus what a shell needs), never the legacy `read-only` sandbox, which reads the whole disk,
 * and with no tool that runs outside it. See docs/adr/0055-the-reviewer-reads-only-its-checkout.md.
 */
import { Effect, Option, Schema } from "effect";
import { isWithin } from "../../files/fs.ts";
import { type ReadConfinement, readConfinement } from "../confinement.ts";
import type * as Gen from "./generated/index.ts";
import type { HarnessError } from "../HarnessDriver.ts";
import { codexError } from "./RpcConnection.ts";
import { appServerExecutable } from "./executable.ts";

export const REVIEWER_PROFILE = "polaris_reviewer";

/** Verified on codex-cli 0.162.1; the bindings Polaris is generated from (0.159.2) carry profiles. */
export const PROFILE_MIN_VERSION = "0.159.2";

/** A server or plugin by name; only its name matters here. */
const Toggle = Schema.Struct({ enabled: Schema.optionalKey(Schema.NullOr(Schema.Boolean)) });

const Named = Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Toggle)));

/** The part of `config/read`'s answer that names what runs outside the sandbox. */
const EffectiveConfig = Schema.Struct({
  config: Schema.Struct({ mcp_servers: Named, plugins: Named }),
});

const decodeEffective = Schema.decodeUnknownOption(EffectiveConfig);

export type Effective = typeof EffectiveConfig.Type;

const disabled = (named: Readonly<Record<string, typeof Toggle.Type>> | null | undefined) =>
  Object.fromEntries(Object.keys(named ?? {}).map((name) => [name, { enabled: false }]));

/**
 * MCP servers, plugins, apps, hooks and browser or computer use run outside the sandbox, memories
 * hold other sessions' content, and web search reaches the network: a Reviewer has none of them.
 */
const outsideTools = ({ config }: Effective) => ({
  mcp_servers: disabled(config.mcp_servers),
  plugins: disabled(config.plugins),
  "features.apps": false,
  "features.plugins": false,
  "features.hooks": false,
  "features.memories": false,
  "features.browser_use": false,
  "features.computer_use": false,
  "features.tool_suggest": false,
  web_search: "disabled",
});

/**
 * Codex's own binary, which its Linux sandbox runs first inside bubblewrap; often under home
 * (`~/.codex/packages`, `~/.npm-global`), which the profile closes. Only the file, never its dir.
 */
const readableExecutable = (confinement: ReadConfinement, executable: string | null) =>
  executable === null || confinement.hidden.some((path) => isWithin(path, executable))
    ? []
    : [executable];

/** `thread/start`'s `config` for a read-only thread: the profile, chosen by default. */
export const reviewerConfig = (
  confinement: ReadConfinement,
  effective: Effective,
  executable: string | null = null
) => ({
  ...outsideTools(effective),
  default_permissions: REVIEWER_PROFILE,
  permissions: {
    [REVIEWER_PROFILE]: {
      filesystem: {
        ":minimal": "read",
        // `:minimal` alone lets a command read and write every /tmp.
        ":slash_tmp": "deny",
        ":tmpdir": "deny",
        ...Object.fromEntries(
          [
            confinement.root,
            ...confinement.shellRoots,
            ...readableExecutable(confinement, executable),
          ].map((path) => [path, "read"])
        ),
        ...Object.fromEntries(confinement.hidden.map((path) => [path, "deny"])),
      },
    },
  },
  // Only `core` variables (PATH, HOME, USER, SHELL, TMPDIR…), so no key or token reaches a command.
  "shell_environment_policy.inherit": "core",
  "shell_environment_policy.set": confinement.shellEnv,
});

/** The app-server's version from `initialize`'s `userAgent` ("polaris/0.162.1 (Mac OS …)"). */
export const versionOfUserAgent = (userAgent: string): string | null =>
  userAgent.match(/^[^/\s]+\/(\d+\.\d+\.\d+)/)?.[1] ?? null;

/** Whether this app-server can hold a thread to a permission profile; unknown is no. */
export const confinesReads = (userAgent: string): boolean => {
  const version = versionOfUserAgent(userAgent);

  return version !== null && Bun.semver.order(version, PROFILE_MIN_VERSION) >= 0;
};

/** How a thread is sandboxed: by its permission mode's `sandbox`, or (read-only) by the profile. */
export interface ThreadSandboxing {
  readonly mode: { readonly sandbox?: Gen.SandboxMode };
  readonly config: ReturnType<typeof reviewerConfig> | null;
}

/**
 * A read-only thread gets the profile and no mode (Codex refuses both). An app-server too old
 * for profiles would fall back to the user's own sandbox, so that session doesn't start.
 */
export const threadSandboxing = (options: {
  readonly readOnly: boolean | undefined;
  readonly sandbox: Gen.SandboxMode;
  readonly userAgent: string;
  readonly cwd: string;
  /** Where the app-server's pid is recorded: on Linux its sandbox runs that process's binary. */
  readonly appServerState?: string;
  /** `config/read` for `cwd`: the user's and the project's layers, merged. */
  readonly readConfig: Effect.Effect<unknown, HarnessError>;
}) =>
  Effect.gen(function* () {
    if (options.readOnly !== true)
      return { mode: { sandbox: options.sandbox }, config: null } satisfies ThreadSandboxing;

    if (!confinesReads(options.userAgent))
      return yield* codexError(
        `Codex ${versionOfUserAgent(options.userAgent) ?? "of an unknown version"} can't keep the reviewer to its checkout. Update Codex to ${PROFILE_MIN_VERSION} or later.`
      );
    const answer = yield* Effect.option(options.readConfig);
    const effective = Option.flatMap(answer, decodeEffective);

    // Without the list Polaris can't turn the user's MCP servers off, so the session doesn't start.
    if (Option.isNone(effective))
      return yield* codexError("Codex didn't say which tools the reviewer would have.");

    const confinement = yield* Effect.tryPromise({
      try: () => readConfinement(options.cwd),
      catch: (cause) => codexError("Could not keep the reviewer to its checkout", cause),
    });

    return {
      mode: {},
      config: reviewerConfig(
        confinement,
        effective.value,
        options.appServerState === undefined ? null : appServerExecutable(options.appServerState)
      ),
    } satisfies ThreadSandboxing;
  });
