import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { Schema } from "effect";

const OXLINT = join(import.meta.dir, "../../../node_modules/.bin/oxlint");

const Report = Schema.Struct({
  diagnostics: Schema.Array(
    Schema.Struct({
      code: Schema.String,
      filename: Schema.String,
      labels: Schema.optional(
        Schema.Array(Schema.Struct({ span: Schema.Struct({ line: Schema.Number }) }))
      ),
    })
  ),
});

/** Spawning oxlint with its JS plugins takes several seconds on a cold CI runner. */
const SPAWN_TIMEOUT_MS = 30_000;

/** Runs oxlint on one plugin's fixtures with that plugin's fixture config. */
function lintFixtures(plugin: string) {
  const dir = join(import.meta.dir, plugin, "test");

  const run = Bun.spawnSync(
    [OXLINT, "-c", "fixtures.oxlintrc.json", "--format", "json", "fixtures"],
    { cwd: dir }
  );

  const report = Schema.decodeUnknownSync(Schema.fromJsonString(Report))(run.stdout.toString());

  return report.diagnostics;
}

/** Each security rule's reports as `file:line`, sorted. */
const securityReports = (rule: string) =>
  lintFixtures("security")
    .filter((d) => d.code === `security(${rule})`)
    .map((d) => `${d.filename.replace("fixtures/", "")}:${d.labels?.[0]?.span.line ?? 0}`)
    .sort();

const lines = (file: string, numbers: ReadonlyArray<number>) =>
  numbers.map((line) => `${file}:${line}`);

describe("security plugin: each guard reports what was planted, and nothing allowlisted or exempt", () => {
  test.each([
    [
      "git-spawn",
      [
        ...lines("daemon/spawns.ts", [6, 10, 11, 12, 13, 14, 15, 16, 17, 18]),
        // An allowlisted safe-path user that stopped calling safeConfigEnv.
        "daemon/unsafe-stream.ts:2",
        // The gate starting a bare `git`.
        ...lines("daemon/git/git.ts", [12, 13]),
      ],
    ],
    ["git-config-mode", lines("daemon/host-config.ts", [6, 7, 8])],
    ["image-decode", lines("renderer/decodes.tsx", [2, 7, 8, 9, 10, 11, 12, 13])],
    ["repository-env", lines("setup/run.ts", [8, 9, 10, 11])],
    [
      "spawn-path",
      [
        ...lines("programs/spawns.ts", [12, 13, 14, 15, 16, 17, 18, 19, 20, 21]),
        // Allowlisted "resolved": a bare literal and Bun.which still report.
        ...lines("programs/resolved.ts", [6, 7]),
      ],
    ],
  ])(
    "security/%s",
    (rule, expected) => {
      expect(securityReports(rule)).toEqual([...expected].sort());
    },
    SPAWN_TIMEOUT_MS
  );
});

describe("custom oxlint plugins", () => {
  test(
    "polaris/no-long-comment reports each over-long group once",
    () => {
      const diagnostics = lintFixtures("polaris").filter(
        (d) => d.code === "polaris(no-long-comment)"
      );

      expect(diagnostics.filter((d) => !d.filename.endsWith("long-comment.ts"))).toEqual([]);
      expect(diagnostics).toHaveLength(4);
    },
    SPAWN_TIMEOUT_MS
  );

  test(
    "polaris/no-fixed-sleep reports fixed sleeps over 50 ms, outside races and TestClock",
    () => {
      const lines = lintFixtures("polaris")
        .filter((d) => d.code === "polaris(no-fixed-sleep)")
        .map((d) => `${d.filename}:${d.labels?.[0]?.span.line ?? 0}`)
        .sort();

      // A multi-line sleep reports on its first line; the silent function's lines never report.
      const reported = [12, 13, 14, 15, 16, 17, 18, 19, 20, 23, 24, 25, 26, 27, 28];

      expect(lines).toEqual(
        [
          "fixtures/fixed-sleep-testclock.testing.ts:10",
          ...reported.map((line) => `fixtures/fixed-sleep.testing.ts:${line}`),
        ].sort()
      );
    },
    SPAWN_TIMEOUT_MS
  );

  test(
    "polaris/no-fixed-sleep applies to test files and test helpers only",
    () => {
      const root = mkdtempSync(join(tmpdir(), "no-fixed-sleep-"));
      const config = join(import.meta.dir, "polaris/test/fixtures.oxlintrc.json");

      const files = [
        "a.test.ts",
        "b.slow.test.ts",
        "c.test.tsx",
        "d.testing.ts",
        "testing.ts",
        "testing/fake.ts",
        "src/daemon.ts",
        "src/fixture.tsx",
        "src/contest.ts",
      ];

      for (const file of files) {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), "export const pause = () => Bun.sleep(1000);\n");
      }

      const run = Bun.spawnSync([OXLINT, "-c", config, "--format", "json", "."], { cwd: root });
      const report = Schema.decodeUnknownSync(Schema.fromJsonString(Report))(run.stdout.toString());

      expect(report.diagnostics.map((d) => relative(".", d.filename)).sort()).toEqual([
        "a.test.ts",
        "b.slow.test.ts",
        "c.test.tsx",
        "d.testing.ts",
        "testing.ts",
        "testing/fake.ts",
      ]);
    },
    SPAWN_TIMEOUT_MS
  );

  test(
    "polaris/await-expect-promise reports only unawaited rejects and resolves",
    () => {
      const diagnostics = lintFixtures("polaris").filter(
        (d) => d.code === "polaris(await-expect-promise)"
      );

      expect(diagnostics.map((d) => d.filename)).toEqual([
        "fixtures/unawaited-expect.ts",
        "fixtures/unawaited-expect.ts",
        "fixtures/unawaited-expect.ts",
      ]);
    },
    SPAWN_TIMEOUT_MS
  );

  test(
    "polaris/effect-cleanup-return reports effects that may return a non-function",
    () => {
      const lines = lintFixtures("polaris")
        .filter((d) => d.code === "polaris(effect-cleanup-return)")
        .map((d) => `${d.filename}:${d.labels?.[0]?.span.line ?? 0}`);

      expect(lines).toEqual([
        "fixtures/effect-cleanup.tsx:9",
        "fixtures/effect-cleanup.tsx:10",
        "fixtures/effect-cleanup.tsx:11",
        "fixtures/effect-cleanup.tsx:12",
      ]);
    },
    SPAWN_TIMEOUT_MS
  );

  test(
    "polaris/no-ptr-argument reports bun:ffi ptr() passed straight to a call, however imported",
    () => {
      const lines = lintFixtures("polaris")
        .filter((d) => d.code === "polaris(no-ptr-argument)")
        .map((d) => `${d.filename}:${d.labels?.[0]?.span.line ?? 0}`);

      // Typed arrays, a stored BigInt(ptr()) and an offset ptr() kept in a const stay silent.
      expect(lines).toEqual([7, 8, 9, 10].map((line) => `fixtures/ptr-argument.ts:${line}`));
    },
    SPAWN_TIMEOUT_MS
  );

  test(
    "sonarjs/cognitive-complexity reports only the tangled function",
    () => {
      const diagnostics = lintFixtures("sonarjs");

      expect(diagnostics.map((d) => [d.code, d.filename])).toEqual([
        ["sonarjs(cognitive-complexity)", "fixtures/complex.ts"],
      ]);
    },
    SPAWN_TIMEOUT_MS
  );
});
