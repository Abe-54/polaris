/**
 * ⌘L's text (DESIGN.md, Traces → Trace bar): the open trace, and the selected span if any, as a
 * reference an agent can look up by id, appended after the session's draft as Data's ⌘L does.
 */
import type { Span, TraceSummary } from "@polaris/protocol";
import { durationLabel } from "./waterfall/time.ts";

const count = (n: number, one: string) =>
  `${n.toLocaleString("en-US")} ${one}${n === 1 ? "" : "s"}`;

const turnPart = (summary: TraceSummary, other: string | null) => {
  if (summary.turn === null) return "between turns";

  return other === null ? `turn ${summary.turn.number}` : `turn ${summary.turn.number} of ${other}`;
};

/** `other` names the session whose Turn ran the trace when it isn't the draft's own session. */
export const traceReference = (
  summary: TraceSummary,
  span: Span | null,
  other: string | null = null
): string => {
  const facts = [
    durationLabel(summary.durationMs),
    count(summary.spans, "span"),
    ...(summary.errors > 0 ? [count(summary.errors, "error")] : []),
    turnPart(summary, other),
    ...(summary.partial ? ["partial: some spans were removed"] : []),
  ];

  const trace = `Trace \`${summary.id}\` in this checkout: \`${summary.root}\` (${summary.service}), ${facts.join(", ")}`;

  if (span === null) return trace;

  return `${trace}\nSpan \`${span.id}\`: \`${span.name}\` (${span.service}), ${durationLabel(span.durationMs)}${span.status === "error" ? ", error" : ""}`;
};

/** After the draft with a blank line, or alone in an empty one. */
export const appendReference = (draft: string, text: string) =>
  draft.trim() === "" ? text : `${draft.trimEnd()}\n\n${text}`;
