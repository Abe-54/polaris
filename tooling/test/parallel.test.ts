import { describe, expect, test } from "bun:test";
import { defaultWorkers, parallelFlags } from "./parallel.ts";

const mac = { cores: 12 };

describe("the local --parallel default", () => {
  test.each([
    ["a 12-core Mac uses half its cores", { cores: 12 }, 6],
    ["a 5-core machine rounds down", { cores: 5 }, 2],
    ["a single core still uses 2", { cores: 1 }, 2],
  ])("%s", (_, machine, workers) => {
    expect(defaultWorkers(machine)).toBe(workers);
  });

  test.each([
    ["the default locally", [], {}, ["--parallel=6"]],
    ["the override", [], { POLARIS_TEST_PARALLEL: "4" }, ["--parallel=4"]],
    ["nothing when the override is 1", [], { POLARIS_TEST_PARALLEL: "1" }, []],
    ["nothing under CI", [], { CI: "true" }, []],
    ["the override under CI", [], { CI: "true", POLARIS_TEST_PARALLEL: "3" }, ["--parallel=3"]],
    ["the default when CI is false", [], { CI: "false" }, ["--parallel=6"]],
    ["nothing over CI's own --parallel", ["--shard=1/3", "--parallel=2"], {}, []],
    ["nothing over --isolate", ["--isolate"], { POLARIS_TEST_PARALLEL: "4" }, []],
  ])("adds %s", (_, args, env, flags) => {
    expect(parallelFlags(args, env, () => mac)).toEqual(flags);
  });

  test.each(["0", "two", "2.5"])("refuses POLARIS_TEST_PARALLEL=%s", (value) => {
    expect(() => parallelFlags([], { POLARIS_TEST_PARALLEL: value }, () => mac)).toThrow(
      "POLARIS_TEST_PARALLEL must be a whole number"
    );
  });
});
