import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Predicate } from "effect";
import { decodeExtensionsTrace, replayExtensions, toQuint } from "./index.ts";

const fixture = join(import.meta.dir, "runtime.trace.json");

const replay = resolve(import.meta.dir, "../replay-extensions.ts");

const run = (path: string) =>
  Bun.spawnSync([process.execPath, replay, path], { stdout: "pipe", stderr: "pipe" });

test("the runtime trace replays through the reference and the Quint spec", () => {
  const trace = decodeExtensionsTrace(JSON.parse(readFileSync(fixture, "utf8")));

  expect(() => replayExtensions(trace)).not.toThrow();
  // The fixture exercises each decision the spec makes, not just the happy path.

  expect(new Set(trace.events.map((e) => e._tag))).toEqual(
    new Set(["Pair", "Revoke", "Hello", "Call"])
  );

  expect(trace.events.map((e) => (Predicate.isTagged(e, "Call") ? e.observed : ""))).toContain(
    "dropped"
  );

  const accepted = run(fixture);

  expect({ exitCode: accepted.exitCode, stderr: accepted.stderr.toString() }).toMatchObject({
    exitCode: 0,
  });
});

test("a trace where a revoked Extension still gets through is rejected by both", () => {
  const trace = decodeExtensionsTrace(JSON.parse(readFileSync(fixture, "utf8")));

  const at = trace.events.findIndex(
    (e) => Predicate.isTagged(e, "Call") && e.observed === "dropped"
  );

  const mutant = decodeExtensionsTrace({
    ...trace,
    events: trace.events.map((e, i) => (i === at ? { ...e, observed: "allowed" } : e)),
  });

  expect(() => replayExtensions(mutant)).toThrow("Extensions trace observation mismatch");

  // The Quint replay on its own (no reference check first) must refuse it too.

  const out = resolve(import.meta.dir, "../../.replay");

  mkdirSync(out, { recursive: true });

  const path = join(out, "replay_extensions_mutant.qnt");

  writeFileSync(path, toQuint("replay_extensions_mutant", mutant));

  const quint = Bun.spawnSync(
    [
      resolve(import.meta.dir, "../../node_modules/.bin/quint"),
      "test",
      path,
      "--main=replay_extensions_mutant",
    ],
    { cwd: resolve(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" }
  );

  expect(quint.exitCode).not.toBe(0);

  expect(quint.stdout.toString()).toContain("replayTest");
});
