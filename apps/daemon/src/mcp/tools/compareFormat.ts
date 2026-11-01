import type { TraceComparison } from "@polaris/protocol";
import { duration, inline, TRACE_CAP } from "./traceFormat.ts";

const name = (value: string) => {
  const text = inline(value);

  const points = Array.from(text);

  return points.length > 240
    ? `${points.slice(0, 240).join("")}… (${points.length - 240} chars omitted; full name in structuredContent)`
    : text;
};

const row = (route: TraceComparison["routes"][number]) => {
  const before = route.before;
  const after = route.after;

  const timing =
    before.p50Ms === null || after.p50Ms === null
      ? "no baseline"
      : `p50 ${duration(before.p50Ms)} → ${duration(after.p50Ms)}  p95 ${duration(before.p95Ms!)} → ${duration(after.p95Ms!)}`;

  const span = route.slowestNew;

  return [
    `${name(route.route)}  ${name(route.service)}  ${timing}  runs ${before.count} → ${after.count}`,
    ...(span === undefined
      ? []
      : [
          `  slowest new span: ${name(span.name)}  ${name(span.service)}  ${duration(span.durationMs)}  trace ${span.traceId}  span ${span.spanId}`,
        ]),
    ...(route.partial === undefined
      ? []
      : [`  partial traces excluded: ${route.partial.before} → ${route.partial.after}`]),
  ].join("\n");
};

export const compareView = (comparison: TraceComparison) => {
  const rows = comparison.routes.map(row);
  const header = `Route timings · retained traces only · ${rows.length} ${rows.length === 1 ? "route" : "routes"}`;

  const footer = (shown: number) =>
    shown < rows.length
      ? `\n… ${rows.length - shown} routes omitted; use compare structuredContent for all routes, then trace or span with the returned ids.`
      : "";

  let count = 0;
  let length = header.length;

  while (
    count < rows.length &&
    length + 1 + rows[count]!.length + footer(count + 1).length <= TRACE_CAP
  ) {
    length += 1 + rows[count]!.length;
    count++;
  }

  return { text: [header, ...rows.slice(0, count)].join("\n") + footer(count), data: comparison };
};
