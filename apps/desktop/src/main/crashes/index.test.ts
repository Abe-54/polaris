import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { SelfTraceBatch } from "@polaris/protocol";
import { createDesktopSelfTraces } from "../selfTraces/index.ts";
import { testDeveloperModeSource } from "../selfTraces/source.testing.ts";
import { type CrashEntry, crashSpans, watchWindowCrashes } from "./index.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test.each([true, false])(
  "a crash is a failed Self-Trace Span only while Developer Mode is on (%p)",
  async (enabled) => {
    const sent: Array<SelfTraceBatch> = [];

    const traces = createDesktopSelfTraces({
      version: "1.0.0",
      source: testDeveloperModeSource({ hostKey: "studio", enabled }).source,
      flushDelayMs: 0,
    });

    traces.bind(async (_hostKey, batch) => {
      sent.push(batch);

      return "sent";
    });
    crashSpans(traces.tracer)({
      process: "renderer",
      kind: "boundary",
      pane: "review",
      message: "destroy is not a function",
    });
    await settle();
    await traces.flush();

    const spans = sent.flatMap((batch) => batch.spans);

    expect(spans.map((s) => [s.name, s.status, s.attributes["crash.pane"]])).toEqual(
      enabled ? [["desktop.crash.boundary", "error", "review"]] : []
    );
    traces.dispose();
  }
);

const watched = (now: () => number = () => 0) => {
  const contents = new EventEmitter();
  const entries: Array<CrashEntry> = [];

  watchWindowCrashes(contents, (entry) => entries.push(entry), now);

  return { contents, entries };
};

test("a renderer that dies is recorded with its reason and exit code", () => {
  const { contents, entries } = watched();

  contents.emit("render-process-gone", {}, { reason: "oom", exitCode: -536_870_904 });

  expect(entries).toEqual([
    {
      process: "main",
      kind: "render-process-gone",
      message: "The renderer process ended: oom",
      detail: { reason: "oom", exitCode: -536_870_904 },
    },
  ]);
});

test("a hung window, a failed preload and console errors are recorded; other console levels aren't", () => {
  const { contents, entries } = watched();
  const failure = new Error("preload broke");

  contents.emit("unresponsive");
  contents.emit("preload-error", {}, "/app/out/preload/index.cjs", failure);
  contents.emit("console-message", {
    level: "warning",
    message: "w",
    lineNumber: 1,
    sourceId: "a",
  });
  contents.emit("console-message", { level: "error", message: "e", lineNumber: 2, sourceId: "b" });

  expect(entries.map((e) => [e.kind, e.message, e.detail])).toEqual([
    ["unresponsive", "The window stopped responding", undefined],
    ["preload-error", "preload broke", { preload: "index.cjs" }],
    ["console-error", "e", { source: "b", line: 2 }],
  ]);
});

test("console errors past 20 a minute are dropped, then allowed again", () => {
  let clock = 0;
  const { contents, entries } = watched(() => clock);

  const error = () =>
    contents.emit("console-message", {
      level: "error",
      message: "loop",
      lineNumber: 1,
      sourceId: "a",
    });

  for (let i = 0; i < 50; i++) error();

  expect(entries).toHaveLength(20);

  clock = 61_000;
  error();
  expect(entries).toHaveLength(21);
});
