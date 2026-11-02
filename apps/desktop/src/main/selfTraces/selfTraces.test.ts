/**
 * Desktop Self-Traces against a test Developer Mode source and a recording sender at the
 * boundary; the real Tracer, exporter and IPC trace handling in between.
 */
import { describe, expect, test } from "bun:test";
import type { SelfSpan, SelfTraceBatch } from "@polaris/protocol";
import { Effect } from "effect";
import { RpcClient } from "effect/rpc";
import { createDesktopSelfTraces, MAIN_SERVICE, RENDERER_SERVICE } from "./index.ts";
import { testDeveloperModeSource } from "./source.testing.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const recordingHost = () => {
  const sent: Array<{ hostKey: string; batch: SelfTraceBatch }> = [];

  return {
    sent,
    send: async (hostKey: string, batch: SelfTraceBatch) => {
      sent.push({ hostKey, batch });

      return "sent" as const;
    },
  };
};

const setup = (enabled = false) => {
  const mode = testDeveloperModeSource({ hostKey: "studio", enabled });

  const traces = createDesktopSelfTraces({
    version: "1.0.0",
    source: mode.source,
    flushDelayMs: 0,
  });

  const host = recordingHost();

  traces.bind(host.send);

  const span = (name: string) =>
    Effect.runPromise(Effect.void.pipe(Effect.withSpan(name), Effect.withTracer(traces.tracer)));

  return { mode, traces, host, span };
};

const rendererSpan: SelfSpan = {
  traceId: "1".repeat(32),
  id: "2".repeat(16),
  parentId: null,
  name: "dispatch Continue",
  kind: "client",
  status: "unset",
  statusMessage: "",
  traceState: "",
  startTimeUnixNano: "1",
  endTimeUnixNano: "2",
  attributes: {},
  resource: {},
  scope: { name: "renderer", version: "1.0.0", attributes: {} },
  events: [],
  links: [],
  droppedAttributes: 0,
  droppedEvents: 0,
  droppedLinks: 0,
};

describe("Desktop Self-Traces", () => {
  test("main's Spans reach the Polaris Workspace's Host only while its Developer Mode is on", async () => {
    const { mode, host, span } = setup();

    await span("before");
    await settle();

    expect(host.sent).toHaveLength(0);

    mode.set({ hostKey: "studio", enabled: true });
    await span("turn");
    await settle();

    expect(host.sent.map(({ hostKey, batch }) => [hostKey, batch.service])).toEqual([
      ["studio", MAIN_SERVICE],
    ]);
    expect(host.sent[0]?.batch.spans.map((s) => s.name)).toEqual(["turn"]);

    mode.set({ hostKey: "studio", enabled: false });
    await span("after");
    await settle();

    expect(host.sent).toHaveLength(1);
  });

  test("batches follow the Polaris Workspace when it moves to another Host", async () => {
    const { mode, host, span } = setup(true);

    mode.set({ hostKey: "local", enabled: true });
    await span("moved");
    await settle();

    expect(host.sent.map(({ hostKey }) => hostKey)).toEqual(["local"]);
  });

  test("windows hear each switch, and only real ones", () => {
    const { mode, traces } = setup();
    const heard: Array<boolean> = [];

    traces.onChange((enabled) => heard.push(enabled));
    mode.set({ hostKey: "studio", enabled: true });
    mode.set({ hostKey: "local", enabled: true });
    mode.set({ hostKey: "local", enabled: false });

    expect(heard).toEqual([true, false]);
  });

  test("the renderer's Spans are sent under its own service, only while on", async () => {
    const { mode, traces, host } = setup();

    traces.ingestRenderer([rendererSpan]);
    mode.set({ hostKey: "local", enabled: true });
    traces.ingestRenderer([rendererSpan]);
    await settle();

    expect(host.sent.map(({ hostKey, batch }) => [hostKey, batch.service, batch.spans])).toEqual([
      ["local", RENDERER_SERVICE, [rendererSpan]],
    ]);
  });

  test("main's console warnings become Spans and events only while on, through the runtime's layer", async () => {
    const mode = testDeveloperModeSource({ hostKey: "studio", enabled: false });
    const printed: Array<unknown> = [];

    const target = {
      warn: (...args: Array<unknown>) => printed.push(args),
      error: () => undefined,
    };

    const traces = createDesktopSelfTraces({
      version: "1.0.0",
      source: mode.source,
      flushDelayMs: 0,
      console: target,
    });

    const host = recordingHost();

    traces.bind(host.send);

    target.warn("while off");
    mode.set({ hostKey: "studio", enabled: true });
    target.warn("outside a Span", "Bearer sk-abc123");
    await Effect.runPromise(
      Effect.logWarning("inside").pipe(
        Effect.withSpan("hosts.connect"),
        Effect.provide(traces.layer)
      )
    );
    await settle();
    mode.set({ hostKey: "studio", enabled: false });
    target.warn("off again");
    await settle();

    const spans = host.sent.flatMap(({ batch }) => batch.spans);

    expect(
      spans.map((span) => [
        span.name,
        span.attributes["log.message"] ?? span.events.map((e) => e.attributes["log.message"]),
      ])
    ).toEqual([
      ["polaris.log", "outside a Span [redacted]"],
      ["hosts.connect", ["inside"]],
    ]);
    expect(printed).toHaveLength(3);
    traces.dispose();
  });

  test("an IPC request joins the renderer's Trace while on, and starts none while off", async () => {
    const { mode, traces } = setup();

    const trace = {
      traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
      tracestate: "polaris=1",
    };

    const inside = Effect.gen(function* () {
      const span = yield* Effect.currentSpan;
      const headers = yield* RpcClient.CurrentHeaders;

      return { traceId: span.traceId, tracestate: headers["tracestate"] };
    }).pipe(Effect.withSpan("rpc"));

    const run = () =>
      Effect.runPromise(
        traces.withRendererTrace(trace, "dispatch", inside).pipe(Effect.withTracer(traces.tracer))
      );

    const off = await run();

    expect(off.traceId).not.toBe("a".repeat(32));
    expect(off.tracestate).toBeUndefined();

    mode.set({ hostKey: "local", enabled: true });
    const on = await run();

    expect(on.traceId).toBe("a".repeat(32));
    expect(on.tracestate).toBe("polaris=1");
  });
});
