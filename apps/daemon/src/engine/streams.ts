/**
 * Host and session streams. Each subscribes to the live hub first, then takes
 * the model's sequence as the cut: a snapshot (or a replay of the events after
 * the Client's sequence) up to the cut, `Synchronized`, then live items after it.
 */
import { approvalCapability } from "../store/eventCapability.ts";
import {
  type Capability,
  HostStreamItem,
  NotFound,
  Sequence,
  type SessionId,
  SessionStreamItem,
  SessionSummary,
  constellationSummaryOf,
  type DomainEvent,
  type SubagentDetail,
  TurnDetail,
  type TurnId,
  TurnPage,
  type Turn,
} from "@polaris/protocol";
import { Context, Effect, Layer, Predicate, Result, Stream } from "effect";
import { WORKERS_RESOURCE } from "../resources/model.ts";
import type { LiveItem } from "../store/EventStore.ts";
import {
  eventCapability,
  gatingCapabilities,
  isHostStreamEvent,
  isSubagentEvent,
  lastTurn,
  type SessionRecord,
} from "../store/model.ts";
import { EngineRuntime } from "./runtime.ts";
import { newestWithin } from "./turnBudget.ts";
import { markedWorker, workerSessions } from "./workers.ts";

export interface SessionSubscription {
  readonly sessionId: SessionId;
  readonly afterSequence: Sequence | null;
  readonly turnLimit: number | null;
  /** Send `ItemProgress` (the Client announced `session.live-items`). Default false. */
  readonly liveItems?: boolean;
  /** Send Subagents and their items (the Client announced `session.subagents`). Default false. */
  readonly subagents?: boolean;
  /** What the Client announced: events that need another capability are left out. Default none. */
  readonly capabilities?: ReadonlyArray<Capability>;
}

export interface TurnPageRequest {
  readonly sessionId: SessionId;
  readonly beforeIndex: number;
  readonly limit: number;
  /** Include Subagents and their items (the Client announced `session.subagents`). */
  readonly subagents?: boolean;
}

/** The most Turns one `session.turns` call returns. */
export const MAX_TURN_PAGE = 50;

export interface HostSubscription {
  /** Send Subagents (the Client announced `session.subagents`). Default false. */
  readonly subagents?: boolean;
  /** What the Client announced (see `eventCapability`). Default none. */
  readonly capabilities?: ReadonlyArray<Capability>;
}

/** Whether a Client with `capabilities` can decode `event` (`eventCapability`). */
const decodes =
  (capabilities: ReadonlyArray<Capability>) =>
  (event: DomainEvent): boolean => {
    const needed = eventCapability(event);

    return needed === null || capabilities.includes(needed);
  };

/** Pending requests a Client can decode: a gated kind only with its capability. */
const pendingFor = (record: SessionRecord, capabilities: ReadonlyArray<Capability>) =>
  [...record.pending.values()].filter((request) => {
    const needed = approvalCapability(request.kind);

    return needed === null || capabilities.includes(needed);
  });

const summaryOf = (
  record: SessionRecord,
  subagents: boolean,
  workers: ReturnType<typeof workerSessions>,
  capabilities: ReadonlyArray<Capability>
) =>
  new SessionSummary({
    session: markedWorker(record.session, workers),
    pendingApprovals: pendingFor(record, capabilities),
    lastTurnPreview: lastTurn(record)?.prompt.slice(0, 140) ?? null,
    subagents: subagents ? [...record.subagents.values()] : [],
  });

/** Whether a Client that didn't announce `session.subagents` may see this item. */
const withoutSubagents = (item: LiveItem): boolean =>
  Predicate.isTagged(item, "Event")
    ? !isSubagentEvent(item.envelope.event)
    : item.subagentId === null;

const hostItem =
  (subagents: boolean, capabilities: ReadonlyArray<Capability>) =>
  (item: LiveItem): boolean =>
    Predicate.isTagged(item, "Event") &&
    isHostStreamEvent(item.envelope.event) &&
    (subagents || !isSubagentEvent(item.envelope.event)) &&
    decodes(capabilities)(item.envelope.event);

/** What a session stream sends live, by what the Client announced. */
const sessionFilter = (
  liveItems: boolean,
  subagents: boolean,
  capabilities: ReadonlyArray<Capability>
) => {
  const known = decodes(capabilities);
  const decodesAll = gatingCapabilities.every((c) => capabilities.includes(c));

  // No filter at all is cheaper: this would run for every Delta.
  if (liveItems && subagents && decodesAll) return undefined;

  return (item: LiveItem): boolean =>
    (liveItems || !Predicate.isTagged(item, "ItemProgress")) &&
    (subagents || withoutSubagents(item)) &&
    (!Predicate.isTagged(item, "Event") || known(item.envelope.event));
};

const allowedEvent =
  (subagents: boolean, capabilities: ReadonlyArray<Capability>) =>
  (envelope: { readonly event: DomainEvent }) =>
    (subagents || !isSubagentEvent(envelope.event)) && decodes(capabilities)(envelope.event);

const make = (rt: EngineRuntime["Service"]): Streams["Service"] => {
  const { store } = rt;

  const subscribeHost = (
    afterSequence: Sequence | null,
    options: HostSubscription = {}
  ): Stream.Stream<HostStreamItem> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const withSubagents = options.subagents === true;
        const capabilities = options.capabilities ?? [];

        const subscription = yield* store.subscribe({
          filter: hostItem(withSubagents, capabilities),
        });

        const model = yield* store.model;
        const cut = Sequence.make(model.sequence);
        const head: Array<HostStreamItem> = [];

        if (afterSequence === null || afterSequence > cut) {
          const workers = workerSessions(model);

          head.push(
            HostStreamItem.cases.Snapshot.make({
              sequence: cut,
              resources: capabilities.includes("host.resources")
                ? [...(model.hostResources?.resources.values() ?? [])].filter(
                    (r) => r.name !== WORKERS_RESOURCE
                  )
                : [],
              resourceLeases: capabilities.includes("host.resources")
                ? [...(model.hostResources?.leases.values() ?? [])]
                : [],
              workspaces: [...model.workspaces.values()],
              worktrees: [...model.worktrees.values()],
              sessions: [...model.sessions.values()].map((r) =>
                summaryOf(r, withSubagents, workers, capabilities)
              ),
              constellations: capabilities.includes("constellation")
                ? [...model.constellations.values()].map((record) =>
                    constellationSummaryOf(record.graph)
                  )
                : [],
              reviewCheckouts: capabilities.includes("review.checkouts")
                ? [...model.reviewCheckouts.values()]
                : [],
            })
          );
        } else {
          const events = yield* store.readEvents({
            after: afterSequence,
            upTo: cut,
            sessionId: null,
          });

          for (const envelope of events.filter(allowedEvent(withSubagents, capabilities)))
            head.push(HostStreamItem.cases.Event.make({ envelope }));
        }

        head.push(HostStreamItem.cases.Synchronized.make({ sequence: cut }));

        const liveItems = subscription.pipe(
          Stream.filterMap((item) =>
            Predicate.isTagged(item, "Event") && item.envelope.sequence > cut
              ? Result.succeed(HostStreamItem.cases.Event.make({ envelope: item.envelope }))
              : Result.failVoid
          )
        );

        return Stream.concat(Stream.fromIterable(head), liveItems);
      }).pipe(Effect.orDie)
    );

  /** Recent Turns come from the model (consistent with the cut); older, finished ones from SQL. */
  const sessionSnapshot = (
    record: SessionRecord,
    cut: Sequence,
    turnLimit: number | null,
    withSubagents: boolean,
    capabilities: ReadonlyArray<Capability>
  ) =>
    Effect.gen(function* () {
      const total = record.session.turnCount;
      const wanted = turnLimit === null ? total : Math.min(turnLimit, total);
      const recent = record.turns.slice(Math.max(0, record.turns.length - wanted));

      const older =
        wanted > recent.length
          ? yield* store.readTurns({
              sessionId: record.session.id,
              beforeIndex: recent[0]?.index ?? total,
              limit: wanted - recent.length,
            })
          : [];

      return SessionStreamItem.cases.Snapshot.make({
        sequence: cut,
        session: record.session,
        turns: newestWithin(yield* turnDetails([...older, ...recent], cut, withSubagents)),
        pendingApprovals: pendingFor(record, capabilities),
      });
    }).pipe(Effect.orDie);

  /** Turns with their items (and Subagents, when asked) as of `cut`. */
  const turnDetails = (turns: ReadonlyArray<Turn>, cut: Sequence, withSubagents: boolean) =>
    Effect.gen(function* () {
      const turnIds = turns.map((t) => t.id);
      const items = yield* store.readTurnItems({ turnIds, upTo: cut });

      const subagents = withSubagents
        ? yield* store.readSubagents({ turnIds, upTo: cut })
        : new Map<TurnId, ReadonlyArray<SubagentDetail>>();

      return turns.map(
        (turn) =>
          new TurnDetail({
            turn,
            items: [...(items.get(turn.id) ?? [])],
            subagents: [...(subagents.get(turn.id) ?? [])],
          })
      );
    });

  /** `session.turns`: up to `limit` Turns before `beforeIndex`, oldest first. */
  const readTurnPage = (options: TurnPageRequest): Effect.Effect<TurnPage, NotFound> =>
    Effect.gen(function* () {
      const model = yield* store.model;

      if (!model.sessions.has(options.sessionId))
        return yield* new NotFound({ what: "session", id: options.sessionId });
      const cut = Sequence.make(model.sequence);
      const limit = Math.min(Math.max(options.limit, 1), MAX_TURN_PAGE);

      const turns = yield* store
        .readTurns({
          sessionId: options.sessionId,
          beforeIndex: options.beforeIndex,
          limit: limit + 1,
        })
        .pipe(Effect.orDie);

      const page = turns.slice(Math.max(0, turns.length - limit));
      const details = yield* turnDetails(page, cut, options.subagents === true).pipe(Effect.orDie);
      const fit = newestWithin(details);

      return new TurnPage({
        turns: fit,
        sequence: cut,
        hasMore: turns.length > limit || fit.length < details.length,
      });
    });

  // One stage rather than a filter and a map: this runs for every Delta.
  const liveSessionItem =
    (cut: Sequence) =>
    (item: LiveItem): Result.Result<SessionStreamItem, void> => {
      if (Predicate.isTagged(item, "Event")) {
        return item.envelope.sequence > cut
          ? Result.succeed(SessionStreamItem.cases.Event.make({ envelope: item.envelope }))
          : Result.failVoid;
      }

      const { sessionId: _, ...ephemeral } = item;

      return Result.succeed(ephemeral);
    };

  const subscribeSession = (
    options: SessionSubscription
  ): Stream.Stream<SessionStreamItem, NotFound> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const { sessionId, afterSequence } = options;
        const withProgress = options.liveItems === true;
        const withSubagents = options.subagents === true;
        const capabilities = options.capabilities ?? [];
        const filter = sessionFilter(withProgress, withSubagents, capabilities);

        const subscription = yield* store.subscribe(
          filter === undefined ? { sessionId } : { sessionId, filter }
        );

        const model = yield* store.model;
        const record = model.sessions.get(sessionId);

        if (record === undefined) {
          return yield* new NotFound({ what: "session", id: sessionId });
        }

        const cut = Sequence.make(model.sequence);
        const head: Array<SessionStreamItem> = [];

        if (afterSequence === null || afterSequence > cut) {
          head.push(
            yield* sessionSnapshot(record, cut, options.turnLimit, withSubagents, capabilities)
          );
        } else {
          const events = yield* store
            .readEvents({ after: afterSequence, upTo: cut, sessionId })
            .pipe(Effect.orDie);

          for (const envelope of events.filter(allowedEvent(withSubagents, capabilities)))
            head.push(SessionStreamItem.cases.Event.make({ envelope }));
        }

        head.push(SessionStreamItem.cases.Synchronized.make({ sequence: cut }));

        // Items still running, so a Client that subscribes mid-Turn sees them at once.
        if (withProgress) {
          for (const { turnId, item, subagentId } of rt.progress.get(sessionId)?.values() ?? []) {
            if (subagentId === null || withSubagents) {
              head.push(SessionStreamItem.cases.ItemProgress.make({ turnId, item, subagentId }));
            }
          }
        }

        const liveItems = subscription.pipe(Stream.filterMap(liveSessionItem(cut)));

        return Stream.concat(Stream.fromIterable(head), liveItems);
      })
    );

  return { subscribeHost, subscribeSession, readTurnPage };
};

export class Streams extends Context.Service<
  Streams,
  {
    readonly subscribeHost: (
      afterSequence: Sequence | null,
      options?: HostSubscription
    ) => Stream.Stream<HostStreamItem>;
    readonly subscribeSession: (
      options: SessionSubscription
    ) => Stream.Stream<SessionStreamItem, NotFound>;
    readonly readTurnPage: (options: TurnPageRequest) => Effect.Effect<TurnPage, NotFound>;
  }
>()("polaris/daemon/engine/Streams") {
  static readonly layer = Layer.effect(
    Streams,
    Effect.gen(function* () {
      return make(yield* EngineRuntime);
    })
  );
}
