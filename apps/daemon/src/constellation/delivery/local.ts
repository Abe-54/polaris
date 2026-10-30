import { NotificationItem, type ConstellationId, type TurnId } from "@polaris/protocol";
import { Clock, Effect, Predicate } from "effect";
import { emptyResources } from "../../resources/model.ts";
import { withWorkerAdmission } from "../../resources/workerAdmission.ts";
import { decideSession } from "../../engine/session.ts";
import { serialInput, startupReceipted } from "./boundary.ts";
import { EventStore } from "../../store/EventStore.ts";
import { GraphDecision } from "../decision.ts";
import { decideConstellationJournal, type ConstellationJournalInput } from "../journal.ts";
import { ConstellationOwner } from "../runtime.ts";
import { ConstellationSessionEffects } from "./inputs.ts";
import { journalContext } from "./journal.ts";
import { digestPrompt, steeredDigestPrompt } from "./format.ts";
import { dueAudit } from "../stall.ts";
import type { ConstellationRecord } from "../../store/constellation.ts";
import type { SessionRecord } from "../../store/model.ts";
import { pendingInputs, type PendingInput } from "./messages.ts";
import { newTurn, startedTurn, takesDelivery } from "./turns.ts";
import { unblocksAttempt } from "../blocked.ts";

const deliverInput = Effect.fn("Constellation.deliverLocalInput")(function* (
  id: ConstellationId,
  input: PendingInput,
  steerOnly = false
) {
  const store = yield* EventStore;
  const effects = yield* ConstellationSessionEffects;
  const owner = yield* ConstellationOwner;
  const canSteer = yield* effects.canSteer(input.sessionId);

  const result = yield* store.commit({
    commandId: null,
    decide: (model) =>
      Effect.gen(function* () {
        const graph = model.constellations.get(id);
        const record = model.sessions.get(input.sessionId);

        if (
          graph === undefined ||
          record === undefined ||
          graph.graph.hostId !== owner ||
          graph.graph.state === "archived" ||
          !pendingInputs(graph).some((i) => i.id === input.id && i.sessionId === input.sessionId) ||
          (graph.graph.leadSessionId === input.sessionId &&
            (graph.graph.state === "paused" || graph.handoverRequest !== null))
        )
          return [];

        const blocked = graph.graph.attempts.findLast(
          (a) => a.sessionId === input.sessionId && a.state === "blocked"
        );

        if (
          blocked !== undefined &&
          (record.turns.some((t) => t.status === "working") ||
            !unblocksAttempt(graph, blocked, input.id))
        )
          return [];
        const turn = newTurn(record.session, input.text, new Date().toISOString());
        const working = record.turns.some((t) => t.status === "working");

        if (steerOnly) {
          const attempt = graph.graph.attempts.findLast((a) => a.sessionId === input.sessionId);

          if (
            !working ||
            !canSteer ||
            (attempt !== undefined && !(yield* startupReceipted(store, attempt.id)))
          )
            return [];
        }

        const proof = blocked === undefined ? undefined : graph.interruptions.get(blocked.id);

        const recoveredBlock =
          blocked !== undefined &&
          proof?.eligible === true &&
          record.pending.size === 0 &&
          record.session.state === "needs-you" &&
          record.turns.at(-1)?.id === proof.turnId &&
          record.turns.at(-1)?.endedAt === proof.at;

        if (!working && !takesDelivery(record, turn) && !recoveredBlock) return [];

        const session = decideSession(
          record,
          working
            ? { type: "turn.steer", canSteer, takesAttachments: true }
            : { type: "turn.send", turn }
        );

        if (session.rejection !== null) return [];

        const decision = decideConstellationJournal(
          graph,
          {
            type: "inputDelivered",
            id: input.id,
            sessionId: input.sessionId,
            turnEvents: session.events,
          },
          journalContext(graph, turn.startedAt)
        );

        return yield* decision.rejection === null
          ? Effect.succeed(decision.events)
          : Effect.fail(decision.rejection);
      }),
  });

  if (!Predicate.isTagged(result, "Committed") || result.envelopes.length === 0) return false;
  const turn = startedTurn(result.envelopes.map((e) => e.event));

  if (turn === undefined) yield* effects.steer(input.sessionId, input.text);
  else yield* effects.runTurn(turn, input.text);

  return true;
});

const digest = Effect.fn("Constellation.deliverDigest")(function* (id: ConstellationId) {
  const store = yield* EventStore;
  const effects = yield* ConstellationSessionEffects;
  const owner = yield* ConstellationOwner;
  const leadSessionId = (yield* store.model).constellations.get(id)?.graph.leadSessionId;
  const canSteer = leadSessionId === undefined ? false : yield* effects.canSteer(leadSessionId);
  // The runner's clock, so a slot stall reads the same here as when its wake was armed.
  const clock = yield* Clock.currentTimeMillis;

  const result = yield* store.commit({
    commandId: null,
    decide: (model) =>
      Effect.gen(function* () {
        const graph = model.constellations.get(id);

        if (
          graph === undefined ||
          graph.graph.hostId !== owner ||
          graph.graph.state !== "running" ||
          graph.handoverRequest !== null
        )
          return [];
        const record = model.sessions.get(graph.graph.leadSessionId);

        const audit = dueAudit(graph, model.sessions, {
          hostId: owner,
          resources: model.hostResources ?? emptyResources(),
          now: clock,
        });

        if (
          record === undefined ||
          (graph.graph.pendingNotifications.length === 0 && audit === null)
        )
          return [];
        const now = new Date().toISOString();
        const working = record.turns.find((t) => t.status === "working");
        const items = graph.graph.pendingNotifications.map((n) => n.id);

        // A working Lead whose Harness can steer hears the digest inside its live Turn.
        if (working !== undefined && canSteer && (yield* leadSteerable(store, graph, record))) {
          const session = decideSession(record, {
            type: "turn.steer",
            canSteer,
            takesAttachments: true,
          });

          if (session.rejection !== null) return [];

          return yield* journal(
            graph,
            {
              type: "notified",
              leadSessionId: record.session.id,
              turnId: working.id,
              items,
              turnEvents: session.events,
              steered: true,
              audit,
            },
            now
          );
        }

        const turn = newTurn(record.session, digestPrompt(graph, audit), now);

        if (!takesDelivery(record, turn)) return [];
        const session = decideSession(record, { type: "turn.send", turn });

        return yield* journal(
          graph,
          {
            type: "notified",
            leadSessionId: turn.sessionId,
            turnId: turn.id,
            items,
            turnEvents: session.events,
            audit,
          },
          now
        );
      }),
  });

  if (!Predicate.isTagged(result, "Committed") || result.envelopes.length === 0) return false;
  const events = result.envelopes.map((e) => e.event);
  const turn = startedTurn(events);

  if (turn !== undefined) {
    yield* effects.runTurn(turn, turn.prompt);

    return true;
  }

  const notified = events.find((e) => Predicate.isTagged(e, "LeadNotified"));
  const record = (yield* store.model).constellations.get(id);

  if (notified !== undefined && record !== undefined)
    yield* effects.steer(notified.leadSessionId, steeredDigestPrompt(record, notified));

  return true;
});

/** A Lead carrying a Gate Attempt hears digests only once that Attempt's brief has a receipt. */
const leadSteerable = Effect.fnUntraced(function* (
  store: EventStore["Service"],
  graph: ConstellationRecord,
  record: SessionRecord
) {
  const attempt = graph.graph.attempts.findLast(
    (a) => a.sessionId === record.session.id && a.state !== "accepted"
  );

  return attempt === undefined || (yield* startupReceipted(store, attempt.id));
});

const journal = (
  graph: ConstellationRecord,
  input: Extract<ConstellationJournalInput, { type: "notified" }>,
  now: string
) => {
  const decision = decideConstellationJournal(graph, input, journalContext(graph, now));

  return decision.rejection === null
    ? Effect.succeed(decision.events)
    : Effect.fail(decision.rejection);
};

const nudge = Effect.fn("Constellation.nudgeSilentWorker")(function* (
  id: ConstellationId,
  sessionId: PendingInput["sessionId"],
  endedTurnId: TurnId
) {
  const store = yield* EventStore;
  const effects = yield* ConstellationSessionEffects;
  const owner = yield* ConstellationOwner;

  const result = yield* store.commit({
    commandId: null,
    decide: (model) => {
      const graph = model.constellations.get(id);
      const record = model.sessions.get(sessionId);

      const attempt = graph?.graph.attempts.findLast(
        (a) => a.sessionId === sessionId && a.state === "working"
      );

      if (
        graph === undefined ||
        graph.graph.hostId !== owner ||
        record === undefined ||
        record.turns.at(-1)?.id !== endedTurnId ||
        attempt === undefined ||
        (record.turns.at(-1)?.startedAt ?? "") < attempt.startedAt ||
        graph.graph.leadSessionId === sessionId ||
        graph.stale.has(attempt.id) ||
        [...graph.questions.values()].some(
          (q) => q.attemptId === attempt.id && q.answer === null && q.question.blocking
        ) ||
        graph.graph.state !== "running"
      )
        return Effect.succeed([]);

      if (attempt.nudgedAt !== null) {
        const stopped = [...graph.notifications.values()].some(
          (n) =>
            Predicate.isTagged(n.item, "Stopped") &&
            n.item.attemptId === attempt.id &&
            n.queuedAt >= (record.turns.at(-1)?.startedAt ?? "")
        );

        if (stopped) return Effect.succeed([]);
        const d = new GraphDecision(graph, journalContext(graph, new Date().toISOString()));
        d.notify(
          NotificationItem.cases.Stopped.make({ taskId: attempt.taskId, attemptId: attempt.id })
        );

        return Effect.succeed(d.events);
      }

      const prompt = `Your Attempt isn't claimed: claim it, ask for a decision or answer, or call block with the Tasks and reason you are waiting on. Continue ${attempt.taskId} if work remains.`;
      const turn = newTurn(record.session, prompt, new Date().toISOString());

      if (!takesDelivery(record, turn)) return Effect.succeed([]);

      const decision = decideConstellationJournal(
        graph,
        {
          type: "nudged",
          attemptId: attempt.id,
          turnId: turn.id,
          turnEvents: decideSession(record, { type: "turn.send", turn }).events,
        },
        journalContext(graph, turn.startedAt)
      );

      return decision.rejection === null
        ? Effect.succeed(decision.events)
        : Effect.fail(decision.rejection);
    },
  });

  if (Predicate.isTagged(result, "Committed")) {
    const turn = startedTurn(result.envelopes.map((e) => e.event));

    if (turn !== undefined) yield* effects.runTurn(turn, turn.prompt);
  }
});

export const deliverLocalInput = (id: ConstellationId, input: PendingInput) =>
  Effect.gen(function* () {
    const store = yield* EventStore;
    const effects = yield* ConstellationSessionEffects;
    const canSteer = yield* effects.canSteer(input.sessionId);
    const model = yield* store.model;
    const graph = model.constellations.get(id)?.graph;
    const attempt = graph?.attempts.findLast((a) => a.sessionId === input.sessionId);
    const record = model.sessions.get(input.sessionId);
    const working = record?.turns.find((t) => t.status === "working");
    // Skip the old Turn's receipt/commit round trip so pre-brief inputs retain FIFO.

    const afterStartup =
      attempt === undefined ||
      record?.turns.some((t) => t.id === `${attempt.id}:start`) === true ||
      (working !== undefined && working.startedAt > attempt.startedAt);

    if (canSteer && working !== undefined && afterStartup && (yield* deliverInput(id, input, true)))
      return;

    const delivered = yield* withWorkerAdmission(
      store,
      input.sessionId,
      serialInput(input.sessionId, deliverInput(id, input))
    );

    if (delivered === undefined)
      yield* Effect.logError("Local Constellation input remains queued: worker admission closed", {
        sessionId: input.sessionId,
        inputId: input.id,
      });
  });

/** True when a digest committed; a busy or paused Lead leaves the window due. */
export const deliverDigest = (id: ConstellationId) =>
  Effect.gen(function* () {
    const store = yield* EventStore;
    const sessionId = (yield* store.model).constellations.get(id)?.graph.leadSessionId;

    return sessionId === undefined ? false : yield* serialInput(sessionId, digest(id));
  });

export const nudgeSilentWorker = (
  id: ConstellationId,
  sessionId: PendingInput["sessionId"],
  endedTurnId: TurnId
) =>
  Effect.gen(function* () {
    const store = yield* EventStore;
    yield* withWorkerAdmission(
      store,
      sessionId,
      serialInput(sessionId, nudge(id, sessionId, endedTurnId))
    );
  });
