/**
 * Probes one Harness on this Host without side effects: its binary's
 * `--version`, then its own sign-in status command. Polaris never reads the
 * credentials (ADR 0001) and never imports a driver here (ENG-196).
 */
import { harnessEnv } from "../environment.ts";
import { executableOf, findExecutable } from "../../platform/executable.ts";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  HarnessAvailability,
  type HarnessEntry,
  type HarnessStatus,
  type KnownHarnessKind,
} from "@polaris/protocol";
import { Effect, Option, Schema } from "effect";
import { type AcpHarness, COPILOT, GEMINI } from "../acp/harnesses.ts";

/** The environment a probe resolves binaries and homes from (the Daemon's by default). */
export type ProbeEnv = Readonly<Record<string, string | undefined>>;

export interface RunResult {
  /** Null when the command couldn't start or timed out. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface SignInState {
  readonly status: Extract<HarnessStatus, "ready" | "needs-sign-in" | "unknown">;
  readonly detail: string | null;
  /** How it's signed in, when its status command says ("Claude Max", "ChatGPT"). */
  readonly kind?: string | null;
}

interface Prober {
  /** Overrides the binary on PATH (launchd / systemd PATHs often lack nvm or Homebrew). */
  readonly binaryEnv: string;
  readonly binary: string;
  /** Variables set on every probe command, on top of `env`. */
  readonly probeEnv: (env: ProbeEnv) => ProbeEnv;
  /** A variable `--version` gets pointed at an empty scratch directory (see `../acp/harnesses.ts`). */
  readonly scratchHomeEnv?: string | null;
  readonly signIn: (path: string, env: ProbeEnv) => Effect.Effect<SignInState>;
}

const PROBE_TIMEOUT_MS = 5_000;

const home = (env: ProbeEnv): string => env.HOME || homedir();

const firstLine = (text: string): string | null => text.trim().split("\n")[0]?.trim() || null;

/** Runs one probe command in the user's home directory; never fails. */
export const runProbe = (argv: ReadonlyArray<string>, env: ProbeEnv): Effect.Effect<RunResult> =>
  Effect.promise(async (): Promise<RunResult> => {
    try {
      const proc = Bun.spawn([executableOf(argv[0] ?? "", env), ...argv.slice(1)], {
        cwd: home(env),
        env: harnessEnv(env),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: PROBE_TIMEOUT_MS,
      });

      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      return { exitCode: proc.signalCode === null ? code : null, stdout, stderr };
    } catch (cause) {
      return { exitCode: null, stdout: "", stderr: String(cause) };
    }
  });

/** `2.1.283 (Claude Code)`, `codex-cli 0.158.0`, `GitHub Copilot CLI 1.0.89.` → the version. */
export const parseVersion = (text: string): string | null =>
  text.match(/(\d+\.\d+\.\d+(?:[-+][\w.-]*\w)?)/)?.[1] ?? null;

const ClaudeAuthStatus = Schema.fromJsonString(
  Schema.Struct({
    loggedIn: Schema.Boolean,
    authMethod: Schema.optional(Schema.NullOr(Schema.String)),
    apiProvider: Schema.optional(Schema.NullOr(Schema.String)),
    subscriptionType: Schema.optional(Schema.NullOr(Schema.String)),
  })
);

const PROVIDERS = new Map([
  ["bedrock", "Amazon Bedrock"],
  ["vertex", "Google Vertex AI"],
  ["foundry", "Microsoft Foundry"],
]);

const titled = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** "Claude Max", "API key", "Amazon Bedrock"; null when the status doesn't say. */
export const claudeSignInKind = (status: typeof ClaudeAuthStatus.Type): string | null => {
  const provider = status.apiProvider ?? "firstParty";

  if (provider !== "firstParty") return PROVIDERS.get(provider) ?? provider;

  if (status.subscriptionType) return `Claude ${titled(status.subscriptionType)}`;

  return status.authMethod && /api/i.test(status.authMethod) ? "API key" : null;
};

/** "Logged in using ChatGPT" → "ChatGPT"; "…using an API key - sk-…" → "API key" (never the key). */
export const codexSignInKind = (output: string): string | null => {
  const match = /logged in using (?:an? )?([^\n-]+?)\s*(?:-|$)/im.exec(output);
  const kind = match?.[1]?.trim() ?? "";

  if (kind === "") return null;

  return /^api key$/i.test(kind) ? "API key" : kind;
};

const decodeClaudeAuth = Schema.decodeUnknownOption(ClaudeAuthStatus);

/**
 * Claude Code: `claude auth status --json`. On a Host where Claude Code has
 * never run it creates `~/.claude.json`, so there it isn't run at all.
 */
const claude: Prober = {
  binaryEnv: "POLARIS_CLAUDE",
  binary: "claude",
  probeEnv: () => ({ DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }),
  signIn: (path, env) =>
    Effect.gen(function* () {
      const config = env.CLAUDE_CONFIG_DIR
        ? join(env.CLAUDE_CONFIG_DIR, ".claude.json")
        : join(home(env), ".claude.json");

      if (!existsSync(config))
        return { status: "needs-sign-in", detail: "Claude Code hasn't been run on this host yet" };
      const result = yield* runProbe([path, "auth", "status", "--json"], env);

      return Option.match(decodeClaudeAuth(result.stdout), {
        onNone: (): SignInState => ({
          status: "unknown",
          detail: firstLine(result.stderr) ?? "`claude auth status` gave no answer",
        }),
        onSome: (status): SignInState =>
          status.loggedIn
            ? { status: "ready", detail: null, kind: claudeSignInKind(status) }
            : { status: "needs-sign-in", detail: "not signed in" },
      });
    }),
};

const codexHome = (env: ProbeEnv): string => env.CODEX_HOME || join(home(env), ".codex");

/**
 * Codex: `codex login status` (exit 0 signed in, "Not logged in" otherwise).
 * `CODEX_HOME` is always passed explicitly: Codex then never creates it.
 */
const codex: Prober = {
  binaryEnv: "POLARIS_CODEX",
  binary: "codex",
  probeEnv: (env) => ({ CODEX_HOME: codexHome(env) }),
  signIn: (path, env) =>
    Effect.gen(function* () {
      if (!existsSync(codexHome(env)))
        return { status: "needs-sign-in", detail: "Codex hasn't been run on this host yet" };
      const result = yield* runProbe([path, "login", "status"], env);

      if (result.exitCode === 0)
        return {
          status: "ready",
          detail: null,
          kind: codexSignInKind(`${result.stdout}\n${result.stderr}`),
        };

      if (/not logged in/i.test(`${result.stderr}\n${result.stdout}`))
        return { status: "needs-sign-in", detail: "not signed in" };

      return {
        status: "unknown",
        detail: firstLine(result.stderr) ?? "`codex login status` gave no answer",
      };
    }),
};

const opencodeScratch = join(tmpdir(), "polaris-opencode-probe");

/**
 * OpenCode: `--version` only, with XDG directories in a scratch dir (it creates
 * them on any run). It needs no sign-in: its free models work without a provider.
 */
const opencode: Prober = {
  binaryEnv: "POLARIS_OPENCODE",
  binary: "opencode",
  probeEnv: () => ({
    XDG_DATA_HOME: join(opencodeScratch, "data"),
    XDG_CONFIG_HOME: join(opencodeScratch, "config"),
    XDG_STATE_HOME: join(opencodeScratch, "state"),
    XDG_CACHE_HOME: join(opencodeScratch, "cache"),
  }),
  signIn: () => Effect.succeed({ status: "ready", detail: null }),
};

/**
 * An ACP Harness has no sign-in status command; it says so only when a session
 * starts. So a Host where it has never run needs sign-in, and otherwise it's `unknown`.
 */
const acpProber = (harness: AcpHarness, name: string): Prober => ({
  binaryEnv: harness.binaryEnv,
  binary: harness.binary,
  probeEnv: () => ({}),
  scratchHomeEnv: harness.scratchHomeEnv,
  signIn: (_path, env) =>
    Effect.succeed(
      existsSync(harness.configDir(env, home(env)))
        ? { status: "unknown", detail: `${name} reports its sign-in when a session starts` }
        : { status: "needs-sign-in", detail: `${name} hasn't been run on this host yet` }
    ),
});

const PROBERS: Record<KnownHarnessKind, Prober> = {
  claude,
  codex,
  opencode,
  gemini: acpProber(GEMINI, "Gemini CLI"),
  copilot: acpProber(COPILOT, "GitHub Copilot CLI"),
};

/** The binary a Harness runs as on this Host, or null when it isn't installed. */
export const harnessBinary = (kind: KnownHarnessKind, env: ProbeEnv): string | null => {
  const prober = PROBERS[kind];
  const override = env[prober.binaryEnv];

  if (override) {
    const path = findExecutable(override, env);

    return path !== null && existsSync(path) ? path : null;
  }

  return findExecutable(prober.binary, env);
};

/** `<binary> --version`, with `scratchHomeEnv` on a fresh empty directory removed afterwards. */
const versionRun = (path: string, env: ProbeEnv, scratchHomeEnv: string | null) =>
  scratchHomeEnv === null
    ? runProbe([path, "--version"], env)
    : Effect.acquireUseRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), "polaris-probe-"))),
        (scratch) => runProbe([path, "--version"], { ...env, [scratchHomeEnv]: scratch }),
        (scratch) => Effect.sync(() => rmSync(scratch, { recursive: true, force: true }))
      );

/** The tested version, when `version` is older than it (but still at or above the minimum). */
export const olderThanTested = (entry: HarnessEntry, version: string | null): string | null =>
  version !== null && Bun.semver.order(version, entry.testedVersion) < 0
    ? entry.testedVersion
    : null;

const availability = (
  entry: HarnessEntry<KnownHarnessKind>,
  fields: Pick<HarnessAvailability, "status" | "version" | "detail" | "signInArgv"> & {
    readonly signInKind?: string | null;
  }
) =>
  new HarnessAvailability({
    harness: entry.kind,
    minVersion: entry.minVersion,
    signInKind: null,
    olderThanTested: fields.status === "outdated" ? null : olderThanTested(entry, fields.version),
    ...fields,
  });

/**
 * Not installed → outdated (below `minVersion`) → the Harness's own sign-in
 * status. A version between `minVersion` and `testedVersion` is usable, noted
 * with `olderThanTested`.
 */
export const probeHarness = Effect.fn("harness.availability.probe")(function* (
  entry: HarnessEntry<KnownHarnessKind>,
  env: ProbeEnv
) {
  const prober = PROBERS[entry.kind];
  const path = harnessBinary(entry.kind, env);

  if (path === null)
    return availability(entry, {
      status: "not-installed",
      version: null,
      detail: `${prober.binary} was not found on PATH`,
      signInArgv: null,
    });
  const probeEnv = { ...env, ...prober.probeEnv(env) };
  const signInArgv = [path, ...entry.setup.signInCommand.slice(1)];
  const run = yield* versionRun(path, probeEnv, prober.scratchHomeEnv ?? null);

  if (run.exitCode !== 0)
    return availability(entry, {
      status: "unknown",
      version: null,
      detail: firstLine(run.stderr) ?? `\`${prober.binary} --version\` failed`,
      signInArgv,
    });
  const version = parseVersion(run.stdout);

  if (version !== null && Bun.semver.order(version, entry.minVersion) < 0)
    return availability(entry, {
      status: "outdated",
      version,
      detail: `${entry.name} ${version} is older than ${entry.minVersion}`,
      signInArgv,
    });
  const signIn = yield* prober.signIn(path, probeEnv);

  const { kind, ...state } = signIn;

  return availability(entry, { ...state, signInKind: kind ?? null, version, signInArgv });
});
