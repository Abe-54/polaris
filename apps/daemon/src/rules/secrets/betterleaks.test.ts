import { afterEach, beforeAll, expect, test } from "bun:test";
import { chmodSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gitText } from "../../git/git.ts";
import { posixDescribe } from "../../platform/testing.ts";
import { commitAll, makeRepo, removeTempDir, tempDir, write } from "../../git/testing.ts";
import { scanSecrets } from "./betterleaks.ts";
import { fetchBetterleaks, hostAsset } from "./fetch.ts";
import { syntheticSecrets } from "./synthetic.ts";

const cleanup: Array<string> = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) removeTempDir(dir);
});

const dir = (made: string) => {
  cleanup.push(made);

  return made;
};

const executable = (root: string, name: string, body: string) => {
  write(root, name, `#!/bin/sh\n${body}\n`);
  chmodSync(join(root, name), 0o755);

  return join(root, name);
};

let binary = "";

beforeAll(async () => {
  const asset = hostAsset();

  if (asset !== null) binary = await fetchBetterleaks(asset);
}, 120_000);

posixDescribe("no Betterleaks build for Windows: secret scanning (ENG-296)")(
  "Betterleaks' own git",
  () => {
    test("a history scan runs none of the diff drivers the repository's config names", async () => {
      const root = dir(await makeRepo({ ".gitattributes": "*.env diff=evil\n" }));
      const base = await gitText(root, ["rev-parse", "HEAD"]);
      const markers = dir(tempDir("polaris-markers-"));
      const body = `touch "${markers}/textconv.ran"\ncat "$1"`;

      await gitText(root, [
        "config",
        "diff.evil.textconv",
        executable(markers, "textconv.sh", body),
      ]);
      const secret = syntheticSecrets()[0];

      if (secret === undefined) throw new Error("no synthetic secret");
      write(root, "creds.env", secret.content);
      const head = await commitAll(root, "add creds");

      const scan = await scanSecrets(
        binary,
        root,
        { kind: "history", base, head },
        new AbortController().signal
      );

      expect(readdirSync(markers).filter((f) => f.endsWith(".ran"))).toEqual([]);
      expect(scan.hits.map((hit) => hit.ruleId)).toContain(secret.ruleId);
    });

    test("gets the safe config, no lazy fetch, and none of the Daemon's agent or tokens", async () => {
      const root = dir(await makeRepo({ "a.txt": "a\n" }));
      const out = dir(tempDir("polaris-fake-betterleaks-"));
      const report = `{"schema_version":"1","findings":null,"scan":{"state":"complete","betterleaks_version":"fake"}}`;
      const fake = executable(out, "betterleaks", `env > "${out}/env"\necho '${report}'`);
      const saved = { sock: process.env.SSH_AUTH_SOCK, token: process.env.GITHUB_TOKEN };
      process.env.SSH_AUTH_SOCK = "/nonexistent/agent.sock";
      process.env.GITHUB_TOKEN = "not-a-real-token";

      try {
        await scanSecrets(fake, root, { kind: "files" }, new AbortController().signal);
      } finally {
        for (const [key, value] of [
          ["SSH_AUTH_SOCK", saved.sock],
          ["GITHUB_TOKEN", saved.token],
        ] as const) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }

      const env = new Map(
        readFileSync(join(out, "env"), "utf8")
          .split("\n")
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)])
      );

      const pairs = Array.from({ length: Number(env.get("GIT_CONFIG_COUNT")) }, (_, i) =>
        [env.get(`GIT_CONFIG_KEY_${i}`), env.get(`GIT_CONFIG_VALUE_${i}`)].join("=")
      );

      expect(env.has("SSH_AUTH_SOCK")).toBe(false);
      expect(env.has("GITHUB_TOKEN")).toBe(false);
      expect(env.get("GIT_NO_LAZY_FETCH")).toBe("1");
      expect(pairs).toContain("protocol.ext.allow=never");
      expect(pairs).toContain("core.hooksPath=/dev/null");
    });
  }
);
