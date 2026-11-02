/** A renderer crash as main's crash log takes it: the message and stacks, never state. */
import {
  clip,
  CRASH_MESSAGE_MAX,
  CRASH_STACK_MAX,
  type RendererCrash,
  type RendererCrashKind,
} from "../../../shared/crash.ts";
import type { PolarisApi } from "../../../shared/api.ts";

export interface Described {
  readonly message: string;
  readonly stack?: string;
}

const text = (cause: unknown) => {
  try {
    return String(cause);
  } catch {
    return "an unprintable value";
  }
};

/** What a thrown value says: an Error's message and stack, anything else as text. */
export const describe = (cause: unknown): Described => {
  if (!(cause instanceof Error)) return { message: `Non-error thrown: ${text(cause)}` };

  const message = cause.message === "" ? cause.name : cause.message;

  return cause.stack === undefined ? { message } : { message, stack: cause.stack };
};

/** A report while it's built, optional fields added only when present. */
type CrashDraft = { -readonly [K in keyof RendererCrash]: RendererCrash[K] };

export interface CrashContext {
  readonly pane?: string;
  readonly componentStack?: string;
}

export const crashReport = (
  kind: RendererCrashKind,
  cause: unknown,
  context: CrashContext = {}
): RendererCrash => {
  const described = describe(cause);

  const report: CrashDraft = {
    kind,
    message: clip(described.message, CRASH_MESSAGE_MAX),
  };

  if (context.pane !== undefined) report.pane = clip(context.pane, 64);

  if (described.stack !== undefined) report.stack = clip(described.stack, CRASH_STACK_MAX);

  if (context.componentStack !== undefined && context.componentStack !== "") {
    report.componentStack = clip(context.componentStack, CRASH_STACK_MAX);
  }

  return report;
};

export type CrashReporter = (report: RendererCrash) => void;

const preload = (): Pick<PolarisApi, "reportCrash"> | null =>
  "polaris" in window ? window.polaris : null;

/** To main's crash log; previews and tests, with no preload, drop it. */
export const reportCrash: CrashReporter = (report) => {
  try {
    preload()?.reportCrash?.(report);
  } catch {
    // Reporting must never be what crashes the window.
  }
};

/** "Copy details": the title, the message, then the stacks, for a bug report. */
export const crashDetails = (title: string, report: RendererCrash) =>
  [
    title,
    report.message,
    report.stack,
    report.componentStack === undefined ? undefined : `Components:${report.componentStack}`,
  ]
    .filter((part) => part !== undefined)
    .join("\n\n");
