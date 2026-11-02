/**
 * The Reviewer against the installed `claude` and its real sandbox, driven by a fake Messages
 * API (no sign-in, no model). Opt in with `POLARIS_E2E_CLAUDE_SANDBOX=1 bun test readOnly.e2e`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { SessionId, TurnId } from "@polaris/protocol";
import { Effect, Exit, Scope, Stream } from "effect";
import { gitText } from "../../git/git.ts";
import { makeRepo, removeTempDir, tempDir, write } from "../../git/testing.ts";
import { which } from "../../service/userPath.ts";
import { readConfinement } from "../confinement.ts";
import { HarnessEvent } from "../HarnessDriver.ts";
import { makeClaudeDriver } from "./ClaudeDriver.ts";
import { bash, fakeAnthropic, type ToolCall } from "./fakeAnthropic.testing.ts";
import { readOnlyEnv, unsandboxedReadOnly } from "./readOnly.ts";

const enabled = process.env.POLARIS_E2E_CLAUDE_SANDBOX === "1";

const TOKEN = "ghp_reviewerMustNeverSeeThis";

const KEY = "sk-ant-reviewerMustNeverSeeThis";

const MARKER = "credential-marker";

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

/** A Review Checkout of a repository whose remote URL holds a token, beside a fake home. */
const layout = async () => {
  const repo = await makeRepo({ "src/a.ts": "export const a = 1;\n" });
  const base = tempDir("polaris-e2e-reviewer-");
  cleanup.push(
    () => removeTempDir(repo),
    () => removeTempDir(base)
  );
  await gitText(repo, ["remote", "add", "origin", `https://x:${TOKEN}@github.com/o/r.git`]);
  const checkout = join(base, "pr-7");
  await gitText(repo, ["worktree", "add", "-q", "--detach", checkout]);
  const home = join(base, "home");
  write(home, ".ssh/id_ed25519", `${MARKER}\n`);
  write(home, ".git-credentials", `${MARKER}\n`);
  write(base, "outside/secret.txt", `${MARKER}\n`);
  symlinkSync(join(base, "outside/secret.txt"), join(checkout, "linked.txt"));
  symlinkSync(join(home, ".ssh"), join(checkout, "ssh"));
  mkdirSync(join(base, "config"));

  return {
    repo,
    base,
    checkout,
    home: realpathSync(home),
    common: realpathSync(join(repo, ".git")),
  };
};

/** Runs one Turn of `calls` in a read-only session and returns what each call returned. */
type Layout = Awaited<ReturnType<typeof layout>>;

/** A fake Messages API for `calls`, with the Daemon's home pointed at the layout's for the test. */
const serve = (where: Layout, calls: ReadonlyArray<ToolCall>) => {
  const fake = fakeAnthropic(calls);
  const realHome = process.env.HOME;
  const realState = process.env.POLARIS_HOME;
  process.env.HOME = where.home;
  // Polaris's state, where the confined git's config is generated, under the fake home.
  process.env.POLARIS_HOME = join(where.home, ".polaris");

  cleanup.push(() => {
    process.env.HOME = realHome;

    if (realState === undefined) delete process.env.POLARIS_HOME;
    else process.env.POLARIS_HOME = realState;
    fake.stop();
  });

  return fake;
};

const providerEnv = (where: Layout, url: string) => ({
  HOME: where.home,
  ANTHROPIC_API_KEY: KEY,
  ANTHROPIC_BASE_URL: url,
  CLAUDE_CONFIG_DIR: join(where.base, "config"),
});

const review = async (where: Layout, calls: ReadonlyArray<ToolCall>) => {
  const fake = serve(where, calls);
  const driver = makeClaudeDriver();
  const scope = Effect.runSync(Scope.make());

  const session = await Effect.runPromise(
    driver
      .open({
        sessionId: SessionId.make("e2e-reviewer"),
        cwd: where.checkout,
        permissionMode: "supervised",
        model: null,
        effort: null,
        resumeCursor: null,
        readOnly: true,
        environment: providerEnv(where, fake.url),
      })
      .pipe(Scope.provide(scope))
  );

  const events: Array<HarnessEvent> = [];
  Effect.runFork(Stream.runForEach(session.events, (e) => Effect.sync(() => void events.push(e))));
  await Effect.runPromise(
    session.sendTurn({
      turnId: TurnId.make("e2e-turn"),
      prompt: "Review this change.",
      attachments: [],
      model: null,
      effort: null,
    })
  );

  for (let i = 0; i < 1800 && !events.some(HarnessEvent.$is("TurnEnded")); i++)
    await Bun.sleep(100);
  await Effect.runPromise(Scope.close(scope, Exit.void));

  return { outputs: calls.map((_, index) => fake.outputs[index] ?? ""), offered: fake.offered };
};

/** A subagent in a worktree of its own: it would run in the repository, outside the checkout. */
const worktreeAgent: ToolCall = {
  name: "Agent",
  input: { description: "probe", prompt: "probe", isolation: "worktree", run_in_background: false },
};

describe.skipIf(!enabled)("the Reviewer in Claude Code's sandbox", () => {
  test(
    "its shell runs git in the checkout, and reads no key, credential or file outside it",
    async () => {
      const where = await layout();

      const { outputs, offered } = await review(where, [
        bash("printenv ANTHROPIC_API_KEY; env | grep -c ANTHROPIC_API_KEY; echo end"),
        bash("git log --format=%s -1"),
        bash("git config --list"),
        bash("cat linked.txt"),
        bash("cat ssh/id_ed25519"),
        bash(`cat "${where.home}/.git-credentials"`),
        bash(`cat "${where.common}/config"`),
        bash("curl -sS -m 5 http://example.com && echo REACHED"),
        { name: "Read", input: { file_path: join(where.base, "outside/secret.txt") } },
        worktreeAgent,
      ]);

      const [env, log, config, linked, ssh, home, common, net, read, agent] = outputs;

      expect(env).toContain("end");
      expect(env).not.toContain(KEY);
      expect(log).toContain("initial");
      expect(config).toContain("repositoryformatversion");
      expect(config).not.toContain(TOKEN);

      for (const output of [linked, ssh, home, read]) expect(output).not.toContain(MARKER);
      expect(common).not.toContain(TOKEN);
      expect(net).not.toContain("REACHED");
      expect(agent).toContain("The reviewer only reads files inside");
      expect(new Set(offered.flat())).toEqual(new Set(["Agent", "Bash"]));
    },
    { timeout: 300_000 }
  );

  test(
    "without the sandbox Claude Code itself keeps the file tools in the checkout, with no hook of Polaris's",
    async () => {
      const where = await layout();
      const outside = join(where.base, "outside");

      const calls: ReadonlyArray<ToolCall> = [
        { name: "Read", input: { file_path: join(where.checkout, "src/a.ts") } },
        { name: "Read", input: { file_path: join(where.checkout, "linked.txt") } },
        { name: "Read", input: { file_path: join(where.checkout, "../outside/secret.txt") } },
        { name: "Read", input: { file_path: join(where.home, ".git-credentials") } },
        { name: "Read", input: { file_path: join(where.common, "config") } },
        { name: "Glob", input: { pattern: `${where.home}/.ssh/*` } },
        { name: "Glob", input: { pattern: "{../outside,src}/*" } },
        { name: "Grep", input: { pattern: MARKER, path: outside, output_mode: "content" } },
        { name: "Grep", input: { pattern: MARKER, glob: "../outside/*", output_mode: "content" } },
      ];

      const fake = serve(where, calls);
      const confinement = await readConfinement(where.checkout);
      const env = readOnlyEnv({ ...process.env, ...providerEnv(where, fake.url) }, confinement);
      const { hooks: _polaris, ...options } = unsandboxedReadOnly(confinement);

      const session = query({
        prompt: "Review this change.",
        options: {
          ...options,
          cwd: where.checkout,
          env,
          pathToClaudeCodeExecutable: which("claude") ?? "claude",
          canUseTool: async () => ({ behavior: "deny", message: "No." }),
        },
      });

      for await (const message of session) if (message.type === "result") break;
      const [inside, ...rest] = calls.map((_, index) => fake.outputs[index] ?? "");

      expect(inside).toContain("export const a = 1;");

      for (const output of rest) {
        expect(output).not.toContain(MARKER);
        expect(output).not.toContain(TOKEN);
        expect(output).not.toContain("id_ed25519");
        expect(output).not.toContain("secret.txt\n");
      }
    },
    { timeout: 300_000 }
  );
});
