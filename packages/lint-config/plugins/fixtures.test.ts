import { describe, expect, test } from "bun:test";
import { join } from "node:path";
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
