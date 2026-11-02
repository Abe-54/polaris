/** Log capture through the real gated Tracer, recorder, Effect logger and exporter. */
import { describe, expect, test } from "bun:test";
import type { SelfSpan } from "@polaris/protocol";
import { Effect, Logger, Predicate, type Tracer } from "effect";
import { makeSelfTraceExporter } from "./exporter.ts";
import { currentFiberSpan, selfTraceLoggers } from "./logger.ts";
import {
  hookConsole,
  LOG_MESSAGE_CHARS,
  LOG_SPAN_NAME,
  type LogConsole,
  makeLogRecorder,
  SELF_TRACES_LOG_PREFIX,
} from "./logs.ts";
import { selfSpanOf } from "./span.ts";
import { gatedTracer } from "./tracer.ts";

/** The recorded message, or "" when the Span has none. */
const message = (span: SelfSpan | undefined) => {
  const value = span?.attributes["log.message"];

  return Predicate.isString(value) ? value : "";
};

const origin = { service: "polaris-desktop-main", version: "1.0.0", scope: "@polaris/desktop" };

const fakeConsole = () => {
  const printed: Array<ReadonlyArray<unknown>> = [];

  const target: LogConsole = {
    warn: (...args) => printed.push(args),
    error: (...args) => printed.push(args),
  };

  return { target, printed };
};

const setup = (options: { on?: boolean; perSecond?: number } = {}) => {
  const { perSecond = 20 } = options;
  const on = { value: options.on ?? true };
  const clock = { ms: 1_000_000 };
  const ended: Array<Tracer.Span> = [];
  const emitted: Array<SelfSpan> = [];
  const tracer = gatedTracer({ enabled: () => on.value, onEnd: (span) => ended.push(span) });

  const recorder = makeLogRecorder({
    enabled: () => on.value,
    emit: (span) => emitted.push(span),
    origin: () => ({
      resource: { "service.name": origin.service },
      scope: { name: "t", version: "", attributes: {} },
    }),
    nowMs: () => clock.ms,
    perSecond,
  });

  const { target, printed } = fakeConsole();
  const unhook = hookConsole(target, recorder, currentFiberSpan);

  const spans = () => ended.flatMap((span) => selfSpanOf(span, origin) ?? []);

  return { on, clock, tracer, recorder, target, printed, emitted, spans, unhook };
};

describe("log capture", () => {
  test("a console.warn inside an active Span becomes an event on it, and still prints", async () => {
    const t = setup();

    await Effect.runPromise(
      Effect.sync(() => t.target.warn("cache miss for", { key: "a" })).pipe(
        Effect.withSpan("files.read"),
        Effect.withTracer(t.tracer)
      )
    );

    const [span] = t.spans();

    expect(span?.events.map((event) => [event.name, event.attributes["log.message"]])).toEqual([
      ["log.warn", 'cache miss for {"key":"a"}'],
    ]);
    expect(t.emitted).toHaveLength(0);
    expect(t.printed).toEqual([["cache miss for", { key: "a" }]]);
  });

  test("Effect.logWarning annotates its Span through the Self-Trace logger; Info keeps Effect's own event", async () => {
    const t = setup();

    await Effect.runPromise(
      Effect.logWarning("retrying").pipe(
        Effect.andThen(Effect.logInfo("connected")),
        Effect.withSpan("hosts.connect"),
        Effect.withTracer(t.tracer),
        Effect.provideService(Logger.CurrentLoggers, selfTraceLoggers(t.recorder))
      )
    );

    const events = t.spans()[0]?.events ?? [];

    expect(events.map((event) => [event.name, event.attributes["log.message"] ?? null])).toEqual([
      ["log.warn", "retrying"],
      ["connected", null],
    ]);
  });

  test("with no active Span a short polaris.log Span is emitted; an error marks it failed", () => {
    const t = setup();

    t.target.error(new Error("socket closed"));

    expect(t.emitted.map((span) => [span.name, span.status, span.parentId])).toEqual([
      [LOG_SPAN_NAME, "error", null],
    ]);
    expect(message(t.emitted[0]).split("\n")[0]).toBe("Error: socket closed");
  });

  test("nothing is recorded while Self-Traces are off", async () => {
    const t = setup({ on: false });

    t.target.warn("outside");
    await Effect.runPromise(
      Effect.sync(() => t.target.warn("inside")).pipe(
        Effect.withSpan("x"),
        Effect.withTracer(t.tracer)
      )
    );

    expect(t.emitted).toHaveLength(0);
    expect(t.spans()).toHaveLength(0);
    expect(t.printed).toHaveLength(2);
  });

  test("past the rate limit records are dropped, then reported once as a count", () => {
    const t = setup({ perSecond: 2 });

    for (let i = 0; i < 5; i++) t.target.warn(`storm ${i}`);
    t.clock.ms += 1_000;
    t.target.warn("after");

    expect(
      t.emitted.map((span) => span.attributes["log.message"] ?? span.attributes["log.dropped"])
    ).toEqual(["storm 0", "storm 1", 3, "after"]);
    expect(t.printed).toHaveLength(6);
  });

  test("long messages are capped", () => {
    const t = setup();

    t.target.warn("x".repeat(LOG_MESSAGE_CHARS * 4));

    expect(message(t.emitted[0])).toHaveLength(LOG_MESSAGE_CHARS);
  });

  test("a secret the length cap cuts in half is scrubbed whole, so none of it survives", () => {
    const t = setup();
    const lead = "x".repeat(LOG_MESSAGE_CHARS - 20);

    t.target.warn(lead, "clone https://deploy:hunter2hunter2@git.example.com/repo.git failed");
    t.target.warn({ password: "hunter2hunter2" }, "x".repeat(LOG_MESSAGE_CHARS * 10));

    const kept = t.emitted.map(message);

    expect(kept.join("\n")).not.toMatch(/hunt|deploy:|r2h/);
    expect(kept.map((line) => line.length)).toEqual([LOG_MESSAGE_CHARS, LOG_MESSAGE_CHARS]);
  });

  test("unhooking restores the console", () => {
    const t = setup();
    const hooked = t.target.warn;

    t.unhook();

    expect(t.target.warn).not.toBe(hooked);
    t.target.warn("after unhook");
    expect(t.emitted).toHaveLength(0);
  });

  test("the exporter's own warning about an unreachable Host is not recorded, so it can't loop", async () => {
    const { target } = fakeConsole();

    const exporter = makeSelfTraceExporter({
      send: () => Promise.reject(new Error("offline")),
      clock: { now: () => 0, setTimeout: () => () => undefined },
      log: (message) => target.warn(SELF_TRACES_LOG_PREFIX, message),
    });

    exporter.setEnabled(true);

    const recorder = makeLogRecorder({
      enabled: exporter.enabled,
      emit: (span) => exporter.record("main", span),
      origin: () => ({ resource: {}, scope: { name: "t", version: "", attributes: {} } }),
    });

    hookConsole(target, recorder);

    target.warn("first");
    await exporter.flush();

    expect(exporter.held().spans).toBe(1);
  });
});
