import { expect, test } from "bun:test";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { Attempt, Constellation, ConstellationSettings } from "@polaris/protocol";
import { Effect, Struct } from "effect";
import { gitText } from "../git/git.ts";
import { commitAll, makeRepo, write } from "../git/testing.ts";
import { AT, CID, HOST, LEAD, WS, draft, report } from "../engine/constellation.testing.ts";
import { mergeClaim } from "./merge.ts";
import { staleNotices } from "./regenerate.ts";

const WORK_MS = 60_000;

const manifest = (name: string) =>
  JSON.stringify({
    name: "fixture",
    private: true,
    workspaces: ["pkg"],
    // Accept must never run it.
    scripts: { licenses: "touch ran-licenses" },
    description: name,
  });

/** A Lead repository and a worker branch, each side writing `ours` and `theirs` over the base. */
const setup = async (
  theirs: Record<string, string>,
  ours: Record<string, string>,
  worker: (root: string) => void = () => {}
) => {
  const root = await makeRepo({
    "package.json": manifest("base"),
    "pkg/package.json": JSON.stringify({ name: "fixture-pkg" }),
    "bun.lock": "base\n",
    "THIRD_PARTY_NOTICES.md": "base\n",
  });

  await gitText(root, ["checkout", "-q", "-b", "polaris/A"]);

  for (const [path, content] of Object.entries(theirs)) write(root, path, content);
  worker(root);
  const head = await commitAll(root, "worker");
  await gitText(root, ["checkout", "-q", "main"]);

  for (const [path, content] of Object.entries(ours)) write(root, path, content);
  const before = await commitAll(root, "lead");

  const attempt = Attempt.make(
    Struct.assign(draft(), { state: "review" as const, claim: report("polaris/A", head) })
  );

  const graph = Constellation.make({
    id: CID,
    hostId: HOST,
    leadSessionId: LEAD,
    workspaceId: WS,
    name: "test",
    state: "running",
    revision: 1,
    settings: ConstellationSettings.make({}),
    tasks: [],
    attempts: [attempt],
    pendingNotifications: [],
    createdAt: AT,
    updatedAt: AT,
  });

  const result = await Effect.runPromise(
    mergeClaim(graph, attempt, root, head).pipe(
      Effect.match({ onFailure: (e) => ({ error: e }), onSuccess: (ok) => ({ ok }) })
    )
  );

  return { root, head, before, result };
};

const conflicting = { "bun.lock": "worker\n", "THIRD_PARTY_NOTICES.md": "worker\n" };

const leadSide = { "bun.lock": "lead\n", "THIRD_PARTY_NOTICES.md": "lead\n", "lead.txt": "x\n" };

test(
  "Accept's merge regenerates a conflicting lockfile, keeps the Lead's notices, runs no repo script and writes no node_modules and flags them stale",
  async () => {
    const s = await setup({ ...conflicting, "work.txt": "worker\n" }, leadSide);

    expect(s.result).toMatchObject({ ok: { merged: true, findings: [staleNotices] } });
    expect(await gitText(s.root, ["rev-parse", "HEAD^1", "HEAD^2"])).toBe(`${s.before}\n${s.head}`);
    expect(readFileSync(join(s.root, "bun.lock"), "utf8")).toContain('"fixture-pkg"');
    expect(readFileSync(join(s.root, "THIRD_PARTY_NOTICES.md"), "utf8")).toBe("lead\n");
    expect(existsSync(join(s.root, "ran-licenses"))).toBe(false);
    expect(existsSync(join(s.root, "node_modules"))).toBe(false);
    expect(await gitText(s.root, ["status", "--porcelain", "--untracked-files=no"])).toBe("");
  },
  WORK_MS
);

test.each([
  ["bunfig.toml"],
  [".npmrc"],
  [".env"],
  [".env.local"],
  ["BUNFIG.toml"],
  ["pkg/.npmrc"],
  ["node_modules/x/index.js"],
  ["dé/.npmrc"],
  ["node_modules/é.js"],
  ["ü/.npmrc"],
])(
  "Accept's merge installs nothing from a branch that changes %s and refuses the conflict",
  async (config) => {
    const s = await setup({ ...conflicting, [config]: "changed\n" }, leadSide);

    expect(s.result).toMatchObject({ error: { code: "E-MERGE-CONFLICT" } });
    expect("error" in s.result && s.result.error.message).toContain(
      `the merged branch changes ${config}`
    );
    expect(existsSync(join(s.root, "node_modules"))).toBe(false);
    expect(await gitText(s.root, ["rev-parse", "HEAD"])).toBe(s.before);
    expect(await gitText(s.root, ["status", "--porcelain", "--untracked-files=no"])).toBe("");
  },
  WORK_MS
);

test.each([
  [
    "both sides change a manifest",
    { "package.json": manifest("worker") },
    { "pkg/package.json": "{}" },
    [staleNotices],
  ],
  [
    "only the worker changes one",
    { "package.json": manifest("worker") },
    { "lead.txt": "x\n" },
    [],
  ],
  ["neither does", { "work.txt": "w\n" }, { "lead.txt": "x\n" }, []],
])(
  "a clean merge where %s records the matching findings",
  async (_, theirs, ours, findings) => {
    const s = await setup(theirs, ours);

    expect(s.result).toMatchObject({ ok: { merged: true } });
    expect("ok" in s.result && s.result.ok.findings).toEqual(findings);
  },
  WORK_MS
);

test(
  "Accept's merge installs nothing from a branch that adds a symlink",
  async () => {
    const s = await setup({ ...conflicting }, leadSide, (root) =>
      symlinkSync("/tmp", join(root, "pkg/escape"))
    );

    expect("error" in s.result && s.result.error.message).toContain(
      "the merged branch changes pkg/escape"
    );
    expect(existsSync(join(s.root, "node_modules"))).toBe(false);
  },
  WORK_MS
);

test.each([
  ["a file: path", "file:../../outside"],
  ["a git URL", "git+ssh://git@example.com/x.git"],
  ["a GitHub shorthand", "someone/thing"],
  ["a tarball URL", "https://example.com/x.tgz"],
])(
  "Accept's merge installs nothing from a branch that adds %s dependency",
  async (_, spec) => {
    const s = await setup(
      {
        ...conflicting,
        "pkg/package.json": JSON.stringify({ name: "fixture-pkg", dependencies: { x: spec } }),
      },
      leadSide
    );

    expect("error" in s.result && s.result.error.message).toContain(
      `pkg/package.json: dependencies.x@${spec}`
    );
    expect(existsSync(join(s.root, "node_modules"))).toBe(false);
  },
  WORK_MS
);

test.each([
  [
    "a catalog entry from git",
    JSON.stringify({ name: "fixture-pkg", catalog: { x: "github:a/b" } }),
    "pkg/package.json: catalog.x@github:a/b",
  ],
  [
    "a dependency map that isn't flat",
    JSON.stringify({ name: "fixture-pkg", dependencies: { x: { nested: "file:../x" } } }),
    "pkg/package.json: dependencies.x.nested@file:../x",
  ],
  [
    "changed workspace globs",
    JSON.stringify({ name: "fixture-pkg", workspaces: ["../../elsewhere/*"] }),
    "pkg/package.json: workspaces",
  ],
  [
    "a dotted key that shadows a nested one",
    JSON.stringify({ name: "fixture-pkg", dependencies: { "a.b": "^1", a: { b: "file:../x" } } }),
    "pkg/package.json: dependencies.a.b@file:../x",
  ],
  [
    "a manifest that isn't strict JSON",
    "{ name: 'fixture-pkg', }",
    "pkg/package.json: not valid JSON",
  ],
])(
  "Accept's merge installs nothing from a branch whose manifest has %s",
  async (_, manifest, reason) => {
    const s = await setup({ ...conflicting, "pkg/package.json": manifest }, leadSide);

    expect("error" in s.result && s.result.error.message).toContain(reason);
    expect(existsSync(join(s.root, "node_modules"))).toBe(false);
  },
  WORK_MS
);
