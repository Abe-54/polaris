import { describe, expect, test } from "bun:test";
import { runOnHermes } from "../../scripts/hermes.ts";
import { hermesVersion, hermesVmPath } from "../../scripts/hermesPaths.ts";
import listed from "./hermesMissing.json" with { type: "json" };
import { runSelfCheck } from "./selfCheck.ts";

const vmBuilt = await Bun.file(hermesVmPath(hermesVersion())).exists();

const run = runOnHermes();

const failures = (results: ReadonlyArray<{ ok: boolean; name: string; detail: string }>) =>
  results.flatMap((result) => (result.ok ? [] : [`${result.name}: ${result.detail}`]));

describe("the shared runtime on Hermes", () => {
  test("hermesc compiles Effect 4, the protocol and the client runtime", async () => {
    const { compiled } = await run;

    expect(compiled.output).toBe("");
    expect(compiled.ok).toBe(true);
  }, 120_000);

  // Without the VM (`bun run hermes:build`), only the compile check above runs.
  test.skipIf(!vmBuilt)(
    "every self-check passes on the hermes VM",
    async () => {
      const { results, vmOutput } = await run;

      expect(results?.length, vmOutput).toBe(7);
      expect(failures(results ?? [])).toEqual([]);
    },
    120_000
  );

  // The test preload strips this list from Bun; a stale list hides a missing builtin.
  test.skipIf(!vmBuilt)(
    "hermesMissing.json lists every builtin Bun has and the hermes VM lacks",
    async () => {
      const { missing } = await run;

      expect(missing).toEqual(listed);
    },
    120_000
  );

  test("every self-check passes on Bun, so a failure on Hermes is the engine's", async () => {
    expect(failures(await runSelfCheck())).toEqual([]);
  });
});
