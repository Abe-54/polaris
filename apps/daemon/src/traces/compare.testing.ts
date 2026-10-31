import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { TraceCompareSelector, TraceTurn, TurnId } from "@polaris/protocol";
import { TraceStore } from "./store.ts";
import { TEST_SESSION, TEST_WORKSPACE, spanFixture, traceFixture } from "./testing.ts";
import type { IngestContext } from "./ingest.ts";
import type { TraceWorkerOptions } from "./workerClient.ts";

export const turnSelector = (number: number) =>
  TraceCompareSelector.cases.Turn.make({ turnId: TurnId.make(`compare-${number}`) });

export const baseline = TraceCompareSelector.cases.Baseline.make({});

const contextAt = (now: bigint) =>
  ({
    checkout: "/tmp/compare-checkout",
    workspaceId: TEST_WORKSPACE,
    sessionId: TEST_SESSION,
    turns: [0, 1, 2, 3].map((number) => ({
      turn: TraceTurn.make({
        sessionId: TEST_SESSION,
        id: turnSelector(number).turnId,
        number: number + 1,
      }),
      start: (now + BigInt(number - 3) * 10_000_000_000n).toString(),
      end: (now + BigInt(number - 2) * 10_000_000_000n).toString(),
    })),
  }) satisfies IngestContext;

export let compareContext: IngestContext = contextAt(BigInt(Date.now()) * 1_000_000n);

interface IngestOptions {
  route?: string;
  service?: string;
  checkout?: string;
  child?: { name: string; ms: number; parent?: string; at?: number };
  offset?: bigint;
  context?: IngestContext;
}

export const withComparisons = async (
  run: (fixture: {
    store: TraceStore["Service"];
    ingest: (turn: number, durations: number[], options?: IngestOptions) => Promise<string[]>;
  }) => Promise<void>,
  options: TraceWorkerOptions = {}
) => {
  const root = await mkdtemp("/tmp/p8-compare-");
  const now = BigInt(Date.now()) * 1_000_000n;
  compareContext = contextAt(now);

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* TraceStore;
          let next = 1;

          const ingest = async (turn: number, durations: number[], input: IngestOptions = {}) => {
            const ids: string[] = [];

            for (const ms of durations) {
              const traceId = (next++).toString(16).padStart(32, "0");
              ids.push(traceId);

              const start =
                now + BigInt(turn - 3) * 10_000_000_000n + 1_000_000_000n + (input.offset ?? 0n);

              const rootSpan = {
                ...spanFixture({ traceId, start: start.toString() }),
                name: input.route ?? "POST /invoices",
                endTimeUnixNano: (start + BigInt(ms) * 1_000_000n).toString(),
                events: [],
              };

              const spans = [rootSpan];

              if (input.child !== undefined) {
                const parent = {
                  ...spanFixture({
                    traceId,
                    id: "2222222222222222",
                    parentId: rootSpan.spanId,
                    start: start.toString(),
                  }),
                  name: input.child.parent ?? "handler",
                  endTimeUnixNano: (start + BigInt(ms) * 1_000_000n).toString(),
                  events: [],
                };

                spans.push(parent, {
                  ...parent,
                  spanId: "3333333333333333",
                  parentSpanId: parent.spanId,
                  name: input.child.name,
                  startTimeUnixNano: (start + BigInt(input.child.at ?? 0) * 1_000_000n).toString(),
                  endTimeUnixNano: (
                    start +
                    BigInt((input.child.at ?? 0) + input.child.ms) * 1_000_000n
                  ).toString(),
                });
              }

              const batch = traceFixture(spans);
              batch.resourceSpans[0]!.resource.attributes[0]!.value.stringValue =
                input.service ?? "ledger-api";
              await Effect.runPromise(
                store.ingest({
                  signal: "traces",
                  contentType: "application/json",
                  bytes: new TextEncoder().encode(JSON.stringify(batch)),
                  context: {
                    ...(input.context ?? compareContext),
                    checkout: input.checkout ?? compareContext.checkout,
                  },
                })
              );
            }

            return ids;
          };

          yield* Effect.promise(() => run({ store, ingest }));
        }).pipe(Effect.provide(TraceStore.layerAt(join(root, "traces.sqlite"), options)))
      )
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
