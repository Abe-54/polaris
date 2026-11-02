import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Schema, Predicate } from "effect";
import {
  LanguageError,
  LanguageDocumentNotification,
  LanguageSyncInput,
  LanguageFeatureRequest,
} from "../../../protocol/src/index.ts";
import { fixture } from "../../../../apps/daemon/src/languages/runtime/fixtures.testing.ts";
import { RuntimeTrace, RuntimeStep, RuntimeSignal, replayRuntime } from "./index.ts";
import {
  LanguageTrace,
  LanguageTraceEvent,
  LanguageTraceObservation,
} from "../language-replay/index.ts";

// Per run, so parallel checkouts never share a trace file.
const traceDir = await mkdtemp(join(tmpdir(), "polaris-language-runtime-"));

afterAll(() => rm(traceDir, { recursive: true, force: true }));

const tracePath = join(traceDir, "lifecycle.trace.json");

test("observed idle eviction and new admission replay per context, rejecting a false eviction result", async () => {
  const traces = new Map<string, (typeof RuntimeTrace.Type)["steps"][number][]>();

  const f = await fixture(
    "ordinary",
    60000,
    ({ event, phase, contextId }) => {
      const steps = traces.get(contextId) ?? [];
      steps.push(
        Schema.decodeUnknownSync(RuntimeStep)({
          event: Schema.decodeUnknownSync(RuntimeSignal)({ ...event, _tag: event.type }),
          phase,
        })
      );
      traces.set(contextId, steps);
    },
    undefined,
    undefined,
    false,
    { processLimit: 1 }
  );

  try {
    const old = await f.acquire("old", "old", "fake-old");
    await f.open("old", old.context);
    await f.ready("old", old.context);
    await f.broker.sync("old", {
      context: old.context,
      sequence: 2,
      notification: LanguageDocumentNotification.cases.Close.make({ uri: f.uri, version: 1 }),
    });
    const next = await f.acquire("next", "next", "fake-next");
    await f.open("next", next.context);
    await f.ready("next", next.context);
    const retired = await f.acquire("old", "old", "fake-old");
    expect(Predicate.isTagged(retired.runtime, "Stopped")).toBe(true);
  } finally {
    await f.dispose();
  }

  for (const steps of traces.values()) {
    const trace = RuntimeTrace.make({ version: 1, source: "runtime", steps });
    expect((await replayRuntime(trace)).steps).toBe(steps.length);
  }

  const old = traces.get("old")!;
  expect(old.some((step) => Predicate.isTagged(step.event, "evict"))).toBe(true);

  const mutant = RuntimeTrace.make({
    version: 1,
    source: "runtime",
    steps: old.map((step) =>
      Predicate.isTagged(step.event, "evict") ? RuntimeStep.make({ ...step, phase: "ready" }) : step
    ),
  });

  expect(
    await replayRuntime(mutant).then(
      () => "accepted",
      () => "rejected"
    )
  ).toBe("rejected");
}, 15000);

test("actual process lifecycle trace replays in Quint and rejects false observations", async () => {
  const steps: (typeof RuntimeTrace.Type)["steps"][number][] = [];

  const f = await fixture("ordinary", 5, ({ event, phase }) => {
    const signal = Schema.decodeUnknownSync(RuntimeSignal)({ ...event, _tag: event.type });

    const step = Schema.decodeUnknownSync(RuntimeStep)({
      event: signal,
      phase,
    });

    steps.push(step);
  });

  try {
    const { context } = await f.acquire();
    await f.open("one", context);
    await f.ready("one", context);
    await f.broker.release("one", context, "file");
    await f.broker.sync(
      "one",
      LanguageSyncInput.make({
        context,
        sequence: 2,
        notification: LanguageDocumentNotification.cases.Close.make({ uri: f.uri, version: 1 }),
      })
    );

    for (let i = 0; i < 100 && f.broker.stats().contexts > 0; i++) await Bun.sleep(5);
    expect(f.broker.stats().contexts).toBe(0);
  } finally {
    await f.dispose();
  }

  const trace = RuntimeTrace.make({ version: 1, source: "runtime", steps });
  await writeFile(tracePath, JSON.stringify(trace, null, 2));
  expect((await replayRuntime(trace)).steps).toBeGreaterThan(2);

  const mutant = {
    ...trace,
    steps: trace.steps.map((step, index) =>
      index === 0 ? RuntimeStep.make({ ...step, phase: "ready" }) : step
    ),
  };

  const outcome = await replayRuntime(mutant).then(
    () => "accepted",
    () => "rejected"
  );

  expect(outcome).toBe("rejected");
}, 15000);

test("actual ordered acknowledgments/results/restart snapshots map to P1 language trace", async () => {
  const f = await fixture();
  const events: (typeof LanguageTrace.Type)["events"][number][] = [];

  try {
    const { context } = await f.acquire();
    const ack = await f.open("one", context, "runtime trace");
    await f.ready("one", context);
    const version = ack.documents[0]!.version;

    const observed = (generation: number, sequence: number, current: number, delivered = -1) =>
      LanguageTraceObservation.cases.Context.make({
        context: 0,
        generation,
        sequence,
        version: current,
        delivered,
      });

    events.push({
      event: LanguageTraceEvent.cases.Sync.make({
        context: 0,
        generation: 1,
        sequence: ack.acceptedSequence,
        previous: 0,
        version,
      }),
      observed: observed(1, ack.acceptedSequence, version),
    });

    const request = LanguageFeatureRequest.make({
      requestId: "trace",
      fence: { context, requiredSequence: ack.acceptedSequence, documents: ack.documents },
      method: "textDocument/hover",
      params: { textDocument: { uri: f.uri } },
      deadline: Date.now() + 1000,
    });

    events.push({
      event: LanguageTraceEvent.cases.Request.make({
        context: 0,
        generation: 1,
        sequence: ack.acceptedSequence,
        version,
      }),
      observed: observed(1, ack.acceptedSequence, version),
    });
    const result = await f.broker.request("one", request);
    const actual = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.Int }))(result.result);
    events.push({
      event: LanguageTraceEvent.cases.Result.make({
        context: 0,
        generation: 1,
        version: actual.version,
      }),
      observed: observed(1, ack.acceptedSequence, version, actual.version),
    });

    const cancelled = f.broker
      .request(
        "one",
        LanguageFeatureRequest.make({
          ...request,
          requestId: "trace-cancel",
          params: { ...request.params, slow: true },
        })
      )
      .then(
        () => false,
        (error: LanguageError) => Schema.is(LanguageError)(error) && error.reason === "cancelled"
      );

    await Bun.sleep(10);
    events.push({
      event: LanguageTraceEvent.cases.Request.make({
        context: 0,
        generation: 1,
        sequence: ack.acceptedSequence,
        version,
      }),
      observed: observed(1, ack.acceptedSequence, version, actual.version),
    });
    f.broker.cancel("one", context, "trace-cancel");
    expect(await cancelled).toBe(true);
    events.push({
      event: LanguageTraceEvent.cases.Cancel.make({ context: 0 }),
      observed: observed(1, ack.acceptedSequence, version, actual.version),
    });
    const restarted = await f.broker.restart("one", context);
    expect(restarted.context.generation).toBeGreaterThan(context.generation);
    events.push({
      event: LanguageTraceEvent.cases.Restart.make({ context: 0 }),
      observed: observed(
        2,
        restarted.ack.acceptedSequence,
        restarted.ack.documents[0]?.version ?? 0
      ),
    });
    const trace = LanguageTrace.make({ version: 1, source: "runtime", events });
    const path = join(traceDir, "language.trace.json");
    await writeFile(path, JSON.stringify(trace, null, 2));

    const child = Bun.spawn(
      [process.execPath, resolve(import.meta.dir, "../replay-language.ts"), path],
      { stdout: "pipe", stderr: "pipe" }
    );

    await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(await child.exited).toBe(0);
  } finally {
    await f.dispose();
  }
}, 15000);

test("automatic crash replacement retains acknowledged versions and replays lifecycle backoff", async () => {
  const steps: (typeof RuntimeTrace.Type)["steps"][number][] = [];

  const f = await fixture("ordinary", 10, ({ event, phase }) => {
    steps.push(
      RuntimeStep.make({
        event: Schema.decodeUnknownSync(RuntimeSignal)({ ...event, _tag: event.type }),
        phase: Schema.decodeUnknownSync(RuntimeStep.fields.phase)(phase),
      })
    );
  });

  try {
    const original = await f.acquire();
    const ack = await f.open("one", original.context, "retained crash trace");
    await f.ready("one", original.context);
    process.kill(f.processes[0]!.pid, "SIGKILL");
    let current = await f.acquire();

    for (let i = 0; i < 200 && current.context.generation === original.context.generation; i++) {
      await Bun.sleep(5);
      current = await f.acquire();
    }

    expect(current.context.generation).toBeGreaterThan(original.context.generation);
    expect(current.ack.documents).toEqual(ack.documents);
    expect(current.ack.acceptedSequence).toBe(ack.acceptedSequence);
    await f.ready("one", current.context);

    const crashTrace = LanguageTrace.make({
      version: 1,
      source: "runtime",
      events: [
        {
          event: LanguageTraceEvent.cases.Sync.make({
            context: 0,
            generation: 1,
            sequence: 1,
            previous: 0,
            version: 1,
          }),
          observed: LanguageTraceObservation.cases.Context.make({
            context: 0,
            generation: 1,
            sequence: 1,
            version: 1,
            delivered: -1,
          }),
        },
        {
          event: LanguageTraceEvent.cases.Restart.make({ context: 0 }),
          observed: LanguageTraceObservation.cases.Context.make({
            context: 0,
            generation: 2,
            sequence: 1,
            version: 1,
            delivered: -1,
          }),
        },
      ],
    });

    await writeFile(
      join(traceDir, "crash-language.trace.json"),
      JSON.stringify(crashTrace, null, 2)
    );
  } finally {
    await f.dispose();
  }

  const trace = RuntimeTrace.make({ version: 1, source: "runtime", steps });
  await writeFile(join(traceDir, "crash-lifecycle.trace.json"), JSON.stringify(trace, null, 2));
  expect((await replayRuntime(trace)).steps).toBeGreaterThan(3);
}, 15000);

test("configuration restart keeps the crash budget and its observed trace replays", async () => {
  const steps: (typeof RuntimeTrace.Type)["steps"][number][] = [];

  const f = await fixture(
    "ordinary",
    10,
    ({ event, phase }) => {
      steps.push(
        RuntimeStep.make({
          event: Schema.decodeUnknownSync(RuntimeSignal)({ ...event, _tag: event.type }),
          phase: Schema.decodeUnknownSync(RuntimeStep.fields.phase)(phase),
        })
      );
    },
    undefined,
    undefined,
    false,
    { providerId: "typescript-language-server", changeDebounceMs: 20 }
  );

  try {
    const original = await f.acquire();
    await f.open("one", original.context);
    await f.ready("one", original.context);
    process.kill(f.processes[0]!.pid, "SIGKILL");

    for (let i = 0; i < 200 && f.processes.length < 2; i++) await Bun.sleep(5);
    let current = await f.acquire();
    await f.ready("one", current.context);
    await writeFile(`${f.root}/tsconfig.json`, '{"compilerOptions":{"strict":true}}');

    for (let i = 0; i < 200 && f.processes.length < 3; i++) await Bun.sleep(5);
    expect(f.processes).toHaveLength(3);
    current = await f.acquire();
    await f.ready("one", current.context);
    process.kill(f.processes[2]!.pid, "SIGKILL");

    for (let i = 0; i < 200 && f.processes.length < 4; i++) await Bun.sleep(5);
    current = await f.acquire();
    await f.ready("one", current.context);
    process.kill(f.processes[3]!.pid, "SIGKILL");

    for (let i = 0; i < 200; i++) {
      current = await f.acquire();

      if (Predicate.isTagged(current.runtime, "Stopped")) break;
      await Bun.sleep(5);
    }

    expect(current.runtime).toHaveProperty("reason", "crash-budget");
    expect(current.runtime).toHaveProperty("failure.attempts", 3);
    expect(steps.some((step) => Predicate.isTagged(step.event, "change"))).toBe(true);
  } finally {
    await f.dispose();
  }

  const trace = RuntimeTrace.make({ version: 1, source: "runtime", steps });
  await writeFile(join(traceDir, "config-budget.trace.json"), JSON.stringify(trace, null, 2));
  expect((await replayRuntime(trace)).steps).toBeGreaterThan(5);
}, 15000);
