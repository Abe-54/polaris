import { expect, test } from "bun:test";
import { WorkspaceId } from "@polaris/protocol";
import { SELF_CHECKOUT } from "../../traces/self/scope.ts";
import { makeSpan, NOW, withStoredTools } from "./traces.testing.ts";

const trace = (n: number) => n.toString(16).padStart(32, "0");

const sid = (id: number) => id.toString(16).padStart(16, "0");

/** Milliseconds from the fixtures' NOW to the wall clock, so a span starts "now". */
const nowAt = () => Date.now() - Number(NOW / 1_000_000n);

test("trace_capture returns the spans that started in the window as trees under the action root, and none from before", () =>
  withStoredTools(async (f) => {
    f.setDeveloperMode(true);
    await f.ingest(
      [makeSpan(1, undefined, "before.window", 5, nowAt() - 1_000, trace(1))],
      "polaris-daemon",
      SELF_CHECKOUT
    );

    const call = f.tool("trace_capture").call({ seconds: 1, scope: "self" });

    await Bun.sleep(100);
    const at = nowAt();

    // As exporters deliver them: the Daemon's first, the renderer's action root last.
    await f.ingest(
      [makeSpan(4, 3, "data.describe", 60, at + 10, trace(2))],
      "polaris-daemon",
      SELF_CHECKOUT
    );
    await f.ingest(
      [makeSpan(3, 2, "ipc.data.describe", 80, at + 5, trace(2))],
      "polaris-desktop-main",
      SELF_CHECKOUT
    );
    await f.ingest(
      [makeSpan(2, undefined, "polaris.action.data.table.open", 120, at, trace(2))],
      "polaris-desktop-renderer",
      SELF_CHECKOUT
    );
    await f.ingest(
      [makeSpan(5, undefined, "git.status", 3, at + 50, trace(3))],
      "polaris-daemon",
      SELF_CHECKOUT
    );

    const result = await call;

    expect(result.structuredContent).toMatchObject({
      window: { scope: "self" },
      spans: 4,
      traceCount: 2,
      truncated: false,
      traces: [
        {
          id: trace(2),
          root: "polaris.action.data.table.open",
          action: true,
          spanCount: 3,
          spans: [
            { id: sid(2), parent: null, depth: 0, service: "polaris-desktop-renderer" },
            { id: sid(3), parent: sid(2), depth: 1, service: "polaris-desktop-main" },
            { id: sid(4), parent: sid(3), depth: 2, service: "polaris-daemon", offsetMs: 10 },
          ],
        },
        { id: trace(3), root: "git.status", action: false, spanCount: 1 },
      ],
    });

    const text = result.content[0]!.text;

    expect(text).toContain("4 spans in 2 traces");
    expect(text).toContain(
      `trace ${trace(2)}  polaris.action.data.table.open  polaris-desktop-renderer  3 spans  3 services`
    );
    expect(text).toContain(`      +10 ms  data.describe  polaris-daemon  60 ms  span ${sid(4)}`);
    expect(text).not.toContain("before.window");
  }));

test("trace_capture until returns once a matching span ends, long before the window would", () =>
  withStoredTools(async (f) => {
    const started = Date.now();
    const call = f.tool("trace_capture").call({ seconds: 30, until: "DESCRIBE" });

    await Bun.sleep(100);
    await f.ingest([makeSpan(6, undefined, "data.describe", 3, nowAt(), trace(6))]);

    const result = await call;

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.structuredContent).toMatchObject({
      window: { scope: "checkout", until: "DESCRIBE", matched: true },
      traces: [{ id: trace(6), root: "data.describe" }],
    });
    expect(result.content[0]!.text).toContain(`until "DESCRIBE" matched`);
  }));

test("trace_capture until ignores a match from before the window and runs the window out", () =>
  withStoredTools(async (f) => {
    await f.ingest([makeSpan(7, undefined, "data.describe", 3, nowAt() - 500, trace(7))]);

    const started = Date.now();
    const result = await f.tool("trace_capture").call({ seconds: 1, until: "describe" });

    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
    expect(result.structuredContent).toMatchObject({
      window: { until: "describe", matched: false },
      spans: 0,
      traces: [],
    });
    expect(result.content[0]!.text).toContain("no spans started in the window");
  }));

test("trace_capture scope self is refused at once with Developer Mode off or outside the Polaris Workspace", () =>
  withStoredTools(async (f) => {
    const refusal = async () => {
      const started = Date.now();
      const result = await f.tool("trace_capture").call({ seconds: 30, scope: "self" });

      expect(Date.now() - started).toBeLessThan(1_000);

      return result.structuredContent?.code;
    };

    expect(await refusal()).toBe("E-TRACE-UNAVAILABLE");
    f.setDeveloperMode(true, WorkspaceId.make("ws_other"));
    expect(await refusal()).toBe("E-TRACE-UNAVAILABLE");
  }));

test("trace_capture refuses a window outside 1–300 seconds and an empty until", () =>
  withStoredTools(async (f) => {
    for (const input of [{ seconds: 0 }, { seconds: 301 }, { until: "" }])
      expect((await f.tool("trace_capture").call(input)).structuredContent?.code).toBe("E-INPUT");
  }));
