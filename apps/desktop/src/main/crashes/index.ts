/**
 * Crash evidence (ENG-757): renderer crashes and the window's own signals go to the crash log
 * (log.ts) and, while Developer Mode is on, become failed Self-Trace Spans.
 */
import { basename } from "node:path";
import { Effect, type Tracer } from "effect";
import type { Event as ElectronEvent } from "electron";
import type { RendererCrash } from "../../shared/crash.ts";
import { type CrashEntry, type CrashLog, createCrashLog } from "./log.ts";

export { type CrashEntry, type CrashLog, createCrashLog };

export type CrashSink = (entry: CrashEntry) => void;

/** A failed Span per entry; the gated tracer drops it while Self-Traces are off. */
export const crashSpans =
  (tracer: Tracer.Tracer): CrashSink =>
  (entry) => {
    const base = { ...entry.detail, "crash.process": entry.process, "crash.kind": entry.kind };

    const pane = entry.pane === undefined ? base : { ...base, "crash.pane": entry.pane };

    const attributes =
      entry.stack === undefined ? pane : { ...pane, "exception.stacktrace": entry.stack };

    Effect.runFork(
      Effect.fail(entry.message).pipe(
        Effect.withSpan(`desktop.crash.${entry.kind}`, { attributes }),
        Effect.withTracer(tracer),
        Effect.ignore
      )
    );
  };

/** Writes each entry to every sink, and to stderr for a terminal-launched app. */
export const crashRecorder =
  (...sinks: ReadonlyArray<CrashSink>): CrashSink =>
  (entry) => {
    console.error(`polaris: ${entry.process} ${entry.kind}: ${entry.message}`);

    for (const sink of sinks) sink(entry);
  };

export const rendererCrashEntry = (report: RendererCrash): CrashEntry => ({
  process: "renderer",
  ...report,
});

interface ConsoleDetails {
  readonly level: string;
  readonly message: string;
  readonly lineNumber: number;
  readonly sourceId: string;
}

/** The slice of `WebContents` watched here, so tests can drive it with an EventEmitter. */
export interface WatchedContents {
  on(
    event: "render-process-gone",
    listener: (event: ElectronEvent, details: { reason: string; exitCode: number }) => void
  ): this;
  on(event: "unresponsive" | "responsive", listener: () => void): this;
  on(
    event: "preload-error",
    listener: (event: ElectronEvent, preloadPath: string, error: Error) => void
  ): this;
  on(event: "console-message", listener: (details: ConsoleDetails) => void): this;
}

const CONSOLE_BUDGET = 20;

const CONSOLE_WINDOW_MS = 60_000;

/** Console errors past 20 a minute are dropped, so a loop can't roll real crashes out of the log. */
const consoleBudget = (now: () => number) => {
  let start = now();
  let used = 0;

  return () => {
    if (now() - start > CONSOLE_WINDOW_MS) {
      start = now();
      used = 0;
    }

    used += 1;

    return used <= CONSOLE_BUDGET;
  };
};

export const watchWindowCrashes = (
  contents: WatchedContents,
  record: CrashSink,
  now: () => number = Date.now
) => {
  const allowConsole = consoleBudget(now);

  const signal = (kind: string, message: string, extra: Partial<CrashEntry> = {}) =>
    record({ process: "main", kind, message, ...extra });

  contents.on("render-process-gone", (_event, details) =>
    signal("render-process-gone", `The renderer process ended: ${details.reason}`, {
      detail: { reason: details.reason, exitCode: details.exitCode },
    })
  );
  contents.on("unresponsive", () => signal("unresponsive", "The window stopped responding"));
  contents.on("responsive", () => signal("responsive", "The window responds again"));
  contents.on("preload-error", (_event, preloadPath, error) => {
    const extra: Partial<CrashEntry> = { detail: { preload: basename(preloadPath) } };

    signal(
      "preload-error",
      error.message,
      error.stack === undefined ? extra : { ...extra, stack: error.stack }
    );
  });
  contents.on("console-message", (details) => {
    if (details.level !== "error" || !allowConsole()) return;
    signal("console-error", details.message, {
      detail: { source: details.sourceId, line: details.lineNumber },
    });
  });
};
