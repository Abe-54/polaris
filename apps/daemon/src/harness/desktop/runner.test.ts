/**
 * The runner through the real computer use launcher (D6's Mach hand-off), with a shell script
 * standing in for agent-desktop. macOS only, like the launcher's own tests.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { Effect } from "effect";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";
import { makeHelper } from "../../service/computerUse/helper.testing.ts";
import { ComputerUseHelper } from "../../service/computerUse/index.ts";
import { execHelper } from "../../service/computerUse/launch.ts";
import { helperRunner } from "./runner.ts";

let root: string;

let helper: string;

beforeAll(async () => {
  root = realpathSync(newTempDir("polaris-cud-", { short: true }));
  // This test run stands in for the Daemon: the launcher serves the program beside it.
  helper = await makeHelper(root, process.execPath);
});

afterAll(() => removeTempDir(root));

const run = (args: ReadonlyArray<string>, env: Record<string, string>, signal?: AbortSignal) =>
  Effect.runPromise(
    Effect.flatMap(helperRunner, (runner) => runner.run(args, env, signal)).pipe(
      Effect.provide(ComputerUseHelper.layerAt(() => helper, { launch: execHelper }))
    )
  );

describe.skipIf(process.platform !== "darwin")("agent-desktop inside the helper", () => {
  test("gets its arguments and the Host's display env, and answers its stdout", async () => {
    const stdout = await run(["facts", "--session", "run-7"], { POLARIS_TEST_VAR: "display" });

    expect(stdout.split("\n").slice(0, 3)).toEqual(["--session", "run-7", "display"]);
  });

  test("an aborted call stops the tool instead of waiting it out", async () => {
    const controller = new AbortController();
    const running = run(["hang"], {}, controller.signal);
    controller.abort();

    expect(await running).toBeString();
  });
});
