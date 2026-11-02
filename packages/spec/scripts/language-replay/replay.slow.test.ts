import { expect, test } from "bun:test";
import { Schema } from "effect";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  decodeLanguageTrace,
  LanguageTraceEvent,
  LanguageTraceObservation,
  languageTraceModule,
} from "./index.ts";

const observed = LanguageTraceObservation.cases.Context.make({
  context: 0,
  generation: 1,
  sequence: 0,
  version: 0,
  delivered: -1,
});

test("language traces reject unknown versions, tags, contexts and absent observations", () => {
  expect(() => decodeLanguageTrace({ version: 2, source: "runtime", events: [] })).toThrow();

  const invalidEvent: unknown = JSON.parse('{"_tag":"Shell"}');

  expect(() =>
    decodeLanguageTrace({
      version: 1,
      source: "runtime",
      events: [{ event: invalidEvent, observed }],
    })
  ).toThrow();

  expect(() =>
    decodeLanguageTrace({
      version: 1,
      source: "runtime",
      events: [{ event: LanguageTraceEvent.cases.Crash.make({}) }],
    })
  ).toThrow();

  expect(() =>
    Schema.decodeUnknownSync(LanguageTraceEvent)(JSON.parse('{"_tag":"Restart","context":7}'))
  ).toThrow();
});

test("Quint replay accepts the fixture and rejects a stale-result observation mutant", () => {
  const fixture = join(import.meta.dir, "contract.trace.json");

  const replay = resolve(import.meta.dir, "../replay-language.ts");

  const run = (path: string) =>
    Bun.spawnSync([process.execPath, replay, path], { stdout: "pipe", stderr: "pipe" });

  const accepted = run(fixture);

  // On failure the expectation shows Quint's own output, not just the exit code.
  expect({ exitCode: accepted.exitCode, stderr: accepted.stderr.toString() }).toMatchObject({
    exitCode: 0,
  });

  const directory = mkdtempSync(join(tmpdir(), "polaris-language-mutant-"));

  try {
    const trace = decodeLanguageTrace(JSON.parse(readFileSync(fixture, "utf8")));

    const events = trace.events.map((step, index) =>
      index === 4
        ? {
            ...step,
            observed: LanguageTraceObservation.cases.Context.make({
              context: 0,
              generation: 1,
              sequence: 2,
              version: 2,
              delivered: 1,
            }),
          }
        : step
    );

    const mutant = join(directory, "mutant.json");

    writeFileSync(mutant, JSON.stringify({ ...trace, events }));

    const rejected = run(mutant);

    expect(rejected.exitCode).toBe(1);

    expect(rejected.stdout.toString()).toContain("QNT508");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

test("every event and observed outcome maps to a safety-checked action", () => {
  const events = [
    LanguageTraceEvent.cases.Sync.make({
      context: 0,
      generation: 1,
      sequence: 1,
      previous: 0,
      version: 1,
    }),
    LanguageTraceEvent.cases.Request.make({ context: 0, generation: 1, sequence: 1, version: 1 }),
    LanguageTraceEvent.cases.Result.make({ context: 0, generation: 1, version: 1 }),
    LanguageTraceEvent.cases.Cancel.make({ context: 0 }),
    LanguageTraceEvent.cases.Restart.make({ context: 1 }),
    LanguageTraceEvent.cases.Prepare.make({}),
    LanguageTraceEvent.cases.Apply.make({}),
    LanguageTraceEvent.cases.PersistDrafts.make({}),
    LanguageTraceEvent.cases.PersistReceipt.make({}),
    LanguageTraceEvent.cases.Acknowledge.make({}),
    LanguageTraceEvent.cases.DiskEdit.make({}),
    LanguageTraceEvent.cases.Undo.make({}),
    LanguageTraceEvent.cases.Crash.make({}),
  ];

  const trace = decodeLanguageTrace({
    version: 1,
    source: "synthetic-contract",
    events: events.map((event) => ({ event, observed })),
  });

  const generated = languageTraceModule(trace, "/tmp/languages");

  expect(generated.match(/\.then\(publish\(/g)?.length).toBe(trace.events.length);

  expect(generated.match(/\.expect\(safety/g)?.length).toBe(trace.events.length + 1);

  expect(generated).toContain("publish(Restart(1))");

  expect(generated).toContain("publish(Acknowledge)");

  expect(generated).toContain("contexts.get(0).delivered == -1");
});
