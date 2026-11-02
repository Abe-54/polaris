import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { posixTest } from "../platform/testing.ts";
import { tempDirectory } from "./tempDirectories.testing.ts";

const directory = fileURLToPath(new URL(".", import.meta.url));

const runSuite = async (files: ReadonlyArray<string>, root: string) => {
  const child = Bun.spawn([process.execPath, "test", ...files], {
    cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
    env: {
      ...process.env,
      TMPDIR: root,
      POLARIS_PBT_RUNS: "2",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return { code, output: stdout + stderr };
};

const fixture = () => {
  const root = tempDirectory(join(tmpdir(), "polaris-temp-guard-"));
  const temp = join(root, "temp");
  mkdirSync(temp);

  return { root, temp };
};

test("temp helpers release directories after success, assertion failure and scope cancellation", async () => {
  const { root, temp } = fixture();
  const file = join(root, "cleanup.test.ts");
  writeFileSync(
    file,
    `import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber } from ${JSON.stringify(fileURLToPath(import.meta.resolve("effect")))};
import { tempDirectory, scopedTempDirectory } from ${JSON.stringify(join(directory, "tempDirectories.testing.ts"))};
import { fakeRepo } from ${JSON.stringify(join(directory, "../engine/testing.ts"))};
import { tempDir, suiteTempDir } from ${JSON.stringify(join(directory, "../git/testing.ts"))};
describe("suite lifetime", () => {
  let shared;
  const createShared = suiteTempDir("polaris-shared-");
  beforeAll(() => { shared = createShared(); });
  test("first", () => { expect(existsSync(shared)).toBe(true); });
  test("second", () => { expect(existsSync(shared)).toBe(true); });
});
let released;
test("success", () => { released = tempDirectory(join(tmpdir(), "polaris-store-")); });
test("failure", () => {
  expect(existsSync(released)).toBe(false);
  fakeRepo();
  tempDir("polaris-author-");
  tempDir("polaris-user-");
  throw new Error("intentional cleanup regression fixture");
});
test("scope failure and interruption", async () => {
  let failed;
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    failed = yield* scopedTempDirectory(join(tmpdir(), "polaris-proof-"));
    return yield* Effect.fail("intentional scoped failure");
  })).pipe(Effect.ignore));
  expect(existsSync(failed)).toBe(false);
  let interrupted;
  let ready;
  const acquired = new Promise(resolve => { ready = resolve; });
  const fiber = Effect.runFork(Effect.scoped(Effect.gen(function* () {
    interrupted = yield* scopedTempDirectory(join(tmpdir(), "polaris-proof-"));
    yield* Effect.sync(() => ready());
    yield* Effect.never;
  })));
  await acquired;
  await Effect.runPromise(Fiber.interrupt(fiber));
  expect(existsSync(interrupted)).toBe(false);
});
`
  );
  const result = await runSuite([file], temp);
  expect(result.output).toContain("intentional cleanup regression fixture");
  expect(result.code).toBe(1);
  expect(result.output).toContain("4 pass");
  expect(readdirSync(temp).filter((name) => name.startsWith("polaris-"))).toEqual([]);
});

posixTest(
  "Windows bug: engine.model.slow.test.ts's EventStore SQLite files stay open after a crash and restart (EBUSY)"
)(
  "representative Engine, PBT, Git, composition and store suites leave no temp directories",
  async () => {
    const { temp } = fixture();

    const files = [
      "../engine/Engine.followups.test.ts",
      "../store/EventStore.bounded.test.ts",
      "../files/search/fffSearch.test.ts",
      "../git/review/worktree.slow.test.ts",
      "../reviewer/compose.test.ts",
      "engine.model.slow.test.ts",
      "store.model.slow.test.ts",
    ].map((file) => join(directory, file));

    const result = await runSuite(files, temp);
    expect(result.output).toContain("0 fail");
    expect(result.code).toBe(0);
    expect(readdirSync(temp).filter((name) => name.startsWith("polaris-"))).toEqual([]);
  },
  120_000
);
