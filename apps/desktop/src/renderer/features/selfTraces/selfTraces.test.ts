/**
 * The renderer's half of Self-Traces against a fake `window.polaris`: what crosses IPC (Spans,
 * a request's `trace`) while on, and that nothing does while off.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { LogConsole } from "@polaris/client/selfTraces/logs";
import { type SelfSpan, SessionId } from "@polaris/protocol";
import type { AppEvent, PolarisApi, RequestOptions } from "../../../shared/api.ts";
import type { RequestInput, RequestMethod } from "../../../shared/contract.ts";
import { Commands } from "../../commands.ts";
import { standInBridge } from "../bridge.ts";
import { dispatch } from "../session/dispatch.ts";
import {
  type ActionTraces,
  connectSelfTraces,
  createActionTraces,
  createRendererSelfTraces,
} from "./index.ts";

const fakeApi = (enabled: boolean) => {
  const batches: Array<ReadonlyArray<SelfSpan>> = [];
  const requests: Array<{ method: string; options: RequestOptions | undefined }> = [];
  let onEvent: (event: AppEvent) => void = () => undefined;

  const request = async (
    method: RequestMethod,
    _input: RequestInput<RequestMethod>,
    options?: RequestOptions
  ) => {
    requests.push({ method, options });

    return method === "selfTraces.state"
      ? { ok: true, value: { enabled, version: "1.2.3" } }
      : { ok: true, value: null };
  };

  const api: PolarisApi = {
    // SAFETY: the code under test requests only `selfTraces.state` and `dispatch`, answered above.
    request: request as PolarisApi["request"],
    selfSpans: (spans) => void batches.push(spans),
    onAppEvent: (listener) => {
      onEvent = listener;

      return () => undefined;
    },
    subscribe: () => () => undefined,
  };

  return { api, batches, requests, emit: (event: AppEvent) => onEvent(event) };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const command = Commands.Continue({ sessionId: SessionId.make("s-1") });

afterEach(() => standInBridge(null));

describe("renderer Self-Traces", () => {
  test("a dispatched command carries its Span's trace, and the Span reaches main, while on", async () => {
    const fake = fakeApi(true);
    const traces = connectSelfTraces(fake.api);

    standInBridge(fake.api);
    await settle();
    await dispatch("local", command);
    traces.flush();

    const sent = fake.requests.find((r) => r.method === "dispatch");
    const span = fake.batches.flat()[0];

    expect(span?.name).toBe("dispatch Continue");
    expect(span?.resource["service.version"]).toBe("1.2.3");
    expect(sent?.options?.trace?.traceparent).toBe(`00-${span?.traceId}-${span?.id}-01`);
  });

  test("while off a command carries no trace and nothing is sent to main", async () => {
    const fake = fakeApi(false);
    const traces = connectSelfTraces(fake.api);

    standInBridge(fake.api);
    await settle();
    await dispatch("local", command);
    traces.flush();

    expect(fake.requests.find((r) => r.method === "dispatch")?.options).toBeUndefined();
    expect(fake.batches).toHaveLength(0);
  });

  test("turning off by App event drops unsent Spans and disarms the flush", async () => {
    const fake = fakeApi(false);
    const traces = connectSelfTraces(fake.api);
    const timers = new Set<() => void>();

    const local = createRendererSelfTraces({
      bridge: () => fake.api,
      setTimeout: (run) => {
        timers.add(run);

        return () => void timers.delete(run);
      },
    });

    fake.emit({ kind: "self-traces", enabled: true });
    await settle();

    expect(traces.enabled()).toBe(true);

    local.setEnabled(true);

    const child = local.start(
      "child",
      {},
      { traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01` }
    );

    child?.end();

    expect(timers.size).toBe(1);

    local.setEnabled(false);
    fake.emit({ kind: "self-traces", enabled: false });
    local.flush();

    expect(timers.size).toBe(0);
    expect(traces.enabled()).toBe(false);
    expect(local.start("off")).toBeNull();
    expect(fake.batches).toHaveLength(0);
  });

  test("a console warning in the window becomes a polaris.log Span only while on", () => {
    const fake = fakeApi(true);
    const target: LogConsole = { warn: () => undefined, error: () => undefined };
    const local = createRendererSelfTraces({ bridge: () => fake.api, console: target });

    target.warn("before");
    local.setVersion("1.2.3");
    local.setEnabled(true);
    target.error("render failed, token=abc123");
    local.flush();
    local.setEnabled(false);
    target.warn("after");
    local.setEnabled(true);
    local.flush();

    expect(
      fake.batches
        .flat()
        .map((s) => [s.name, s.status, s.attributes["log.message"], s.resource["service.name"]])
    ).toEqual([
      ["polaris.log", "error", "render failed, token=[redacted]", "polaris-desktop-renderer"],
    ]);
  });

  test("a warning during an action is an event on its Span; once it ends, a polaris.log Span", () => {
    const fake = fakeApi(true);
    const target: LogConsole = { warn: () => undefined, error: () => undefined };
    const timers: Array<() => void> = [];
    let actions: ActionTraces | null = null;

    const local = createRendererSelfTraces({
      bridge: () => fake.api,
      console: target,
      activeSpan: () => actions?.active(),
    });

    actions = createActionTraces({
      traces: () => local,
      setTimeout: (run) => {
        timers.push(run);

        return () => undefined;
      },
    });
    local.setEnabled(true);
    actions.run("data.table.open", "Open table", () => target.warn("schema cache stale"));

    for (const run of timers.splice(0)) run();
    target.warn("after the action");
    local.flush();

    expect(
      fake.batches
        .flat()
        .map((s) => [s.name, s.events.map((e) => [e.name, e.attributes["log.message"]])])
    ).toEqual([
      ["polaris.action.data.table.open", [["log.warn", "schema cache stale"]]],
      ["polaris.log", []],
    ]);
  });

  test("a child Span stays in its parent's Trace", () => {
    const fake = fakeApi(true);
    const local = createRendererSelfTraces({ bridge: () => fake.api });

    local.setEnabled(true);
    local
      .start("child", {}, { traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01` })
      ?.end("boom");
    local.flush();

    expect(
      fake.batches.flat().map((s) => [s.traceId, s.parentId, s.status, s.statusMessage])
    ).toEqual([["a".repeat(32), "b".repeat(16), "error", "boom"]]);
  });
});
