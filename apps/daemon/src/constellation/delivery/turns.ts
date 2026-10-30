import {
  type AgentSession,
  CommandId,
  CommandRejected,
  type DomainEvent,
  SessionId,
  Turn,
  TurnId,
} from "@polaris/protocol";
import { Effect, Predicate, Stream } from "effect";
import { withWorkerAdmission } from "../../resources/workerAdmission.ts";
import { decideSession } from "../../engine/session.ts";
import { serialInput, startupReceipted } from "./boundary.ts";
import { EventStore } from "../../store/EventStore.ts";
import type { ReadModel, SessionRecord } from "../../store/model.ts";
import { ConstellationSessionEffects, type DeliveryPacket } from "./inputs.ts";

export const newTurn = (
  session: AgentSession,
  text: string,
  at: string,
  id: string = crypto.randomUUID()
) =>
  new Turn({
    id: TurnId.make(id),
    sessionId: session.id,
    index: session.turnCount,
    prompt: text,
    attachments: [],
    model: session.model,
    effort: session.effort,
    status: "working",
    checkpointBefore: null,
    checkpointAfter: null,
    startedAt: at,
    endedAt: null,
  });

export const startedTurn = (events: ReadonlyArray<DomainEvent>) =>
  events.find((e) => Predicate.isTagged(e, "TurnStarted"))?.turn;

/** Delivery readiness uses the Session machine and excludes infrastructure failures from auto-wake. */
export const takesDelivery = (record: SessionRecord | undefined, turn: Turn) =>
  record !== undefined &&
  (record.session.state === "idle" || record.session.state === "dormant") &&
  decideSession(record, { type: "turn.send", turn }).rejection === null;

export const waitForBoundary = Effect.fn("Constellation.waitForBoundary")(function* (
  sessionId: SessionId
) {
  const store = yield* EventStore;

  while (true) {
    const finished = yield* Effect.scoped(
      Effect.gen(function* () {
        const feed = yield* store.subscribe({ sessionId });

        const idle = (record: SessionRecord | undefined) =>
          record === undefined || !record.turns.some((t) => t.status === "working");

        if (idle((yield* store.model).sessions.get(sessionId))) return true;
        yield* feed.pipe(
          Stream.takeUntilEffect(() =>
            Effect.map(store.model, (m) => idle(m.sessions.get(sessionId)))
          ),
          Stream.runDrain
        );

        return idle((yield* store.model).sessions.get(sessionId));
      })
    );

    if (finished) return;
  }
});

/** Existing Sessions retain approvals and terminal ownership until their machine accepts a Turn. */
export const waitForDeliveryReady = Effect.fn("Constellation.waitForDeliveryReady")(function* (
  sessionId: SessionId,
  pendingStartup: boolean = false
) {
  const store = yield* EventStore;

  while (true) {
    const ready = yield* Effect.scoped(
      Effect.gen(function* () {
        const feed = yield* store.subscribe({ sessionId });

        const inspect = Effect.map(store.model, (model) => {
          const record = model.sessions.get(sessionId);

          if (
            record === undefined ||
            record.session.state === "archived" ||
            (pendingStartup && record.session.state === "failed")
          )
            return "gone";

          const turn = newTurn(record.session, "", new Date().toISOString());

          const interruptedStartup =
            pendingStartup &&
            record.session.state === "needs-you" &&
            record.turns.at(-1)?.status === "interrupted" &&
            record.pending.size === 0 &&
            decideSession(record, { type: "turn.send", turn }).rejection === null;

          return interruptedStartup || takesDelivery(record, turn) ? "ready" : "wait";
        });

        const state = yield* inspect;

        if (state !== "wait") return state;
        yield* feed.pipe(
          Stream.takeUntilEffect(() => Effect.map(inspect, (state) => state !== "wait")),
          Stream.runDrain
        );

        return yield* inspect;
      })
    );

    if (ready !== "wait") return ready === "ready";
  }
});

type ValidateDelivery = (
  packet: DeliveryPacket,
  model: ReadModel
) => Effect.Effect<void, CommandRejected>;

const rejectDelivery = (packet: DeliveryPacket, reason: string) =>
  new CommandRejected({ commandId: CommandId.make(packet.id), reason });

const deliveryEvents = Effect.fnUntraced(function* (
  store: EventStore["Service"],
  packet: DeliveryPacket,
  model: ReadModel,
  validate: ValidateDelivery,
  canSteer: boolean,
  steerOnly: boolean
) {
  yield* validate(packet, model);
  const record = model.sessions.get(packet.sessionId);

  if (record === undefined || record.session.state === "archived")
    return yield* new CommandRejected({
      commandId: CommandId.make(packet.id),
      reason: "Unavailable worker Session",
    });

  if (Predicate.isTagged(packet.input, "Turn") && packet.input.cause === "recover")
    return yield* new CommandRejected({
      commandId: CommandId.make(packet.id),
      reason: "Remote recovery requires verified interrupted Turn facts",
    });

  const working = record.turns.some((t) => t.status === "working");

  const unblock = Predicate.isTagged(packet.input, "Turn") && packet.input.cause === "unblock";

  if (
    (working && unblock) ||
    (steerOnly && (!working || !canSteer || !(yield* startupReceipted(store, packet.attemptId))))
  )
    return yield* new CommandRejected({
      commandId: CommandId.make(packet.id),
      reason: "Worker input is queued",
    });

  const turn = newTurn(record.session, packet.input.text, new Date().toISOString(), packet.id);

  const decision = decideSession(
    record,
    working ? { type: "turn.steer", canSteer, takesAttachments: true } : { type: "turn.send", turn }
  );

  if (decision.rejection !== null || (!working && !takesDelivery(record, turn)))
    return yield* new CommandRejected({
      commandId: CommandId.make(packet.id),
      reason: "Worker input is queued",
    });

  return decision.events;
});

/** Decide against committed Turn facts; a failed fast path cannot start a new Turn. */
const commitDelivery = Effect.fnUntraced(function* (
  packet: DeliveryPacket,
  validate: ValidateDelivery,
  steerOnly: boolean = false
) {
  const store = yield* EventStore;
  const effects = yield* ConstellationSessionEffects;
  const canSteer = yield* effects.canSteer(packet.sessionId);

  const result = yield* store
    .commit({
      recordRejection: false,
      commandId: CommandId.make(packet.id),
      decide: (model) => deliveryEvents(store, packet, model, validate, canSteer, steerOnly),
    })
    .pipe(
      Effect.catchTag("CommandRejected", (error) =>
        error.reason === "Worker input is queued" ? Effect.succeed(null) : Effect.fail(error)
      )
    );

  if (result === null) return false;

  if (!Predicate.isTagged(result, "Committed")) return true;
  const turn = startedTurn(result.envelopes.map((e) => e.event));

  if (turn !== undefined) yield* effects.runTurn(turn, packet.input.text);
  else yield* effects.steer(packet.sessionId, packet.input.text);

  return true;
});

/** Receipt lookup precedes validation, including retries after an Attempt ends. */
const applyDelivery = Effect.fn("Constellation.applyWorkerDelivery")(function* (
  packet: DeliveryPacket,
  validate: ValidateDelivery
) {
  const store = yield* EventStore;

  while (true) {
    const done = yield* Effect.scoped(
      Effect.gen(function* () {
        const feed = yield* store.subscribe({ sessionId: packet.sessionId });

        if (yield* store.hasCommandReceipt(CommandId.make(packet.id)).pipe(Effect.orDie))
          return true;
        yield* validate(packet, yield* store.model);

        if (yield* Effect.uninterruptible(commitDelivery(packet, validate, true))) return true;

        const result = yield* withWorkerAdmission(
          store,
          packet.sessionId,
          serialInput(packet.sessionId, Effect.uninterruptible(commitDelivery(packet, validate))),
          Predicate.isTagged(packet.input, "Turn") && packet.input.cause === "unblock"
        );

        if (result === undefined)
          return yield* rejectDelivery(packet, "Worker admission closed while input was queued");

        if (!result) yield* feed.pipe(Stream.take(1), Stream.runDrain);

        return result;
      })
    );

    if (done) return;
  }
});

export const applyWorkerDelivery = applyDelivery;
