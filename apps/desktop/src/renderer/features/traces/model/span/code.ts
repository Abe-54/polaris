/**
 * Where a Span's code is: its `code.*` location (semantic conventions, old names too) and an
 * exception's stack as frames, the checkout's own frames first.
 */
import type { Span, TraceAttributes } from "@polaris/protocol";
import { Predicate } from "effect";

type SpanEvent = Span["events"][number];

export interface CodeLocation {
  /** Relative to the checkout when inside it, else as the exporter sent it. */
  readonly path: string;
  readonly line: number | null;
  readonly column: number | null;
}

const first = (attributes: TraceAttributes, keys: ReadonlyArray<string>) =>
  keys.map((k) => attributes[k]).find((v) => v !== undefined && v !== null);

/** int64 attributes arrive as decimal strings (TraceAttributes). */
const whole = (value: TraceAttributes[string] | undefined): number | null => {
  const n = Predicate.isString(value) ? Number(value) : value;

  return Predicate.isNumber(n) && Number.isInteger(n) && n > 0 ? n : null;
};

const FILE_URL = /^file:\/\//;

/** `path` relative to `checkout` when it lies inside it; null when it lies outside. */
const insideCheckout = (path: string, checkout: string): string | null => {
  const plain = path.replace(FILE_URL, "");

  if (!plain.startsWith("/")) return plain;
  const root = checkout.endsWith("/") ? checkout : `${checkout}/`;

  return plain.startsWith(root) ? plain.slice(root.length) : null;
};

export const codeLocation = (
  attributes: TraceAttributes,
  checkout: string
): CodeLocation | null => {
  const path = first(attributes, ["code.file.path", "code.filepath"]);

  if (!Predicate.isString(path) || path === "") return null;

  return {
    path: insideCheckout(path, checkout) ?? path.replace(FILE_URL, ""),
    line: whole(first(attributes, ["code.line.number", "code.lineno"])),
    column: whole(first(attributes, ["code.column.number", "code.column"])),
  };
};

/** "overdue.ts:61": the file's name and line, as the panel's button shows it. */
export const locationLabel = ({ path, line }: CodeLocation) => {
  const name = path.slice(path.lastIndexOf("/") + 1);

  return line === null ? name : `${name}:${line}`;
};

export interface StackFrame {
  readonly fn: string | null;
  readonly location: CodeLocation;
  /** In this checkout and not a dependency or the runtime. */
  readonly inProject: boolean;
}

export interface ExceptionView {
  readonly type: string | null;
  readonly message: string | null;
  /** The checkout's frames first, then the rest, each in stack order. */
  readonly frames: ReadonlyArray<StackFrame>;
}

/** V8 and JavaScriptCore frames: `at fn (path:line:col)` or `at path:line:col`. */
const FRAME = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;

const RUNTIME = /^(node:|bun:|internal\/|native)/;

const frameOf = (line: string, checkout: string): StackFrame | null => {
  const m = FRAME.exec(line);

  if (m === null) return null;
  const [, fn, rawPath = "", lineNo, col] = m;
  const inside = insideCheckout(rawPath, checkout);
  const path = inside ?? rawPath.replace(FILE_URL, "");

  return {
    fn: fn === undefined || fn === "<anonymous>" ? null : fn.replace(/^async /, ""),
    location: { path, line: Number(lineNo), column: Number(col) },
    inProject: inside !== null && !RUNTIME.test(path) && !path.includes("node_modules/"),
  };
};

/** The frames of `stack`, the checkout's own first. */
export const stackFrames = (stack: string, checkout: string): ReadonlyArray<StackFrame> => {
  const frames = stack
    .split("\n")
    .map((l) => frameOf(l, checkout))
    .filter((f) => f !== null);

  return [...frames.filter((f) => f.inProject), ...frames.filter((f) => !f.inProject)];
};

const text = (value: TraceAttributes[string] | undefined) =>
  Predicate.isString(value) && value !== "" ? value : null;

/** An `exception` event (semantic conventions) as type, message and frames; null for others. */
export const exceptionOf = (
  event: Pick<SpanEvent, "name" | "attributes">,
  checkout: string
): ExceptionView | null => {
  if (event.name !== "exception") return null;
  const a = event.attributes;

  return {
    type: text(a["exception.type"]),
    message: text(a["exception.message"]),
    frames: stackFrames(text(a["exception.stacktrace"]) ?? "", checkout),
  };
};
