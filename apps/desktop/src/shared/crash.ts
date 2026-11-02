/**
 * A renderer crash as it crosses IPC to main's crash log (ENG-757): what failed and where,
 * never application state. Lengths are capped on both sides.
 */
import { Schema } from "effect";

export const CRASH_MESSAGE_MAX = 2_000;

export const CRASH_STACK_MAX = 16_000;

/** Where the renderer saw it: an error boundary, `window` "error" or "unhandledrejection". */
export const RendererCrashKind = Schema.Literals(["boundary", "error", "unhandledrejection"]);

export type RendererCrashKind = typeof RendererCrashKind.Type;

const capped = (max: number) => Schema.String.check(Schema.isMaxLength(max));

export const RendererCrash = Schema.Struct({
  kind: RendererCrashKind,
  /** The boundary's pane ("review", "shell"…), for a boundary's report. */
  pane: Schema.optionalKey(capped(64)),
  message: capped(CRASH_MESSAGE_MAX),
  stack: Schema.optionalKey(capped(CRASH_STACK_MAX)),
  componentStack: Schema.optionalKey(capped(CRASH_STACK_MAX)),
});

export type RendererCrash = typeof RendererCrash.Type;

/** Cuts a string to `max` characters, marking the cut. */
export const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;
