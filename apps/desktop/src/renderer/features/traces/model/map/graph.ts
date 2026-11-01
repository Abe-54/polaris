/**
 * One trace's services and what called what (DESIGN.md, Traces → Service map): a call is a client
 * or producer span whose children run in another service, or any span with a child elsewhere;
 * a client span with no such child names an inferred dependency from its attributes.
 */
import type { Span, TraceAttributes, TraceTurn } from "@polaris/protocol";
import { Predicate } from "effect";
import type { TimedSpan, TraceTimes } from "../waterfall/trace.ts";
import { attributeText, inferTarget, matchService, protocolOf, type TargetKind } from "./infer.ts";

export type NodeKind = "service" | TargetKind;

export interface MapNode {
  readonly name: string;
  readonly kind: NodeKind;
  /** The service hue's index (first appearance); null for an inferred dependency. */
  readonly hue: number | null;
  /** A service's spans; an inferred dependency's calls into it. */
  readonly spans: number;
  readonly errors: number;
  /**
   * What entered it, slowest first: a service's server and consumer spans and spans called from
   * elsewhere (or from outside the trace); an inferred dependency's calls.
   */
  readonly requests: ReadonlyArray<TimedSpan>;
  readonly requestMs: number;
}

export interface MapEdge {
  readonly from: string;
  readonly to: string;
  readonly calls: number;
  /** The calls' summed durations, measured on the caller's side. */
  readonly ms: number;
  readonly errors: number;
  readonly protocol: string | null;
  /** Into an inferred dependency, which sent no spans of its own. */
  readonly inferred: boolean;
  /** How many of `from`'s requests made these calls, and the most any one of them made. */
  readonly requests: number;
  readonly perRequest: number;
  /** The most calls one span made, or one served request (a server or consumer span) made. */
  readonly repeated: number;
}

export interface Caller {
  /** The command that started the trace (`process.command_line`), when its root isn't a server. */
  readonly command: string | null;
  /** The Turn that launched it, else the Turn it ran in; null between Turns. */
  readonly turn: TraceTurn | null;
  /** A Turn is known to have launched it, rather than it only running during one. */
  readonly launched: boolean;
  /** Root spans per service, in the order they started. */
  readonly roots: ReadonlyMap<string, number>;
}

export interface ServiceMap {
  /** Services in hue order, then inferred dependencies in order of first call. */
  readonly nodes: ReadonlyArray<MapNode>;
  readonly edges: ReadonlyArray<MapEdge>;
  readonly caller: Caller;
}

const CALLS: ReadonlySet<Span["kind"]> = new Set(["client", "producer"]);

const ENTRIES: ReadonlySet<Span["kind"]> = new Set(["server", "consumer"]);

const duration = (s: TimedSpan) => s.end - s.start;

const slowestFirst = (a: TimedSpan, b: TimedSpan) => duration(b) - duration(a);

interface Call {
  readonly from: string;
  readonly to: string;
  /** The span timed as the call: the client span, or the callee's span without one. */
  readonly span: TimedSpan;
  /** The caller's span whose request made the call. */
  readonly via: TimedSpan;
  /** The span that made the call: calls under one span are a loop. */
  readonly by: TimedSpan;
  readonly protocol: string | null;
  readonly inferred: TargetKind | null;
}

/** The span that entered each span's service on its way to it, memoised along the path. */
const entries = (times: TraceTimes) => {
  const byId = new Map(times.spans.map((s) => [s.span.id, s]));
  const memo = new Map<string, TimedSpan>();

  const parentHere = (s: TimedSpan) => {
    const parent = s.span.parentId === null ? undefined : byId.get(s.span.parentId);

    return ENTRIES.has(s.span.kind) || parent?.span.service !== s.span.service ? undefined : parent;
  };

  return (span: TimedSpan): TimedSpan => {
    const path: Array<TimedSpan> = [];
    let at = span;
    let up = parentHere(at);

    while (up !== undefined && !memo.has(at.span.id) && path.length <= byId.size) {
      path.push(at);
      at = up;
      up = parentHere(at);
    }

    const entry = memo.get(at.span.id) ?? at;

    for (const s of [...path, at]) memo.set(s.span.id, entry);

    return entry;
  };
};

const CHILDREN_NONE: ReadonlyArray<TimedSpan> = [];

/** The span that made a client span's call: its nearest ancestor that isn't a call in its service. */
const makerOf = (byId: ReadonlyMap<string, TimedSpan>) => (s: TimedSpan) => {
  let at = s;

  for (let hops = 0; hops <= byId.size; hops++) {
    const parent = at.span.parentId === null ? undefined : byId.get(at.span.parentId);

    if (parent === undefined) return at;

    if (parent.span.service !== s.span.service || !CALLS.has(parent.span.kind)) return parent;
    at = parent;
  }

  return at;
};

/**
 * A client span's calls: into the services its children ran in, or the dependency it names.
 * One wrapping another client span (fetch over undici, an ORM over its driver) leaves it to that.
 */
const clientCalls = (
  s: TimedSpan,
  children: ReadonlyArray<TimedSpan>,
  services: ReadonlySet<string>,
  by: TimedSpan
): ReadonlyArray<Call> => {
  const from = s.span.service;
  const away = children.filter((k) => k.span.service !== from);

  if (away.length > 0) {
    const callees = new Map(away.map((k) => [k.span.service, k]));

    return [...callees].map(([to, child]) => ({
      from,
      to,
      span: s,
      via: s,
      by,
      protocol: protocolOf(s.span.attributes) ?? protocolOf(child.span.attributes),
      inferred: null,
    }));
  }

  if (children.some((k) => CALLS.has(k.span.kind))) return [];
  const target = inferTarget(s.span.attributes);

  if (target === null) return [];
  const service = matchService(target.name, services);

  if (service === from) return [];

  return [
    {
      from,
      to: service ?? target.name,
      span: s,
      via: s,
      by,
      protocol: target.protocol,
      inferred: service === null ? target.kind : null,
    },
  ];
};

const callsOf = (times: TraceTimes): ReadonlyArray<Call> => {
  const services = new Set(times.services.map((s) => s.name));
  const maker = makerOf(new Map(times.spans.map((s) => [s.span.id, s])));

  return times.spans.flatMap((s) => {
    const children = times.children.get(s.span.id) ?? CHILDREN_NONE;

    if (CALLS.has(s.span.kind)) return clientCalls(s, children, services, maker(s));

    return children
      .filter((k) => k.span.service !== s.span.service)
      .map((k) => ({
        from: s.span.service,
        to: k.span.service,
        span: k,
        via: s,
        by: s,
        protocol: protocolOf(k.span.attributes),
        inferred: null,
      }));
  });
};

/** How many distinct keys the items have, and the most items under one; a null key is skipped. */
const tally = <T>(items: ReadonlyArray<T>, key: (item: T) => string | null) => {
  const counts = new Map<string, number>();

  for (const item of items) {
    const k = key(item);

    if (k !== null) counts.set(k, (counts.get(k) ?? 0) + 1);
  }

  return { keys: counts.size, most: Math.max(0, ...counts.values()) };
};

const edgesOf = (calls: ReadonlyArray<Call>, entryOf: (s: TimedSpan) => TimedSpan) => {
  const grouped = Map.groupBy(calls, (c) => `${c.from}\u0000${c.to}`);

  const served = (c: Call) => {
    const entry = entryOf(c.via);

    return ENTRIES.has(entry.span.kind) ? entry.span.id : null;
  };

  return [...grouped.values()].flatMap((group): ReadonlyArray<MapEdge> => {
    const [first] = group;

    if (first === undefined) return [];
    const perEntry = tally(group, (c) => entryOf(c.via).span.id);

    return [
      {
        from: first.from,
        to: first.to,
        calls: group.length,
        ms: group.reduce((total, c) => total + duration(c.span), 0),
        errors: group.filter((c) => c.span.span.status === "error").length,
        protocol: group.find((c) => c.protocol !== null)?.protocol ?? null,
        inferred: first.inferred !== null,
        requests: perEntry.keys,
        perRequest: perEntry.most,
        repeated: Math.max(tally(group, (c) => c.by.span.id).most, tally(group, served).most),
      },
    ];
  });
};

const node = (
  name: string,
  kind: NodeKind,
  hue: number | null,
  spans: ReadonlyArray<TimedSpan>,
  requests: ReadonlyArray<TimedSpan>
): MapNode => ({
  name,
  kind,
  hue,
  spans: spans.length,
  errors: spans.filter((s) => s.span.status === "error").length,
  requests: requests.toSorted(slowestFirst),
  requestMs: requests.reduce((total, s) => total + duration(s), 0),
});

const serviceNodes = (times: TraceTimes, entryOf: (s: TimedSpan) => TimedSpan) => {
  const spans = Map.groupBy(times.spans, (s) => s.span.service);

  return times.services.map((service) => {
    const own = spans.get(service.name) ?? [];

    return node(
      service.name,
      "service",
      service.index,
      own,
      own.filter((s) => entryOf(s) === s)
    );
  });
};

const inferredNodes = (calls: ReadonlyArray<Call>) => {
  const into = Map.groupBy(
    calls.filter((c) => c.inferred !== null),
    (c) => c.to
  );

  return [...into].map(([name, group]) => {
    const spans = group.map((c) => c.span);

    return node(name, group[0]?.inferred ?? "remote", null, spans, spans);
  });
};

const text = attributeText;

const words = (value: TraceAttributes[string] | undefined) =>
  Array.isArray(value) && value.length > 0 && value.every(Predicate.isString)
    ? value.join(" ")
    : null;

/** The command a process ran, from its OTel resource. */
export const commandOf = (resource: TraceAttributes): string | null =>
  text(resource, "process.command_line") ??
  words(resource["process.command_args"]) ??
  text(resource, "process.command");

const callerOf = (times: TraceTimes): Caller => {
  const roots = times.children.get(null) ?? [];
  const first = roots[0]?.span;
  const counts = new Map<string, number>();

  for (const r of roots) counts.set(r.span.service, (counts.get(r.span.service) ?? 0) + 1);

  return {
    command: first === undefined || ENTRIES.has(first.kind) ? null : commandOf(first.resource),
    turn: first?.polaris.launchedTurn ?? first?.polaris.turn ?? null,
    launched: (first?.polaris.launchedTurn ?? null) !== null,
    roots: counts,
  };
};

export const serviceMap = (times: TraceTimes): ServiceMap => {
  const entryOf = entries(times);
  const calls = callsOf(times);

  return {
    nodes: [...serviceNodes(times, entryOf), ...inferredNodes(calls)],
    edges: edgesOf(calls, entryOf),
    caller: callerOf(times),
  };
};
