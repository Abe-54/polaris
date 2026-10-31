/** Small traces for the service map's tests: spans by number, mapped through the real model. */
import type { Span, TraceAttributes, TraceTurn } from "@polaris/protocol";
import { buildTrace, type SpanSpec } from "../../preview/build.ts";
import { FIXTURE_CHECKOUT } from "../../preview/fixtures.ts";
import { traceTimes } from "../waterfall/index.ts";
import { type ServiceMap, serviceMap } from "./graph.ts";

const id = (n: number) => n.toString(16).padStart(16, "0");

/** Span `n` under span `parent`, starting at n ms and lasting 100 − n. */
export const spanAt = (
  n: number,
  parent: number | null,
  service: string,
  kind: Span["kind"],
  attributes: TraceAttributes = {}
): SpanSpec => ({
  id: id(n),
  parent: parent === null ? null : id(parent),
  name: `${kind} ${n}`,
  service,
  kind,
  at: n,
  ms: 100 - n,
  attributes,
});

export const mapOfSpans = (
  spans: ReadonlyArray<SpanSpec>,
  turns: { readonly turn?: TraceTurn | null; readonly launchedTurn?: TraceTurn | null } = {}
): ServiceMap =>
  serviceMap(
    traceTimes(
      buildTrace(
        {
          id: "0123456789abcdef0123456789abcdef",
          startedAt: "2026-10-31T14:00:00.000Z",
          turn: turns.turn ?? null,
          launchedTurn: turns.launchedTurn ?? null,
          spans,
        },
        FIXTURE_CHECKOUT
      )
    )
  );

export const edgeLines = (map: ServiceMap) =>
  map.edges.map((e) => `${e.from} → ${e.to} ×${e.calls}`).toSorted();
