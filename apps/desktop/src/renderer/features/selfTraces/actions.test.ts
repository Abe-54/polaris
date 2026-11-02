/**
 * Action Spans across the IPC boundary: the renderer's action Spans and request wrapper, and
 * main's real Self-Traces on the other side, with recording senders and hand-run timers.
 */
import { describe, expect, test } from "bun:test";
import type { SelfSpan, SelfTraceBatch } from "@polaris/protocol";
import { Effect } from "effect";
import type { PolarisApi, RequestOptions } from "../../../shared/api.ts";
import type { RequestInput, RequestMethod } from "../../../shared/contract.ts";
import { createDesktopSelfTraces, MAIN_SERVICE } from "../../../main/selfTraces/index.ts";
import { testDeveloperModeSource } from "../../../main/selfTraces/source.testing.ts";
import { ACTION_BOUND_MS, ACTION_QUIET_MS, createActionTraces, traceRequests } from "./actions.ts";
import { createRendererSelfTraces } from "./spans.ts";

const manualTimers = () => {
  const armed = new Map<number, { run: () => void; ms: number }>();
  let next = 0;

  return {
    setTimeout: (run: () => void, ms: number) => {
      const id = next++;

      armed.set(id, { run, ms });

      return () => void armed.delete(id);
    },
    /** Runs every armed timer of exactly `ms`, as if that much time passed. */
    elapse: (ms: number) => {
      for (const [id, timer] of armed) {
        if (timer.ms !== ms) continue;
        armed.delete(id);
        timer.run();
      }
    },
  };
};

// SAFETY: the fake main below answers any method and never reads the input.
const send = (api: PolarisApi, method: string) => api.request(method as RequestMethod, {});

const setup = (enabled = true) => {
  const mode = testDeveloperModeSource({ hostKey: "local", enabled });
  const main = createDesktopSelfTraces({ version: "1.0.0", source: mode.source, flushDelayMs: 0 });
  const mainBatches: Array<SelfTraceBatch> = [];

  main.bind(async (_hostKey, batch) => {
    mainBatches.push(batch);

    return "sent";
  });

  const rendererSpans: Array<SelfSpan> = [];
  const timers = manualTimers();
  const sent: Array<{ method: string; options: RequestOptions | undefined }> = [];

  const renderer = createRendererSelfTraces({
    bridge: () => ({ selfSpans: (spans) => void rendererSpans.push(...spans) }),
    setTimeout: timers.setTimeout,
  });

  renderer.setEnabled(enabled);
  const actions = createActionTraces({ traces: () => renderer, setTimeout: timers.setTimeout });
  let answer: () => void = () => undefined;

  // Main's IPC handling, as `registerIpc` runs it: the request inside the renderer's Trace.
  const request = (
    method: string,
    _input: RequestInput<RequestMethod>,
    options?: RequestOptions
  ) => {
    sent.push({ method, options });

    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });

    return Effect.runPromise(
      main
        .withRendererTrace(
          options?.trace,
          method,
          Effect.promise(() => answered)
        )
        .pipe(Effect.as({ ok: true, value: null }), Effect.withTracer(main.tracer))
    );
  };

  const fake: PolarisApi = {
    // SAFETY: the tests ignore every answer, so one shape serves each method.
    request: request as PolarisApi["request"],
    onAppEvent: () => () => undefined,
    subscribe: () => () => undefined,
  };

  const api = traceRequests(fake, actions);

  const flushAll = async () => {
    renderer.flush();
    await main.flush();
  };

  return {
    actions,
    api,
    timers,
    sent,
    rendererSpans,
    mainBatches,
    flushAll,
    answer: () => answer(),
  };
};

describe("action Spans", () => {
  test("a request an action sends is its child in main, and the action ends once it answers", async () => {
    const t = setup();

    t.actions.run("data.table.open", "Open table", () => {
      void send(t.api, "data.describe");
    });
    t.timers.elapse(ACTION_QUIET_MS);
    await t.flushAll();

    expect(t.rendererSpans).toHaveLength(0);

    t.answer();
    await Bun.sleep(0);
    t.timers.elapse(ACTION_QUIET_MS);
    await t.flushAll();

    const action = t.rendererSpans.find((s) => s.name === "polaris.action.data.table.open");

    const ipc = t.mainBatches
      .filter((b) => b.service === MAIN_SERVICE)
      .flatMap((b) => b.spans)
      .find((s) => s.name === "ipc.data.describe");

    expect(action?.parentId).toBeNull();
    expect(action?.attributes["polaris.action.label"]).toBe("Open table");
    expect(ipc?.traceId).toBe(action?.traceId ?? "");
    expect(ipc?.parentId).toBe(action?.id ?? "");
  });

  test("an action that sends nothing still ends as a childless root", async () => {
    const t = setup();

    t.actions.run("nav.mode", "Switch mode", () => undefined);
    t.timers.elapse(ACTION_QUIET_MS);
    await t.flushAll();

    expect(t.rendererSpans.map((s) => [s.name, s.parentId])).toEqual([
      ["polaris.action.nav.mode", null],
    ]);
    expect(t.mainBatches.flatMap((b) => b.spans)).toEqual([]);
  });

  test("an effect's request in the quiet time joins; one after the action ended does not", async () => {
    const t = setup();

    t.actions.run("data.tree.toggle", "Expand or collapse a tree row", () => undefined);
    void send(t.api, "data.describe");
    t.answer();
    await Bun.sleep(0);
    t.timers.elapse(ACTION_QUIET_MS);
    void send(t.api, "data.query");
    await t.flushAll();

    const [action] = t.rendererSpans;

    expect(t.sent.map((r) => [r.method, r.options?.trace?.traceparent])).toEqual([
      ["data.describe", `00-${action?.traceId}-${action?.id}-01`],
      ["data.query", undefined],
    ]);
  });

  test("while off an action makes no Span and requests go out untouched", async () => {
    const t = setup(false);

    t.actions.run("data.table.open", "Open table", () => {
      void send(t.api, "data.describe");
    });
    t.answer();
    await Bun.sleep(0);
    t.timers.elapse(ACTION_QUIET_MS);
    await t.flushAll();

    expect(t.sent.map((r) => r.options)).toEqual([undefined]);
    expect(t.rendererSpans).toEqual([]);
  });

  test("a stuck request can't hold the action past its bound", async () => {
    const t = setup();

    t.actions.run("data.table.open", "Open table", () => {
      void send(t.api, "data.describe");
    });
    t.timers.elapse(ACTION_BOUND_MS);
    await t.flushAll();

    expect(t.rendererSpans.map((s) => s.name)).toEqual(["polaris.action.data.table.open"]);
  });
});
