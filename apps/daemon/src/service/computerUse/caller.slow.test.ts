/**
 * Who the helper's launcher serves (ENG-867): only the program signed as the Daemon beside it.
 * Slow tier: it copies and re-signs the test runner to get a second code identity.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";
import { launcherRuns, MAC_ONLY, makeHelper } from "./helper.testing.ts";
import type { SpawnVia } from "./index.ts";

const REFUSAL = "polaris-computer-use: refused: the caller is not the Polaris Daemon";

let root: string;

/** The test runner, as its vendor signed it. */
const vendor = realpathSync(process.execPath);

/** A copy of it signed ad hoc under another identifier: the same program, other code. */
let resigned: string;

interface Helpers {
  readonly vendor: string;
  readonly resigned: string;
}

/** A helper whose Daemon is the vendor's runner, and one whose Daemon is the re-signed copy. */
let helpers: Helpers;

const sh = async (argv: ReadonlyArray<string>) => {
  const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (code !== 0) throw new Error(`${argv.join(" ")} exited ${code}\n${stderr}`);

  return stdout;
};

let markers = 0;

/** Runs `caller.testing.ts` under `caller` against `helper`; the tool would create `marker`. */
const call = async (caller: string, helper: string, via: SpawnVia) => {
  const marker = join(root, `marker-${markers++}`);
  const script = join(import.meta.dir, "caller.testing.ts");
  const stdout = await sh([caller, script, helper, via, marker]);

  // SAFETY: caller.testing.ts prints one of these two shapes.
  const outcome = JSON.parse(stdout) as { refused?: string; stdout?: string; code?: number };

  return { ...outcome, ran: existsSync(marker) };
};

describe.skipIf(!launcherRuns)(`the helper's launcher${MAC_ONLY}`, () => {
  beforeAll(async () => {
    root = realpathSync(newTempDir("polaris-cu-", { short: true }));
    resigned = join(root, "resigned");
    await sh(["/bin/cp", "-c", vendor, resigned]);
    await sh([
      "/usr/bin/codesign",
      "--force",
      "--sign",
      "-",
      "-i",
      "com.example.not-polaris",
      resigned,
    ]);

    helpers = {
      vendor: await makeHelper(join(root, "a"), vendor),
      resigned: await makeHelper(join(root, "b"), resigned),
    };
  });

  afterAll(() => removeTempDir(root));

  describe.each<SpawnVia>(["disclaim", "launch-services"])("through %s", (via) => {
    test("runs the tool for the program signed as its Daemon", async () => {
      expect(await call(vendor, helpers.vendor, via)).toEqual({
        stdout: "marked\n",
        code: 0,
        ran: true,
      });
    });

    test("serves an ad hoc signed Daemon by its own requirement, as dev builds are", async () => {
      expect(await call(resigned, helpers.resigned, via)).toEqual({
        stdout: "marked\n",
        code: 0,
        ran: true,
      });
    });

    test("refuses the same program signed ad hoc under another name", async () => {
      const outcome = await call(resigned, helpers.vendor, via);

      expect(outcome.ran).toBe(false);
      expect(outcome.refused).toContain(`exited 77: ${REFUSAL}`);
    });

    test("refuses a program validly signed by another developer", async () => {
      const outcome = await call(vendor, helpers.resigned, via);

      expect(outcome.ran).toBe(false);
      expect(outcome.refused).toContain(`exited 77: ${REFUSAL}`);
    });
  });
});
