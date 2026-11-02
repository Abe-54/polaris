import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { posixTest } from "../../platform/testing.ts";
import { baseEnv, gitText, runGitRaw } from "../git.ts";
import { makeRepo, removeTempDir, tempDir, write } from "../testing.ts";
import { GitLazyFetchUnsupported, safeConfigEnv } from "./index.ts";

const cleanup: Array<string> = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) removeTempDir(dir);
});

const dir = (made: string) => {
  cleanup.push(made);

  return made;
};

/** A blobless clone of a repository whose file blob it never fetched. */
const blobless = async () => {
  const origin = dir(await makeRepo({ "a.txt": "secret-free content\n" }));
  await gitText(origin, ["config", "uploadpack.allowFilter", "true"]);
  const parent = dir(tempDir("polaris-partial-"));
  const clone = join(parent, "clone");

  await gitText(
    parent,
    ["clone", "-q", "--no-checkout", "--filter=blob:none", `file://${origin}`, clone],
    { config: "host" }
  );

  return { clone, parent };
};

/** A script that leaves `ran` in `markers`, then does what `then` says. */
const marker = (markers: string, then: string) => {
  // Forward slashes: Git for Windows reads config values and runs commands through sh.
  const path = join(markers, "marker.sh").replaceAll("\\", "/");
  write(markers, "marker.sh", `#!/bin/sh\ntouch "${markers.replaceAll("\\", "/")}/ran"\n${then}\n`);
  chmodSync(path, 0o755);

  return path;
};

describe("automatic git in a partial clone", () => {
  test("reading a missing object never fetches, so the remote's upload-pack never runs", async () => {
    const { clone } = await blobless();
    const markers = dir(tempDir("polaris-markers-"));

    await gitText(clone, [
      "config",
      "remote.origin.uploadpack",
      marker(markers, 'exec git-upload-pack "$@"'),
    ]);

    const read = await runGitRaw(clone, ["cat-file", "-p", "HEAD:a.txt"]);

    expect(read.code).not.toBe(0);
    expect(existsSync(join(markers, "ran"))).toBe(false);

    // The control: git the user asked for still lazy-fetches, through that upload-pack.
    const host = await runGitRaw(clone, ["cat-file", "-p", "HEAD:a.txt"], { config: "host" });

    expect(new TextDecoder().decode(host.stdout)).toBe("secret-free content\n");
    expect(existsSync(join(markers, "ran"))).toBe(true);
  });

  posixTest("the PATH git shim that reports an old version is a sh script (ENG-318)")(
    "a git too old to turn lazy fetch off refuses a partial clone, and reads a full one",
    async () => {
      const { clone } = await blobless();
      const full = dir(await makeRepo({ "a.txt": "a\n" }));
      const bin = dir(tempDir("polaris-old-git-"));
      const real = Bun.which("git") ?? "git";
      const old = `if [ "$1" = "--version" ]; then echo "git version 2.43.0"; exit 0; fi\nexec "${real}" "$@"`;
      write(bin, "git", `#!/bin/sh\n${old}\n`);
      chmodSync(join(bin, "git"), 0o755);
      const env = { ...baseEnv(), PATH: `${bin}:${process.env.PATH ?? ""}` };

      await Promise.resolve(
        expect(safeConfigEnv(clone, env)).rejects.toBeInstanceOf(GitLazyFetchUnsupported)
      );
      expect((await safeConfigEnv(full, env)).GIT_NO_LAZY_FETCH).toBe("1");
    }
  );
});
