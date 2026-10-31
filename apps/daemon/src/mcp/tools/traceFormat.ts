import { Schema } from "effect";
import type { TraceHistory } from "../../traces/workerProtocol.ts";
import type { Span, TraceDetail } from "@polaris/protocol";

export const TRACE_CAP = 16_000;

export const inline = (value: string) =>
  Array.from(value, (char) =>
    char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char
  ).join("");

export const duration = (ms: number) =>
  `${Number((ms >= 1000 ? ms / 1000 : ms).toFixed(1))} ${ms >= 1000 ? "s" : "ms"}`;

export const offset = (span: Span, start: string) =>
  duration(Number(BigInt(span.startTimeUnixNano) - BigInt(start)) / 1e6);

const clipped = (value: string, cap: number, section: string, tool: string) =>
  value.length <= cap
    ? value
    : `${value.slice(0, cap)}… (${value.length - cap} ${section} chars folded; use ${tool} structuredContent)`;

const inProject = (frame: string, checkout: string) => {
  const normalized = frame.replaceAll("\\", "/");
  const root = checkout.replaceAll("\\", "/");

  return (
    !normalized.includes("node_modules/") &&
    (normalized.includes(`${root}/`) ||
      /(?:\(|at )(?:\.\/)?(?:src|app|apps|packages)\//.test(normalized))
  );
};

export const projectFrames = (stack: string, checkout: string) => {
  const frames = stack.split("\n");

  return [
    ...frames.filter((frame) => inProject(frame, checkout)),
    ...frames.filter((frame) => !inProject(frame, checkout)),
  ];
};

export const attributeValue = (
  value: typeof Schema.Json.Type | undefined,
  fallback = ""
): string =>
  value === undefined ? fallback : Schema.is(Schema.String)(value) ? value : JSON.stringify(value);

export const exceptionLines = (span: Span) => {
  const exceptions = span.events.filter((event) => event.name === "exception");

  const events = exceptions.slice(0, 1).flatMap((event) => {
    const attrs = event.attributes;

    const kind = clipped(
      inline(attributeValue(attrs["exception.type"], "Exception")),
      200,
      "exception type",
      "span"
    );

    const message = clipped(
      inline(attributeValue(attrs["exception.message"], span.statusMessage)),
      1800,
      "exception message",
      "span"
    );

    const frame = projectFrames(
      attributeValue(attrs["exception.stacktrace"]),
      span.polaris.checkout
    ).find((line) => inProject(line, span.polaris.checkout));

    return [
      `${kind}: ${message}${frame ? ` · ${clipped(inline(frame.trim()), 600, "frame", "span")}` : ""}`,
    ];
  });

  if (exceptions.length > 1)
    events.push(`… ${exceptions.length - 1} exception events folded; use span for details.`);

  if (events.length === 0 && span.status === "error" && span.statusMessage.length > 0)
    events.push(clipped(inline(span.statusMessage), 1800, "status message", "span"));

  return events;
};

/** A line is atomic; the footer states omitted content and how to retrieve it. */
export const capSections = (lines: ReadonlyArray<string>, tool: string) => {
  const kept: string[] = [];
  const omissions = new Map<string, number>();
  let section = "header";
  let size = 0;

  for (const line of lines) {
    if (["attributes", "polaris", "resource", "scope", "events", "links"].includes(line))
      section = line;

    if (line.startsWith("logs ·")) section = "logs";

    if (size + line.length + 1 > TRACE_CAP - 1200) {
      omissions.set(section, (omissions.get(section) ?? 0) + 1);
      continue;
    }

    kept.push(line);
    size += line.length + 1;
  }

  for (const [name, count] of omissions)
    kept.push(
      `… ${name}: ${count} detail lines folded; use ${tool} structuredContent for the full retained data.`
    );

  return kept.join("\n");
};

interface Group {
  spans: Span[];
  children: Group[];
  parent: Group | null;
  depth: number;
}

const total = (group: Group) => group.spans.reduce((sum, span) => sum + span.durationMs, 0);

const first = (group: Group) => group.spans[0]!;

const addSiblings = (
  siblings: Span[],
  parent: Group | null,
  out: Group[],
  groups: Group[],
  visited: Set<string>
) => {
  const names = new Map<string, Group>();

  for (const span of siblings) {
    if (visited.has(span.id)) continue;

    visited.add(span.id);

    const key = JSON.stringify([
      span.status === "error" ? span.id : span.name,
      span.status === "error",
    ]);

    const existing = names.get(key);

    if (existing) existing.spans.push(span);
    else {
      const group: Group = {
        spans: [span],
        children: [],
        parent,
        depth: parent === null ? 0 : parent.depth + 1,
      };

      names.set(key, group);
      out.push(group);
      groups.push(group);
    }
  }
};

const makeGroups = (spans: ReadonlyArray<Span>) => {
  const byId = new Map(spans.map((span) => [span.id, span]));
  const children = new Map<string | null, Span[]>();

  for (const span of spans) {
    const parent = span.parentId !== null && byId.has(span.parentId) ? span.parentId : null;
    const siblings = children.get(parent) ?? [];
    siblings.push(span);
    children.set(parent, siblings);
  }

  const roots: Group[] = [];
  const groups: Group[] = [];
  const visited = new Set<string>();

  const pending: Array<{ parents: Array<string | null>; parent: Group | null; out: Group[] }> = [
    { parents: [null], parent: null, out: roots },
  ];

  while (pending.length > 0) {
    const task = pending.pop()!;

    const siblings = task.parents
      .flatMap((id) => children.get(id) ?? [])
      .sort((a, b) => Number(BigInt(a.startTimeUnixNano) - BigInt(b.startTimeUnixNano)));

    addSiblings(siblings, task.parent, task.out, groups, visited);

    for (const group of task.out)
      pending.push({
        parents: group.spans.map((span) => span.id),
        parent: group,
        out: group.children,
      });
  }

  // Malformed parent cycles are retained as roots rather than disappearing from the summary.
  for (const span of spans) {
    if (!visited.has(span.id)) {
      const group: Group = { spans: [span], children: [], parent: null, depth: 0 };
      roots.push(group);
      groups.push(group);
    }
  }

  return { roots, groups };
};

const groupLine = (group: Group, detail: TraceDetail, history: TraceHistory) => {
  const span = first(group);

  const names = [...new Set(group.spans.map((member) => member.service))];
  const parentNames = group.parent?.spans.map((member) => member.service) ?? [];

  const service =
    names.length > 1 || parentNames.some((name) => name !== span.service) || group.parent === null
      ? `  ${names.map(inline).join(", ")}`
      : "";

  const indent = "  ".repeat(group.depth);
  const usual = history.spans[span.id];

  const slow =
    usual !== undefined && span.durationMs > 20 && span.durationMs > 3 * usual
      ? `  SLOW (usually ${duration(usual)})`
      : "";

  const lead = `+${offset(span, detail.summary.startTimeUnixNano)}  ${duration(total(group))}  ${indent}`;

  if (group.spans.length === 1)
    return `${lead}${clipped(inline(span.name), 1000, "name", "span")}${service}${span.status === "error" ? "  ERROR" : ""}${slow}  span ${span.id.slice(0, 8)}`;
  const sorted = group.spans.map((s) => s.durationMs).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const p50 = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  const nplus = new Map<string | null, number>();

  for (const s of group.spans) nplus.set(s.parentId, (nplus.get(s.parentId) ?? 0) + 1);
  const hint = [...nplus.values()].some((n) => n > 20) ? "  (N+1?)" : "";

  return `${lead}×${group.spans.length} ${clipped(inline(span.name), 1000, "name", "span")}${service}  p50 ${duration(p50)}  total ${duration(total(group))}${slow}${hint}`;
};

const header = (detail: TraceDetail) => {
  const summary = detail.summary;
  const services = new Map<string, { count: number; time: number }>();

  for (const span of detail.spans) {
    const current = services.get(span.service) ?? { count: 0, time: 0 };
    current.count++;
    current.time += span.durationMs;
    services.set(span.service, current);
  }

  const names = [...services]
    .map(([name, value]) => `${inline(name)} ${value.count} (${duration(value.time)})`)
    .join(", ");

  return `${inline(summary.root)} · ${duration(summary.durationMs)} · ${summary.spans} spans · ${names} · ${summary.turn === null ? "between turns" : `turn ${summary.turn.number}`} · ${summary.errors} errors${summary.partial ? " · partial" : ""}`;
};

const orderedGroups = (roots: Group[], groups: Group[], focus: "slow" | "errors" | "all") => {
  const priority: Group[] = [];
  const queued = new Set<Group>();

  const path = (group: Group) => {
    const ancestors: Group[] = [];
    let current: Group | null = group;

    while (current !== null && !queued.has(current)) {
      ancestors.push(current);
      current = current.parent;
    }

    for (const ancestor of ancestors.reverse()) {
      queued.add(ancestor);
      priority.push(ancestor);
    }
  };

  for (const group of groups.filter((g) => g.spans.some((s) => s.status === "error"))) path(group);

  if (focus !== "errors") {
    let critical = [...roots].sort(
      (a, b) =>
        Math.max(...b.spans.map((span) => span.durationMs)) -
        Math.max(...a.spans.map((span) => span.durationMs))
    )[0];

    while (critical !== undefined) {
      path(critical);
      critical = [...critical.children].sort(
        (a, b) =>
          Math.max(...b.spans.map((span) => span.durationMs)) -
          Math.max(...a.spans.map((span) => span.durationMs))
      )[0];
    }

    for (const group of [...groups].sort((a, b) => total(b) - total(a))) path(group);
  }

  if (focus === "all") {
    priority.length = 0;
    const pending = [...roots].reverse();

    while (pending.length > 0) {
      const group = pending.pop()!;
      priority.push(group);
      pending.push(
        ...[...group.children].sort((a, b) =>
          Number(BigInt(first(b).startTimeUnixNano) - BigInt(first(a).startTimeUnixNano))
        )
      );
    }
  }

  return priority;
};

export const traceView = (
  detail: TraceDetail,
  focus: "slow" | "errors" | "all",
  history: TraceHistory
) => {
  const { roots, groups } = makeGroups(detail.spans);
  const priority = orderedGroups(roots, groups, focus);
  const title = header(detail);
  const lines = [clipped(title, 4000, "header", "trace")];
  let size = lines[0]!.length;
  const displayed: Span[] = [];
  const displayedIds = new Set<string>();
  const selected = new Set<Group>();

  for (const group of priority) {
    if (group.parent !== null && !selected.has(group.parent)) continue;

    const block = [
      groupLine(group, detail, history),
      ...group.spans
        .filter((span) => span.status === "error")
        .flatMap(exceptionLines)
        .map((s) => `  ${s}`),
    ];

    const length = block.join("\n").length + 1;

    if (size + length > TRACE_CAP - 160) continue;
    lines.push(...block);
    size += length;
    selected.add(group);
    displayed.push(...group.spans);

    for (const span of group.spans) displayedIds.add(span.id);
  }

  const omitted = detail.spans.filter((span) => !displayedIds.has(span.id));

  if (omitted.length > 0) {
    const max = Math.max(...omitted.map((span) => span.durationMs));
    lines.push(
      `… ${omitted.length} spans under ${Math.floor(max) + 1} ms folded; use span for details.`
    );
  }

  return {
    text: lines.join("\n"),
    data: {
      summary: detail.summary,
      spans: displayed,
      folded: {
        count: omitted.length,
        underMs:
          omitted.length === 0
            ? 0
            : Math.floor(Math.max(...omitted.map((span) => span.durationMs))) + 1,
      },
    },
  };
};
