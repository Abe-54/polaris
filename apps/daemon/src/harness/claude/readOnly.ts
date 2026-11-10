/**
 * The SDK options of a read-only session (the Reviewer): `dontAsk`, no user or
 * project settings, hooks or MCP servers, no tool that writes or reaches the network,
 * and reads kept to the checkout. See docs/adr/0042-reviewer-without-the-sandbox.md
 * and docs/adr/0055-the-reviewer-reads-only-its-checkout.md.
 */
import type { HookCallback, Options, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { Option, Schema } from "effect";
import { isWithin } from "../../files/fs.ts";
import { repositoryEnv } from "../../service/childEnv.ts";
import { confined, type ReadConfinement } from "../confinement.ts";
import type { ClaudeSandbox } from "./sandbox.ts";

const NEVER = ["Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"];

const text = Schema.String;

const count = Schema.optionalKey(Schema.Number);

const flag = Schema.optionalKey(Schema.Boolean);

const maybe = Schema.optionalKey(Schema.String);

const ReadCall = Schema.Struct({ file_path: text, offset: count, limit: count, pages: maybe });

const GlobCall = Schema.Struct({ pattern: text, path: maybe });

const GrepCall = Schema.Struct({
  pattern: text,
  path: maybe,
  glob: maybe,
  output_mode: maybe,
  "-B": count,
  "-A": count,
  "-C": count,
  context: count,
  "-n": flag,
  "-i": flag,
  "-o": flag,
  type: maybe,
  head_limit: count,
  offset: count,
  multiline: flag,
});

/** The sandbox confines the command; `dangerouslyDisableSandbox` is refused outright. */
const BashCall = Schema.Struct({
  command: text,
  timeout: count,
  description: maybe,
  run_in_background: flag,
});

/** No `isolation`: a worktree or remote agent runs outside the checkout and its sandbox. */
const AgentCall = Schema.Struct({
  description: text,
  prompt: text,
  subagent_type: maybe,
  model: maybe,
  run_in_background: flag,
});

const GLOB_CHARACTER = /[*?[\]{}]/;

/** Claude Code expands `~`, `$HOME`, `%USERPROFILE%` and `file:` itself; `\\` and `..` can climb. */
const EXPANDS = /^~|^file:|[$%\\\0]/i;

const climbs = (pattern: string) => pattern.split(/[/{},]/).includes("..");

/** Whether Polaris and Claude Code would read `input` as the same path. */
const literal = (input: string | undefined) =>
  input === undefined || (!EXPANDS.test(input) && !climbs(input));

/** A glob's directory part, before its first wildcard. */
const staticPrefix = (pattern: string) => {
  const parts = pattern.split("/");
  const wild = parts.findIndex((part) => GLOB_CHARACTER.test(part));
  const prefix = (wild === -1 ? parts : parts.slice(0, wild)).join("/");

  if (prefix !== "") return prefix;

  return isAbsolute(pattern) ? "/" : ".";
};

type Check = (root: string, cwd: string, call: PreToolUseHookInput) => Promise<boolean>;

/** A call whose input has a field its tool's schema doesn't name is refused. */
const whenDecoded =
  <S extends Schema.Top & Schema.Decoder<unknown>>(
    schema: S,
    check: (root: string, cwd: string, call: S["Type"]) => Promise<boolean>
  ): Check =>
  (root, cwd, call) =>
    Option.match(
      Schema.decodeUnknownOption(schema)(call.tool_input, { onExcessProperty: "error" }),
      { onNone: async () => false, onSome: (decoded) => check(root, cwd, decoded) }
    );

const readCheck = whenDecoded(
  ReadCall,
  async (root, cwd, { file_path }) => literal(file_path) && confined(root, cwd, file_path)
);

const globCheck = whenDecoded(GlobCall, async (root, cwd, { pattern, path }) => {
  if (!literal(pattern) || !literal(path)) return false;
  const base = resolve(cwd, path ?? ".");

  return (await confined(root, cwd, base)) && confined(root, base, staticPrefix(pattern));
});

// Grep's `pattern` is a regex, not a path.
const grepCheck = whenDecoded(GrepCall, async (root, cwd, { path, glob }) => {
  if (!literal(path) || !literal(glob)) return false;

  return (glob === undefined || !isAbsolute(glob)) && confined(root, cwd, path ?? ".");
});

/** Bash runs in the sandbox, and Agent's subagents call the same tools through this hook. */
const fieldsOnly = <S extends Schema.Top & Schema.Decoder<unknown>>(schema: S): Check =>
  whenDecoded(schema, async () => true);

/** Every tool the Reviewer can call, and what each may be given; any other tool is refused. */
const CHECKS = new Map<string, Check>([
  ["Read", readCheck],
  ["Glob", globCheck],
  ["Grep", grepCheck],
  ["Bash", fieldsOnly(BashCall)],
  ["Agent", fieldsOnly(AgentCall)],
]);

/** Whether a call stays in `root`: run from inside it, by a tool of `tools`, with an input it allows. */
const allowed = async (
  root: string,
  tools: ReadonlyArray<string>,
  input: PreToolUseHookInput
): Promise<boolean> => {
  const check = tools.includes(input.tool_name) ? CHECKS.get(input.tool_name) : undefined;
  const cwd = await realpath(input.cwd).catch(() => null);

  if (check === undefined || cwd === null || !isWithin(root, cwd)) return false;

  return check(root, cwd, input);
};

/** Polaris's own check before Claude Code's, on every call: default-deny, by tool and by field. */
export const reviewerHook =
  (root: string, tools: ReadonlyArray<string>): HookCallback =>
  async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};

    if (await allowed(root, tools, input)) return {};

    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `The reviewer only reads files inside ${root}.`,
      },
    };
  };

/** The unsandboxed Reviewer's tools: only ones that read files, kept in by Claude Code. */
const FILE_TOOLS = ["Read", "Glob", "Grep", "Agent"];

/** The sandboxed Reviewer's: Bash, since the sandbox doesn't cover the file tools. */
const SANDBOXED_TOOLS = ["Bash", "Agent"];

/** Claude Code's own path rules: reads by path inside the checkout, never a hidden path in it. */
const base = (confinement: ReadConfinement, tools: ReadonlyArray<string>) =>
  ({
    permissionMode: "dontAsk",
    settingSources: [],
    settings: { disableAllHooks: true, permissions: { blockReadsOutsideWorkingDirectories: true } },
    mcpServers: {},
    strictMcpConfig: true,
    additionalDirectories: [],
    tools: [...tools],
    allowedTools: [`Read(/${confinement.root}/**)`, "Agent"],
    hooks: { PreToolUse: [{ hooks: [reviewerHook(confinement.root, tools)] }] },
  }) satisfies Partial<Options>;

const hiddenReads = (confinement: ReadConfinement) =>
  confinement.hidden.map((path) => `Read(/${path}/**)`);

/** Variables the shell gets: what it needs to start, and the confined git's. */
const shellKeys = (env: Readonly<Record<string, string>>, confinement: ReadConfinement) =>
  new Set(Object.keys(repositoryEnv(env, confinement.shellEnv)));

/**
 * Only Bash, so every read goes through Claude Code's OS sandbox: nothing readable but the
 * checkout and `shellRoots`, no writes, no network, and Claude Code's own keys unset in it.
 * If the sandbox can't start, the session fails.
 */
export const sandboxedReadOnly = (
  confinement: ReadConfinement,
  env: Readonly<Record<string, string>>
) => {
  const keep = shellKeys(env, confinement);

  return {
    ...base(confinement, SANDBOXED_TOOLS),
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      excludedCommands: [],
      filesystem: {
        // Claude Code's Linux sandbox opens a worktree's repository for writes unless denied.
        denyWrite: ["/", ...confinement.unwritable],
        denyRead: ["/", ...confinement.hidden],
        allowRead: [confinement.root, ...confinement.shellRoots],
      },
      network: {
        allowedDomains: [],
        deniedDomains: ["*"],
        strictAllowlist: true,
        allowLocalBinding: false,
        allowAllUnixSockets: false,
      },
      credentials: {
        envVars: Object.keys(env)
          .filter((key) => !keep.has(key))
          .map((name) => ({ name, mode: "deny" as const })),
      },
    },
    disallowedTools: [
      ...NEVER,
      ...FILE_TOOLS.filter((tool) => tool !== "Agent"),
      ...hiddenReads(confinement),
    ],
  } satisfies Partial<Options>;
};

/** Without the sandbox there is no shell at all: only tools that read, kept in by Claude Code. */
export const unsandboxedReadOnly = (confinement: ReadConfinement) =>
  ({
    ...base(confinement, FILE_TOOLS),
    sandbox: { enabled: false },
    disallowedTools: [...NEVER, "Bash", ...hiddenReads(confinement)],
  }) satisfies Partial<Options>;

/** `env` is the session's own (`readOnlyEnv`): whatever the shell doesn't need is unset in it. */
export const readOnlyOptions = (
  sandbox: ClaudeSandbox,
  confinement: ReadConfinement,
  env: Readonly<Record<string, string>>
): Partial<Options> =>
  sandbox.available ? sandboxedReadOnly(confinement, env) : unsandboxedReadOnly(confinement);

/** What Claude Code reads to start and reach its provider; the rest of the Daemon's stays out. */
const CLAUDE_CODE_KEY =
  /^(ANTHROPIC_\w+|CLAUDE_\w+|DISABLE_\w+|MAX_THINKING_TOKENS|USE_BUILTIN_RIPGREP|NODE_EXTRA_CA_CERTS|SSL_CERT_(FILE|DIR)|(HTTPS?|NO|ALL)_PROXY|(https?|no|all)_proxy|XDG_(CONFIG|CACHE|DATA|STATE)_HOME|XDG_RUNTIME_DIR|APPDATA|LOCALAPPDATA)$/;

/** A cloud provider's variables, kept only when Claude Code is set to use that provider. */
const PROVIDER_KEYS: ReadonlyArray<readonly [string, RegExp]> = [
  ["CLAUDE_CODE_USE_BEDROCK", /^AWS_\w+$/],
  [
    "CLAUDE_CODE_USE_VERTEX",
    /^(GOOGLE_\w+|CLOUDSDK_\w+|GCLOUD_PROJECT|CLOUD_ML_REGION|VERTEX_REGION_\w+)$/,
  ],
  ["CLAUDE_CODE_USE_FOUNDRY", /^AZURE_\w+$/],
];

const isSet = (value: string | undefined) =>
  value !== undefined && !["", "0", "false"].includes(value.toLowerCase());

/**
 * The read-only session's environment: an allowlist, so other services' tokens never reach
 * Claude Code; its sandbox then unsets in Bash all but the shell's own and the confined git's.
 */
export const readOnlyEnv = (
  source: Readonly<Record<string, string | undefined>>,
  confinement: ReadConfinement
): Record<string, string> => {
  const providers = PROVIDER_KEYS.flatMap(([flag, keys]) => (isSet(source[flag]) ? [keys] : []));
  const kept = (key: string) => CLAUDE_CODE_KEY.test(key) || providers.some((k) => k.test(key));

  return repositoryEnv(source, {
    ...Object.fromEntries(Object.entries(source).filter(([key]) => kept(key))),
    ...confinement.shellEnv,
  });
};
