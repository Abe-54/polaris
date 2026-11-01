import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { HARNESS_CATALOGUE, type KnownHarnessKind } from "@polaris/protocol";
import { Effect } from "effect";
import {
  claudeSignInKind,
  codexSignInKind,
  harnessBinary,
  parseVersion,
  type ProbeEnv,
  probeHarness,
} from "./probe.ts";
import { hostProgram } from "../../git/planted.testing.ts";
import { shellFake } from "../testing/shellFake.ts";

const dirs: Array<string> = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface FakeHost {
  readonly env: ProbeEnv;
  readonly home: string;
  readonly bin: string;
  /** The path a fake binary named `name` runs by (`name.cmd` on Windows). */
  readonly exe: (name: string) => string;
  /** Every invocation of a fake binary, one argv per line. */
  readonly calls: () => ReadonlyArray<string>;
}

const fakeHost = (): FakeHost => {
  const root = mkdtempSync(join(tmpdir(), "polaris-availability-"));
  dirs.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  const log = join(root, "calls.log");
  writeFileSync(log, "");

  return {
    env: { HOME: home, PATH: bin, TMP: tmpdir(), TEMP: tmpdir(), POLARIS_TEST_CALLS: log },
    home,
    bin,
    exe: (name) => join(bin, process.platform === "win32" ? `${name}.cmd` : name),
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
  };
};

/** A fake binary: logs its argv, then answers `--version` and the status command. */
const fakeBinary = (
  host: FakeHost,
  name: string,
  script: { version: string; status: string }
): void => {
  shellFake(
    host.bin,
    name,
    `echo "$*" >> "$POLARIS_TEST_CALLS"
if [ "$1" = "--version" ]; then
${script.version}
fi
${script.status}`
  );
};

const entry = (kind: KnownHarnessKind) => {
  const found = HARNESS_CATALOGUE.find((harness) => harness.kind === kind);

  if (found === undefined) throw new Error(`no ${kind} in the catalogue`);

  return found;
};

const probe = (kind: KnownHarnessKind, env: ProbeEnv) =>
  Effect.runPromise(probeHarness(entry(kind), env));

const claudeStatus = (loggedIn: boolean) =>
  `echo '{"loggedIn": ${loggedIn}, "authMethod": "claude.ai", "email": "someone@example.com"}'; exit ${loggedIn ? 0 : 1}`;

describe("probeHarness", () => {
  test("parses the versions the Harnesses print", () => {
    expect(parseVersion("2.1.284 (Claude Code)\n")).toBe("2.1.284");
    expect(parseVersion("codex-cli 0.158.0\n")).toBe("0.158.0");
    expect(parseVersion("codex-cli 0.159.0-alpha.2")).toBe("0.159.0-alpha.2");
    expect(parseVersion("GitHub Copilot CLI 1.0.89.\nRun 'copilot update'")).toBe("1.0.89");
    expect(parseVersion("dev build")).toBeNull();
  });

  test("a Harness missing from PATH is not installed, with no sign-in", async () => {
    const host = fakeHost();

    for (const kind of ["claude", "codex", "opencode"] as const) {
      expect(await probe(kind, host.env)).toMatchObject({
        harness: kind,
        status: "not-installed",
        version: null,
        signInArgv: null,
      });
    }
  });

  test("Claude signed in is ready; its account details never leave the probe", async () => {
    const host = fakeHost();
    writeFileSync(join(host.home, ".claude.json"), "{}");
    fakeBinary(host, "claude", {
      version: "echo '2.1.290 (Claude Code)'; exit 0",
      status: claudeStatus(true),
    });

    const result = await probe("claude", host.env);

    expect(result).toMatchObject({
      status: "ready",
      version: "2.1.290",
      minVersion: entry("claude").minVersion,
      detail: null,
      signInArgv: [host.exe("claude"), "auth", "login"],
    });
    expect(JSON.stringify(result)).not.toContain("example.com");
    expect(host.calls()).toEqual(["--version", "auth status --json"]);
  });

  test("Claude not signed in needs sign-in, with the argv of its own sign-in", async () => {
    const host = fakeHost();
    writeFileSync(join(host.home, ".claude.json"), "{}");
    fakeBinary(host, "claude", { version: "echo 2.1.283; exit 0", status: claudeStatus(false) });

    expect(await probe("claude", host.env)).toMatchObject({
      status: "needs-sign-in",
      signInArgv: [host.exe("claude"), "auth", "login"],
    });
  });

  test("Claude never run on the Host needs sign-in without running its status command", async () => {
    const host = fakeHost();
    fakeBinary(host, "claude", { version: "echo 2.1.283; exit 0", status: claudeStatus(true) });

    expect(await probe("claude", host.env)).toMatchObject({ status: "needs-sign-in" });
    expect(host.calls()).toEqual(["--version"]);
    expect(readdirSync(host.home)).toEqual([]);
  });

  test("Claude's config directory follows CLAUDE_CONFIG_DIR", async () => {
    const host = fakeHost();
    const configDir = join(host.home, "cc");
    mkdirSync(configDir);
    writeFileSync(join(configDir, ".claude.json"), "{}");
    fakeBinary(host, "claude", { version: "echo 2.1.283; exit 0", status: claudeStatus(true) });

    expect(await probe("claude", { ...host.env, CLAUDE_CONFIG_DIR: configDir })).toMatchObject({
      status: "ready",
    });
  });

  test("an answer the probe can't read is unknown, with the Harness's words", async () => {
    const host = fakeHost();
    writeFileSync(join(host.home, ".claude.json"), "{}");
    fakeBinary(host, "claude", {
      version: "echo 2.1.283; exit 0",
      status: "echo 'error: unknown command auth' >&2; exit 2",
    });

    expect(await probe("claude", host.env)).toMatchObject({
      status: "unknown",
      detail: "error: unknown command auth",
    });
  });

  test("between the minimum and the tested version it's usable, with a quiet note", async () => {
    // The versions real Hosts ran (B4c): Claude Code 2.1.272 and 2.1.282, Codex 0.154.0.
    for (const version of ["2.1.272", "2.1.282"]) {
      const host = fakeHost();
      writeFileSync(join(host.home, ".claude.json"), "{}");
      fakeBinary(host, "claude", {
        version: `echo '${version} (Claude Code)'; exit 0`,
        status: claudeStatus(true),
      });

      expect(await probe("claude", host.env)).toMatchObject({
        status: "ready",
        version,
        olderThanTested: entry("claude").testedVersion,
      });
    }

    const host = fakeHost();
    mkdirSync(join(host.home, ".codex"));
    fakeBinary(host, "codex", { version: "echo 'codex-cli 0.154.0'; exit 0", status: "exit 0" });

    expect(await probe("codex", host.env)).toMatchObject({
      status: "ready",
      version: "0.154.0",
      olderThanTested: entry("codex").testedVersion,
    });
  });

  test("the tested version or newer carries no note; a note survives needs-sign-in", async () => {
    const host = fakeHost();
    writeFileSync(join(host.home, ".claude.json"), "{}");
    const tested = entry("claude").testedVersion;
    fakeBinary(host, "claude", { version: `echo ${tested}; exit 0`, status: claudeStatus(true) });

    expect(await probe("claude", host.env)).toMatchObject({ olderThanTested: null });

    const old = fakeHost();
    writeFileSync(join(old.home, ".claude.json"), "{}");
    fakeBinary(old, "claude", { version: "echo 2.1.272; exit 0", status: claudeStatus(false) });

    expect(await probe("claude", old.env)).toMatchObject({
      status: "needs-sign-in",
      olderThanTested: tested,
    });
  });

  test("below the declared minimum is outdated, and sign-in isn't checked", async () => {
    const host = fakeHost();
    mkdirSync(join(host.home, ".codex"));
    fakeBinary(host, "codex", { version: "echo 'codex-cli 0.100.0'; exit 0", status: "exit 0" });

    expect(await probe("codex", host.env)).toMatchObject({
      status: "outdated",
      version: "0.100.0",
      minVersion: entry("codex").minVersion,
      olderThanTested: null,
    });
    expect(host.calls()).toEqual(["--version"]);
  });

  test("Codex: exit 0 is ready, 'Not logged in' needs sign-in, anything else is unknown", async () => {
    const cases = [
      { status: "echo 'Logged in using an API key - sk-***'; exit 0", expected: "ready" },
      { status: "echo 'Not logged in' >&2; exit 1", expected: "needs-sign-in" },
      { status: "echo 'Error loading configuration' >&2; exit 1", expected: "unknown" },
    ] as const;

    for (const { status, expected } of cases) {
      const host = fakeHost();
      mkdirSync(join(host.home, ".codex"));
      fakeBinary(host, "codex", { version: "echo 'codex-cli 0.158.0'; exit 0", status });

      const result = await probe("codex", host.env);

      expect(result.status).toBe(expected);
      expect(result.signInArgv).toEqual([host.exe("codex"), "login"]);
      expect(JSON.stringify(result)).not.toContain("sk-");
    }
  });

  test("Codex gets CODEX_HOME explicitly, and isn't asked when it has never run", async () => {
    const host = fakeHost();
    fakeBinary(host, "codex", {
      version: `echo "home=$CODEX_HOME" >> "$POLARIS_TEST_CALLS"; echo 'codex-cli 0.158.0'; exit 0`,
      status: "exit 0",
    });

    expect(await probe("codex", host.env)).toMatchObject({ status: "needs-sign-in" });
    expect(host.calls()).toEqual(["--version", `home=${join(host.home, ".codex")}`]);
    expect(readdirSync(host.home)).toEqual([]);
  });

  test("POLARIS_CODEX overrides PATH; a missing override is not installed", async () => {
    const host = fakeHost();
    mkdirSync(join(host.home, ".codex"));
    fakeBinary(host, "codex", { version: "echo 'codex-cli 0.158.0'; exit 0", status: "exit 0" });

    const env = { ...host.env, PATH: "", POLARIS_CODEX: host.exe("codex") };
    expect(await probe("codex", env)).toMatchObject({ status: "ready" });
    expect(await probe("codex", { ...env, POLARIS_CODEX: join(host.bin, "nope") })).toMatchObject({
      status: "not-installed",
    });
  });

  test("OpenCode is ready once installed; --version writes nothing under the user's home", async () => {
    const host = fakeHost();
    fakeBinary(host, "opencode", {
      version: `mkdir -p "$XDG_DATA_HOME/opencode"; echo "data=$XDG_DATA_HOME" >> "$POLARIS_TEST_CALLS"; echo 1.18.33; exit 0`,
      status: "exit 0",
    });

    expect(await probe("opencode", host.env)).toMatchObject({
      status: "ready",
      version: "1.18.33",
      minVersion: entry("opencode").minVersion,
      signInArgv: [host.exe("opencode"), "auth", "login"],
    });
    expect(host.calls()).toEqual([
      "--version",
      `data=${join(tmpdir(), "polaris-opencode-probe", "data")}`,
    ]);
    expect(readdirSync(host.home)).toEqual([]);
  });

  test("an OpenCode older than the driver's minimum is outdated", async () => {
    const host = fakeHost();
    fakeBinary(host, "opencode", { version: "echo 1.15.5; exit 0", status: "exit 0" });

    expect(await probe("opencode", host.env)).toMatchObject({
      status: "outdated",
      version: "1.15.5",
    });
  });

  test("an ACP Harness never run on the Host needs sign-in; otherwise it can't say", async () => {
    const host = fakeHost();
    fakeBinary(host, "copilot", {
      version: "echo 'GitHub Copilot CLI 1.0.89.'; exit 0",
      status: "",
    });

    expect(await probe("copilot", host.env)).toMatchObject({
      status: "needs-sign-in",
      version: "1.0.89",
      signInArgv: [host.exe("copilot"), "login"],
    });

    mkdirSync(join(host.home, ".copilot"));
    expect(await probe("copilot", host.env)).toMatchObject({
      status: "unknown",
      detail: "GitHub Copilot CLI reports its sign-in when a session starts",
    });
    // Only `--version` ran: an ACP Harness has no status command to ask.
    expect(host.calls()).toEqual(["--version", "--version"]);
  });

  test("Gemini CLI's --version writes into a scratch home, never the user's", async () => {
    const host = fakeHost();
    fakeBinary(host, "gemini", {
      version:
        '/bin/mkdir -p "${GEMINI_CLI_HOME:-$HOME}/.gemini" && echo "$GEMINI_CLI_HOME" >> "$POLARIS_TEST_CALLS"; echo 0.61.0; exit 0',
      status: "",
    });

    expect(await probe("gemini", host.env)).toMatchObject({
      status: "needs-sign-in",
      version: "0.61.0",
      signInArgv: [host.exe("gemini")],
    });
    expect(readdirSync(host.home)).toEqual([]);
    const [, scratch] = host.calls();
    expect(scratch).toContain("polaris-probe-");
    expect(() => readdirSync(scratch ?? "")).toThrow();
  });

  test("Gemini CLI below --acp is outdated", async () => {
    const host = fakeHost();
    fakeBinary(host, "gemini", { version: "echo 0.32.0; exit 0", status: "" });

    expect(await probe("gemini", host.env)).toMatchObject({
      status: "outdated",
      version: "0.32.0",
    });
  });

  test("a failing --version is unknown", async () => {
    const host = fakeHost();
    fakeBinary(host, "codex", { version: "echo 'segfault' >&2; exit 139", status: "exit 0" });

    expect(await probe("codex", host.env)).toMatchObject({
      status: "unknown",
      version: null,
      detail: "segfault",
    });
  });
});

test("probing loads no driver, so the Agent SDK, Codex bindings, OpenCode and ACP drivers stay unloaded (ENG-196)", async () => {
  const script = `
    const { Effect } = await import("effect");
    const { Availability } = await import("./availability/index.ts");
    await Effect.runPromise(
      Effect.flatMap(Availability, (a) => a.get(true)).pipe(
        Effect.provide(Availability.layer({ env: { PATH: "" } }))
      )
    );
    const loaded = Object.keys(require.cache).filter((k) =>
      /claude-agent-sdk|harness\\/(claude|codex|opencode)\\/|harness\\/acp\\/(?!harnesses\\.ts)/.test(k)
    );
    console.log(JSON.stringify(loaded));
  `;

  const proc = Bun.spawn([process.execPath, "-e", script], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "inherit",
  });

  expect(JSON.parse(await new Response(proc.stdout).text())).toEqual([]);
  expect(await proc.exited).toBe(0);
});

describe("sign-in kind", () => {
  test("Claude Code: the plan, an API key, or a cloud provider; never an identity", () => {
    expect(
      claudeSignInKind({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" })
    ).toBe("Claude Max");
    expect(claudeSignInKind({ loggedIn: true, authMethod: "api_key" })).toBe("API key");
    expect(claudeSignInKind({ loggedIn: true, apiProvider: "bedrock" })).toBe("Amazon Bedrock");
    expect(claudeSignInKind({ loggedIn: true, authMethod: "claude.ai" })).toBeNull();
  });

  test("Codex: how `codex login status` says it's signed in, never the key", () => {
    expect(codexSignInKind("Logged in using ChatGPT\n")).toBe("ChatGPT");
    expect(codexSignInKind("Logged in using an API key - sk-proj-***abcd\n")).toBe("API key");
    expect(codexSignInKind("")).toBeNull();
  });
});

test("a Harness is found by its absolute path: a `.` PATH entry and a relative override are the Daemon's cwd's", () => {
  const daemonCwd = mkdtempSync(join(tmpdir(), "polaris-harness-cwd-"));
  dirs.push(daemonCwd);
  const program = basename(hostProgram(daemonCwd, "claude", "x"));
  const home = process.cwd();
  process.chdir(daemonCwd);

  try {
    // A relative result would start the Workspace's own `claude` once spawned there.
    const expected = join(process.cwd(), program);

    expect([
      harnessBinary("claude", { PATH: "." }),
      harnessBinary("claude", { PATH: "", POLARIS_CLAUDE: `./${program}` }),
    ]).toEqual([expected, expected]);
  } finally {
    process.chdir(home);
  }
});
