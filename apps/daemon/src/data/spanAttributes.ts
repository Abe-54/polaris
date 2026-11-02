/**
 * Self-Trace attributes for Data requests (ENG-745): names, counts and timings only. Never SQL,
 * params, row values, hosts, users, passwords or connection strings.
 */
import type { DataSource } from "@polaris/protocol";
import { Effect } from "effect";

/** The Data Source a request resolved to, and the table a describe asked for. */
export const annotateSource = (source: DataSource, table?: string) =>
  Effect.annotateCurrentSpan({
    "polaris.data.source": source.name,
    "polaris.data.engine": source.engine,
    "polaris.data.locality": source.locality,
    ...(table === undefined ? undefined : { "polaris.data.table": table }),
  });

/** Which shape a describe answered: the Desktop App branches on it (ENG-744). */
export const annotateDescribed = (answer: "tree" | "table") =>
  Effect.annotateCurrentSpan("polaris.data.described", answer);

/** A read's size and time, as returned to the Client. */
export const annotateRead = (result: {
  readonly returned: number;
  readonly truncated: boolean;
  readonly elapsedMs: number;
}) =>
  Effect.annotateCurrentSpan({
    "polaris.data.rows": result.returned,
    "polaris.data.truncated": result.truncated,
    "polaris.data.elapsed_ms": Math.round(result.elapsedMs),
  });

/** The access change a `data.source.access` request asked for. */
export const annotateAccessChange = (input: {
  readonly writes?: DataSource["writes"];
  readonly revoke?: boolean;
}) =>
  Effect.annotateCurrentSpan({
    ...(input.writes === undefined ? undefined : { "polaris.data.access.writes": input.writes }),
    "polaris.data.access.revoke": input.revoke === true,
  });
