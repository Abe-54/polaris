/**
 * Claude Code's Skills and Slash Commands in a directory, as the Agent SDK's
 * `supportedCommands()` reports them: a `claude` child started in that
 * directory with no prompt, no transcript, no MCP servers and no hooks, closed
 * right after (~0.9 s on Claude Code 2.1.286). Nothing is sent to a model.
 * `classify` decides how each one runs; the README has the table.
 */
import { harnessEnv } from "../environment.ts";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Options, SlashCommand as SdkCommand } from "@anthropic-ai/claude-agent-sdk";
import { type PolarisAction, SlashCommand, type SlashCommandSource } from "@polaris/protocol";
import { Effect, Option, Schema } from "effect";
import { HarnessError } from "../HarnessDriver.ts";
import type { QueryFn } from "./ClaudeDriver.ts";
import { Inbox } from "./inbox.ts";
import { claudeExecutable } from "./executable.ts";

type Builtin =
  | { readonly run: "text" }
  | { readonly run: "polaris"; readonly action: PolarisAction }
  | { readonly run: "hidden" };

const TEXT: Builtin = { run: "text" };

const HIDDEN: Builtin = { run: "hidden" };

const polaris = (action: PolarisAction): Builtin => ({ run: "polaris", action });

/**
 * Claude Code's own commands, checked against `supportedCommands()` of Claude
 * Code 2.1.286. `hidden` ones only make sense in its terminal UI.
 */
export const CLAUDE_BUILTINS = new Map<string, Builtin>(
  Object.entries({
    compact: TEXT,
    init: TEXT,
    "security-review": TEXT,
    review: TEXT,
    "pr-comments": TEXT,
    clear: polaris("new-session"),
    reset: polaris("new-session"),
    new: polaris("new-session"),
    model: polaris("model"),
    effort: polaris("model"),
    usage: polaris("usage"),
    cost: polaris("usage"),
    stats: polaris("usage"),
    ...Object.fromEntries(
      [
        "advisor",
        "agents",
        "auto-mode-setup",
        "autocompact",
        "color",
        "config",
        "settings",
        "output-style",
        "context",
        "fast",
        "focus",
        "heapdump",
        "mcp",
        "import",
        "workflow-launch-exec",
        "reload-plugins",
        "reload-skills",
        "rename",
        "name",
        "ultrareview",
        "usage-credits",
        "extra-usage",
        "insights",
        "recap",
        "skill-doctor",
        "goal",
        "design-consent",
        "design-revoke",
        "list-agents",
        "peers",
        "team-onboarding",
        "design",
        "design-sync",
      ].map((name) => [name, HIDDEN])
    ),
  })
);

/** What is on disk: Skill folders, and which plugin entries are commands rather than Skills. */
export interface SkillDirs {
  readonly user: (name: string) => boolean;
  readonly project: (name: string) => boolean;
  readonly pluginCommand: (plugin: string, name: string) => boolean;
}

const SUFFIX = / \((user|project)\)$/;

/** A plugin's entry is named `plugin:name`, or keeps that form as an alias. */
const pluginOf = (sdk: SdkCommand): string | null => {
  const qualified = [sdk.name, ...(sdk.aliases ?? [])].find((name) => name.includes(":"));

  return qualified === undefined ? null : qualified.slice(0, qualified.indexOf(":"));
};

const make = (
  sdk: SdkCommand,
  fields: Pick<SlashCommand, "kind" | "source" | "plugin" | "run" | "action" | "description">
) =>
  new SlashCommand({
    name: sdk.name,
    sigil: "/",
    argumentHint: sdk.argumentHint === "" ? null : sdk.argumentHint,
    template: null,
    ...fields,
  });

const builtinCommand = (sdk: SdkCommand, builtin: Builtin) =>
  builtin.run === "hidden"
    ? null
    : make(sdk, {
        kind: "command",
        source: "built-in",
        plugin: null,
        run: builtin.run,
        action: builtin.run === "polaris" ? builtin.action : null,
        description: sdk.description,
      });

const userCommand = (sdk: SdkCommand, dirs: SkillDirs) => {
  const custom = SUFFIX.exec(sdk.description);

  if (custom !== null) {
    const source = custom[1] === "project" ? "project" : "user";

    // Claude Code marks Skills and commands alike; a Skill has a folder.
    return make(sdk, {
      kind: dirs[source](sdk.name) ? "skill" : "command",
      source,
      plugin: null,
      run: "text",
      action: null,
      description: sdk.description.slice(0, custom.index),
    });
  }

  const plugin = pluginOf(sdk);

  if (plugin !== null) {
    const prefix = `(${plugin}) `;

    return make(sdk, {
      kind: dirs.pluginCommand(plugin, sdk.name.slice(sdk.name.indexOf(":") + 1))
        ? "command"
        : "skill",
      source: "plugin",
      plugin,
      run: "text",
      action: null,
      description: sdk.description.startsWith(prefix)
        ? sdk.description.slice(prefix.length)
        : sdk.description,
    });
  }

  const source: SlashCommandSource = dirs.project(sdk.name)
    ? "project"
    : dirs.user(sdk.name)
      ? "user"
      : "built-in";

  return make(sdk, {
    kind: "skill",
    source,
    plugin: null,
    run: "text",
    action: null,
    description: sdk.description,
  });
};

const order = (a: SlashCommand, b: SlashCommand) =>
  a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "skill" ? -1 : 1;

/** How each of Claude Code's commands runs, leaving out what only its terminal UI can do. */
export const classify = (
  commands: ReadonlyArray<SdkCommand>,
  dirs: SkillDirs
): ReadonlyArray<SlashCommand> => {
  const seen = new Set<string>();
  const out: Array<SlashCommand> = [];

  for (const sdk of commands) {
    if (sdk.name.startsWith("__") || seen.has(sdk.name)) continue;
    seen.add(sdk.name);
    const builtin = CLAUDE_BUILTINS.get(sdk.name);
    const command = builtin === undefined ? userCommand(sdk, dirs) : builtinCommand(sdk, builtin);

    if (command !== null) out.push(command);
  }

  return out.sort(order);
};

/** `cwd` and its parents up to the git root (or the filesystem root). */
const projectRoots = (cwd: string): ReadonlyArray<string> => {
  const roots: Array<string> = [];

  for (let dir = cwd; ; dir = dirname(dir)) {
    roots.push(dir);

    if (existsSync(join(dir, ".git")) || dirname(dir) === dir) return roots;
  }
};

const InstalledPlugins = Schema.Struct({
  plugins: Schema.Record(
    Schema.String,
    Schema.Array(Schema.Struct({ installPath: Schema.String }))
  ),
});

const decodeInstalled = Schema.decodeUnknownOption(Schema.fromJsonString(InstalledPlugins));

/** Each installed plugin's directory by plugin name (`codex@openai-codex` → `codex`). */
const pluginPaths = (home: string): ReadonlyMap<string, ReadonlyArray<string>> => {
  const file = join(home, ".claude", "plugins", "installed_plugins.json");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "{}";
  const installed = Option.getOrUndefined(decodeInstalled(text));
  const paths = new Map<string, Array<string>>();

  for (const [key, installs] of Object.entries(installed?.plugins ?? {})) {
    const name = key.split("@")[0] ?? key;
    paths.set(name, [...(paths.get(name) ?? []), ...installs.map((i) => i.installPath)]);
  }

  return paths;
};

export const skillDirs = (cwd: string, home = homedir()): SkillDirs => {
  const roots = projectRoots(cwd);
  const plugins = pluginPaths(home);

  return {
    user: (name) => existsSync(join(home, ".claude", "skills", name)),
    project: (name) => roots.some((root) => existsSync(join(root, ".claude", "skills", name))),
    pluginCommand: (plugin, name) =>
      (plugins.get(plugin) ?? []).some((dir) => existsSync(join(dir, "commands", `${name}.md`))),
  };
};

const LIST_TIMEOUT = "30 seconds";

const unavailable = (message: string, cause?: unknown) =>
  new HarnessError({ harness: "claude", message, cause });

export const listClaudeCommands =
  (driver: { readonly query: QueryFn; readonly claudePath: () => string | null }) =>
  (cwd: string): Effect.Effect<ReadonlyArray<SlashCommand>, HarnessError> =>
    Effect.gen(function* () {
      const claudePath = driver.claudePath();

      if (claudePath === null)
        return yield* unavailable("Claude Code is not installed: `claude` was not found on PATH");

      const options: Options = {
        cwd,
        ...claudeExecutable(claudePath),
        persistSession: false,
        mcpServers: {},
        strictMcpConfig: true,
        settingSources: ["user", "project", "local"],
        settings: { disableAllHooks: true },
        env: harnessEnv({ ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "polaris-daemon" }),
      };

      const commands = yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const inbox = new Inbox<never>();

          return { inbox, q: driver.query({ prompt: inbox, options }) };
        }),
        ({ q }) =>
          Effect.tryPromise({
            try: () => q.supportedCommands(),
            catch: (cause) => unavailable("Could not list Claude Code's commands", cause),
          }),
        ({ inbox, q }) =>
          Effect.sync(() => {
            inbox.end();
            q.close();
          })
      ).pipe(
        Effect.timeoutOrElse({
          duration: LIST_TIMEOUT,
          orElse: () => Effect.fail(unavailable("Claude Code took too long to list its commands")),
        })
      );

      return classify(commands, skillDirs(cwd));
    });
