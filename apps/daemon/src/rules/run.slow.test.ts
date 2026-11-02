import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gitText } from "../git/git.ts";
import { posixDescribe } from "../platform/testing.ts";
import { commitAll, makeRepo, removeDir, write } from "../git/testing.ts";
import { runRules } from "./run.ts";
import { fetchBetterleaks, hostAsset } from "./secrets/fetch.ts";
import { syntheticSecrets } from "./secrets/synthetic.ts";

const repos: Array<string> = [];

const fixtureDir = join(import.meta.dir, "fixtures");

const fixtures = Object.fromEntries(
  readdirSync(fixtureDir)
    .filter((name) => name.endsWith(".fixture"))
    .map((name) => [
      `code/${name.replace(/\.fixture$/, "")}`,
      readFileSync(join(fixtureDir, name), "utf8"),
    ])
);

const repo = async (files: Record<string, string>) => {
  const root = await makeRepo(files);
  repos.push(root);

  return root;
};

const head = (root: string) => gitText(root, ["rev-parse", "HEAD"]);

const secretsDescribe = posixDescribe(
  "no Betterleaks build for Windows: secret scanning (ENG-296)"
);

beforeAll(async () => {
  const asset = hostAsset();

  if (asset !== null) await fetchBetterleaks(asset);
}, 120_000);

afterAll(() => repos.forEach(removeDir));

secretsDescribe("runRules on a pull request (history)", () => {
  test("reports all eight secret formats as Critical and every pattern fixture, on added lines only", async () => {
    const root = await repo({ "legacy.ts": "eval(old);\nexport const a = 1;\n" });
    const base = await head(root);
    const secrets = syntheticSecrets();

    for (const secret of secrets) write(root, secret.path, secret.content);

    for (const [path, content] of Object.entries(fixtures)) write(root, path, content);
    write(root, "legacy.ts", "eval(old);\nexport const a = 2;\n");
    const tip = await commitAll(root, "add things");

    const outcome = await runRules({ cwd: root, base, head: tip, mode: "history" });

    expect(outcome.ok).toBe(true);
    expect(outcome.notes).toEqual([]);
    const byRule = new Map(outcome.findings.map((f) => [f.ruleId, f]));

    for (const secret of secrets) {
      const finding = byRule.get(secret.ruleId);
      expect(finding?.path).toBe(secret.path);
      expect(finding?.severity).toBe("critical");
      expect(finding?.lines.start).toBe(1);
    }

    expect(outcome.findings.filter((f) => f.path.startsWith("code/")).length).toBeGreaterThan(30);
    // `eval(old)` was already there: an untouched line of a changed file is not this change's risk.
    expect(outcome.findings.filter((f) => f.path === "legacy.ts")).toEqual([]);

    const stored = JSON.stringify(outcome);

    for (const secret of secrets) expect(stored).not.toContain(secret.value);
  });

  test("a secret added then removed inside the pull request is still reported", async () => {
    const root = await repo({ "README.md": "hi\n" });
    const base = await head(root);
    const [github] = syntheticSecrets();
    write(root, github!.path, github!.content);
    await commitAll(root, "oops");
    rmSync(join(root, github!.path));
    const tip = await commitAll(root, "remove it");

    const history = await runRules({ cwd: root, base, head: tip, mode: "history" });
    const snapshot = await runRules({ cwd: root, base, head: tip, mode: "snapshot" });

    expect(history.findings.map((f) => f.ruleId)).toEqual(["github-pat"]);
    expect(history.findings[0]!.reason).toContain("stays in the history");
    expect(snapshot.findings).toEqual([]);
  });
});

secretsDescribe("runRules on Agent Session Turns (snapshot)", () => {
  test("scans trees, not just commits, and keeps only added lines", async () => {
    const root = await repo({ "app.ts": "debugger;\nexport const x = 1;\n" });
    const before = await gitText(root, ["rev-parse", "HEAD^{tree}"]);
    const [, aws] = syntheticSecrets();
    write(root, "app.ts", "debugger;\nexport const x = 1;\neval(input);\n");
    write(root, aws!.path, aws!.content);
    await commitAll(root, "turn");
    const after = await gitText(root, ["rev-parse", "HEAD^{tree}"]);

    const outcome = await runRules({ cwd: root, base: before, head: after, mode: "snapshot" });

    expect(outcome.findings.map((f) => `${f.ruleId}@${f.path}:${f.lines.start}`).sort()).toEqual([
      "aws-access-token@deploy/aws.py:1",
      "js-eval@app.ts:3",
    ]);
  });

  test("low-confidence generic secrets are Medium; i18n catalogues are skipped", async () => {
    const root = await repo({ "README.md": "hi\n" });
    const base = await head(root);
    // Fixed: some random values fall under Betterleaks' entropy filter. Not a credential.
    write(root, "config.yaml", "api_key: 9f86d081884c7d659a2feaa0c55ad015\n");
    write(root, "messages/en.json", '{ "password": "Password (at least 8 characters)" }\n');
    const tip = await commitAll(root, "config");

    const outcome = await runRules({ cwd: root, base, head: tip, mode: "snapshot" });

    expect(outcome.findings.map((f) => [f.ruleId, f.path, f.severity])).toEqual([
      ["generic-api-key", "config.yaml", "medium"],
    ]);
  });

  test("identities survive a line shift; ids follow identities", async () => {
    const root = await repo({ "README.md": "hi\n" });
    const base = await head(root);
    write(root, "a.ts", "eval(input);\n");

    const first = await runRules({
      cwd: root,
      base,
      head: await commitAll(root, "one"),
      mode: "snapshot",
    });

    write(root, "a.ts", "// a comment\n\n\neval(input);\n");

    const second = await runRules({
      cwd: root,
      base,
      head: await commitAll(root, "two"),
      mode: "snapshot",
    });

    expect(second.findings[0]!.lines.start).toBe(4);
    expect(second.findings[0]!.identity).toBe(first.findings[0]!.identity);
    expect(second.findings[0]!.id).toBe(first.findings[0]!.id);
  });
});

describe("when a scanner is missing", () => {
  const saved = process.env.POLARIS_BETTERLEAKS;

  afterEach(() => {
    if (saved === undefined) delete process.env.POLARIS_BETTERLEAKS;
    else process.env.POLARIS_BETTERLEAKS = saved;
  });

  test("the patterns still run and a note says secrets were not checked", async () => {
    process.env.POLARIS_BETTERLEAKS = "/nonexistent/betterleaks";
    const root = await repo({ "README.md": "hi\n" });
    const base = await head(root);
    write(root, "a.ts", "eval(input);\n");
    const tip = await commitAll(root, "one");

    const outcome = await runRules({ cwd: root, base, head: tip, mode: "history" });

    expect(outcome.ok).toBe(true);
    expect(outcome.findings.map((f) => f.ruleId)).toEqual(["js-eval"]);
    expect(outcome.notes).toEqual([
      "Secrets were not checked: Betterleaks is not installed beside the Daemon",
    ]);
  });
});
