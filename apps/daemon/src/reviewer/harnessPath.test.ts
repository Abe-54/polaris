/**
 * Under systemd the Daemon starts with a bare PATH; `polaris serve` merges the
 * user's directories into it (`userPath`). The Reviewer's Harness, and the
 * sandbox tools its checks need on Linux, must be found there (b8eecb7).
 */
import { afterEach, describe, expect } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionId } from "@polaris/protocol";
import { Effect, Exit, Scope } from "effect";
import { tempDir } from "../engine/testing.ts";
import { removeTempDir } from "../git/testing.ts";
import { FakeClaude } from "../harness/claude/fakeClaude.ts";
import { makeClaudeDriver } from "../harness/claude/ClaudeDriver.ts";
import { userPath, which } from "../service/userPath.ts";
import { probeClaudeSandbox } from "../harness/claude/sandbox.ts";
import { reviewerShell } from "./policy.ts";
import { posixTest } from "../platform/testing.ts";

const onLinux = () => probeClaudeSandbox({ platform: "linux", find: which });

const cleanup: Array<string> = [];

const original = process.env.PATH;

afterEach(() => {
  process.env.PATH = original;

  for (const dir of cleanup.splice(0)) removeTempDir(dir);
});

const stub = (dir: string, name: string, script: string) => {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);

  return path;
};

describe("the Reviewer under a bare systemd PATH", () => {
  posixTest(
    "systemd's bare PATH and the Linux sandbox tools (bwrap, socat) aren't Windows'; its Reviewer sandbox is ENG-296's"
  )(
    "finds Claude Code and the sandbox tools in the user's directories",
    async () => {
      const home = tempDir();
      cleanup.push(home);
      const bin = join(home, ".local", "bin");
      mkdirSync(bin, { recursive: true });
      const claude = stub(bin, "claude", 'echo "2.1.0 (Claude Code)"');
      stub(bin, "bwrap", "exit 0");
      stub(bin, "socat", "exit 0");

      // What runServe does at start: the service's bare PATH, merged with the user's.
      process.env.PATH = userPath({ env: { HOME: home, PATH: "/usr/bin:/bin", SHELL: "" } });

      const fake = new FakeClaude();
      const driver = makeClaudeDriver({ query: fake.query, stagingDir: join(home, "staging") });
      const probe = await Effect.runPromise(driver.probe);

      expect(probe).toMatchObject({ available: true, detail: claude });

      const scope = Effect.runSync(Scope.make());
      await Effect.runPromise(
        driver
          .open({
            sessionId: SessionId.make("reviewer"),
            cwd: home,
            permissionMode: "supervised",
            model: null,
            effort: null,
            resumeCursor: null,
            readOnly: true,
          })
          .pipe(Scope.provide(scope))
      );

      expect(fake.options?.pathToClaudeCodeExecutable).toBe(claude);
      expect(reviewerShell("claude", onLinux)).toBe("checks");
      await Effect.runPromise(Scope.close(scope, Exit.void));

      process.env.PATH = "/usr/bin:/bin";
      expect(reviewerShell("claude", onLinux)).toBe("none");
      // It starts real stub processes, which take seconds to launch on a loaded macOS runner.
    },
    15_000
  );
});
