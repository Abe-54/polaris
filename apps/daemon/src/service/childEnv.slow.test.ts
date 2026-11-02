import { expect, test } from "bun:test";
import { repositoryEnv } from "./childEnv.ts";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeFakeCodex } from "../harness/codex/testing/fakeCodex.ts";
import { posixTest, shortTemp } from "../platform/testing.ts";

for (const phase of ["before", "after"])
  posixTest("the execve hand-off envelope, and a /bin/sh Codex wrapper (ADR 0060)")(
    `${phase} adoption, hand-off stays out of command, Codex and terminal children`,
    () => {
      const home = mkdtempSync(shortTemp("phc-"));

      try {
        const codex = makeFakeCodex(home);
        const wrapper = join(home, "codex-wrapper");
        const marker = join(home, "codex-envelope");

        writeFileSync(
          wrapper,
          `#!/bin/sh\nif [ "$1" = app-server ]; then printf '%s' "\${POLARIS_HANDOFF-unset}" > '${marker}'; fi\nexec '${codex.path}' "$@"\n`
        );
        chmodSync(wrapper, 0o755);

        const result = spawnSync(
          process.execPath,
          [join(import.meta.dir, "fixtures/handoff-children.ts")],
          {
            env: {
              ...process.env,
              POLARIS_HOME: home,
              POLARIS_TEST_CODEX: wrapper,
              POLARIS_TEST_ADOPT: phase,
              POLARIS_HANDOFF: JSON.stringify({
                listenerFd: null,
                fds: {},
                children: {},
                fromVersion: "0.0.0-test",
                requestId: null,
              }),
            },
            encoding: "utf8",
            timeout: 25_000,
          }
        );

        expect(result.error).toBeUndefined();
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    30_000
  );

test("a repository's child keeps PATH under the Daemon's casing, with only its absolute entries", () => {
  // A shell reads an empty or relative entry as its cwd, the repository.
  const [source, expected] =
    process.platform === "win32"
      ? [
          { Path: "C:\\Tools\\cmd;;.;bin;C:\\Windows", GITHUB_TOKEN: "t" },
          { Path: "C:\\Tools\\cmd;C:\\Windows", NoDefaultCurrentDirectoryInExePath: "1" },
        ]
      : [{ PATH: "/usr/bin::.:bin:/bin", GITHUB_TOKEN: "t" }, { PATH: "/usr/bin:/bin" }];

  expect(repositoryEnv(source)).toEqual(expected);
});
