/** Derive model transitions from persisted requests, Query Log entries and committed events. */
import { Predicate, Schema } from "effect";
import { ApprovalRequest } from "../../../protocol/src/domain.ts";
import { QueryLogEntry } from "../../../protocol/src/data.ts";
import { EventEnvelope } from "../../../protocol/src/events.ts";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const DataWriteTraceStep = Schema.Struct({
  request: ApprovalRequest,
  status: Schema.Literals([
    "pending",
    "approved",
    "denied",
    "started",
    "completed",
    "failed",
    "unknown",
  ]),
  log: Schema.NullOr(QueryLogEntry),
  events: Schema.Array(EventEnvelope),
  affected: Count,
  value: Schema.Int,
  external: Count,
  identity: Schema.String,
});

export const DataWriteTrace = Schema.Struct({
  version: Schema.Literal(2),
  source: Schema.Literal("data-queries-write"),
  steps: Schema.Array(DataWriteTraceStep).check(Schema.isMaxLength(1000)),
});

export type Observation = typeof DataWriteTraceStep.Type;

const rejected = () =>
  new Error("Data write replay rejected: persisted evidence disagrees with the transition");

function decision(step: Observation, allow: boolean) {
  return step.events.some(
    ({ event }) =>
      Predicate.isTagged(event, "ApprovalResolved") &&
      event.requestId === step.request.id &&
      (allow
        ? Predicate.isTagged(event.decision, "Allow")
        : Predicate.isTagged(event.decision, "Deny"))
  );
}

function execution(step: Observation) {
  if (step.log?.state !== step.status) throw rejected();
  const changed = step.identity !== step.request.dataWrite?.identity;

  if (step.status === "unknown")
    return `.then(claim).then(sendCommit).then(unknown(${step.value}))`;

  return `.then(rows("${changed ? "different" : "same"}")).then(claim).then(execute(${step.affected}))`;
}

function opening(step: Observation) {
  const card = step.request.dataWrite;

  if (!card) throw rejected();

  const opened = step.events.some(
    ({ event }) =>
      Predicate.isTagged(event, "ApprovalRequested") &&
      event.request.id === step.request.id &&
      JSON.stringify(event.request.dataWrite) === JSON.stringify(card)
  );

  if (!opened || step.status !== "pending" || step.log?.state !== "waiting-approval")
    throw rejected();

  if (card.previewed !== false) return `.then(dryRun(${card.affected})).then(request)`;

  const inspect =
    card.note === "Not previewed: this statement changes the schema"
      ? ".then(schemaChange)"
      : ".then(inspect(true,true))";

  return `${inspect}.then(notPreviewed).then(request)`;
}

export function observationActions(step: Observation, previous?: Observation) {
  const card = step.request.dataWrite;

  if (!card) throw rejected();

  if (!previous) return opening(step);

  if (
    previous.request.id !== step.request.id ||
    previous.request.dataWrite?.fingerprint !== card.fingerprint
  )
    throw rejected();

  if (step.status === previous.status) return ".then(retry)";

  if (step.status === "approved" && decision(step, true)) return ".then(allow)";

  if (step.status === "denied") {
    if (decision(step, false)) return ".then(deny)";

    if (
      step.events.some(
        ({ event }) =>
          Predicate.isTagged(event, "ApprovalWithdrawn") && event.requestId === step.request.id
      )
    )
      return ".then(endTurn)";
    throw rejected();
  }

  if (["completed", "failed", "unknown"].includes(step.status)) return execution(step);
  throw rejected();
}
