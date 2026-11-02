/** The Daemon's warnings and errors on its Self-Traces (ENG-754), scrubbed, only while exporting. */
import { expect, test } from "bun:test";
import { logSpan, selfTraceLoggers } from "@polaris/client";
import type { SelfSpan } from "@polaris/protocol";
import { Effect, Logger } from "effect";
import { withTraceFixture } from "../testing.ts";
import { ingestSelfSpans } from "./ingest.ts";
import { SELF_CHECKOUT } from "./scope.ts";
import { SelfTracer } from "./tracer.ts";

const setup = () => {
  const printed: Array<ReadonlyArray<unknown>> = [];
  const original = (...args: Array<unknown>) => void printed.push(args);
  const target = { warn: original, error: original };
  const tracer = new SelfTracer(target);
  const stored: Array<SelfSpan> = [];

  const collect = () => {
    tracer.flush();

    return stored.splice(0);
  };

  return {
    target,
    original,
    tracer,
    printed,
    sink: (spans: ReadonlyArray<SelfSpan>) => void stored.push(...spans),
    collect,
  };
};

const inSpan = <A>(tracer: SelfTracer, effect: Effect.Effect<A>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.withSpan("git.status"),
      Effect.withTracer(tracer),
      Effect.provideService(Logger.CurrentLoggers, selfTraceLoggers(tracer.logs))
    )
  );

test("console and Effect warnings land on the active Span, else as polaris.log, with secrets scrubbed", async () => {
  const t = setup();

  t.tracer.setSink(t.sink);
  await inSpan(
    t.tracer,
    Effect.sync(() =>
      t.target.warn("fetch failed for https://u:hunter2@example.com/repo token=ghp_abc123")
    ).pipe(Effect.andThen(Effect.logError("index rebuild failed")))
  );
  t.target.error("socket closed, password: hunter2");

  const spans = t.collect();
  const events = spans.find((span) => span.name === "git.status")?.events ?? [];

  expect(events.map((event) => [event.name, event.attributes["log.message"]])).toEqual([
    ["log.warn", "fetch failed for https://[redacted]@example.com/repo token=[redacted]"],
    ["log.error", "index rebuild failed"],
  ]);
  expect(
    spans
      .filter((span) => span.name === "polaris.log")
      .map((span) => span.attributes["log.message"])
  ).toEqual(["socket closed, password: [redacted]"]);
  expect(JSON.stringify(spans)).not.toContain("hunter2");
  expect(t.printed).toHaveLength(2);
});

test("while not exporting the console is left alone and nothing is recorded", async () => {
  const t = setup();

  expect(t.target.warn).toBe(t.original);
  t.tracer.setSink(t.sink);
  expect(t.target.warn).not.toBe(t.original);
  t.tracer.setSink(null);
  expect(t.target.warn).toBe(t.original);

  t.target.warn("off");
  await inSpan(t.tracer, Effect.logWarning("off too"));
  t.tracer.setSink(t.sink);

  expect(t.collect()).toEqual([]);
  t.tracer.setSink(null);
});

test("a Client's log Span is redacted by the store on ingest", () =>
  withTraceFixture(async (f) => {
    const span = logSpan(
      {
        "log.severity": "warn",
        "log.source": "console",
        "log.message": "retry with Bearer abc.def",
      },
      Date.now(),
      { resource: {}, scope: { name: "renderer", version: "1", attributes: {} } }
    );

    await Effect.runPromise(
      ingestSelfSpans(f.store, {
        service: "polaris-desktop-renderer",
        spans: [span],
        workspaceId: null,
      })
    );
    await Effect.runPromise(f.store.flush);
    const page = await Effect.runPromise(f.store.list(SELF_CHECKOUT));
    const detail = await Effect.runPromise(f.store.get(SELF_CHECKOUT, page.traces[0]!.id));

    expect(detail.spans[0]?.name).toBe("polaris.log");
    expect(detail.spans[0]?.attributes["log.message"]).toBe("[redacted]");
  }));
