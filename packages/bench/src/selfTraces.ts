/**
 * A Client's Self-Traces under load (`--client-self-traces`, ENG-715): each bench Client sends a
 * batch of synthetic Spans with `traces.ingestSelf` once a second, as the Client exporter flushes.
 */
import { randomBytes } from "node:crypto";
import type { SelfSpan } from "@polaris/protocol";
import { Duration, Effect, Schedule } from "effect";
import type { Client } from "./daemon.ts";

/** The Client exporter's flush delay (`DEFAULT_FLUSH_DELAY_MS` in `@polaris/client`). */
const FLUSH_MS = 1_000;

/** Spans per Client per flush: well above what the Desktop App traces today (only `dispatch`). */
export const SELF_SPANS_PER_BATCH = 100;

export interface SelfTraceTally {
  accepted: number;
  failed: number;
}

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

const spanAt = (traceId: string, parentId: string | null, endNs: bigint, i: number): SelfSpan => ({
  traceId,
  id: hex(8),
  parentId,
  name: i === 0 ? "dispatch" : "ipc.request",
  kind: i === 0 ? "client" : "internal",
  status: "ok",
  statusMessage: "",
  traceState: "",
  startTimeUnixNano: String(endNs - 2_000_000n),
  endTimeUnixNano: String(endNs),
  attributes: { "rpc.method": "dispatch", "polaris.bench": true },
  resource: { "service.name": "polaris-desktop-renderer" },
  scope: { name: "polaris-bench", version: "0", attributes: {} },
  events: [],
  links: [],
  droppedAttributes: 0,
  droppedEvents: 0,
  droppedLinks: 0,
});

/** One flush: traces of ten Spans each (a root and its children), ended just now. */
export const selfTraceBatch = (spans = SELF_SPANS_PER_BATCH): ReadonlyArray<SelfSpan> => {
  const endNs = BigInt(Date.now()) * 1_000_000n;
  const batch: Array<SelfSpan> = [];

  while (batch.length < spans) {
    const traceId = hex(16);
    const root = spanAt(traceId, null, endNs, 0);
    batch.push(root);

    for (let i = 1; i < 10 && batch.length < spans; i++) {
      batch.push(spanAt(traceId, root.id, endNs, i));
    }
  }

  return batch;
};

/** Sends a batch every second for as long as the enclosing scope lives. */
export const sendSelfTraces = (client: Client, tally: SelfTraceTally) =>
  client.connection.client["traces.ingestSelf"]({
    service: "polaris-desktop-renderer",
    spans: selfTraceBatch(),
  }).pipe(
    Effect.tap(({ accepted }) =>
      Effect.sync(() => {
        tally.accepted += accepted;
      })
    ),
    Effect.catch(() =>
      Effect.sync(() => {
        tally.failed += 1;
      })
    ),
    Effect.repeat(Schedule.spaced(Duration.millis(FLUSH_MS))),
    Effect.forkScoped
  );
