/** Remote reads request a decision through the Session machine and consume durable answers. */
import {
  ApprovalRequest,
  DataError,
  RequestId,
  type DataSource,
  type SessionId,
  type TurnId,
} from "@polaris/protocol";
import { Context, Effect, Layer, Option, Predicate, Semaphore, Stream, PubSub } from "effect";
import { EventStore, type LiveItem } from "../store/EventStore.ts";
import { workingTurn } from "../store/model.ts";
import { decideSession } from "../engine/session.ts";
import { DataDatabase, storageError } from "./database.ts";
import { ApprovalStore, targetKey, targetOf } from "./approvalStore.ts";
import { writeApprovalMethods, type WriteApprovals } from "./writeApprovals.ts";
import { DataApprovalRequired, type DataApprovalOutcome } from "./approvalRequired.ts";

const approvalItem = (item: LiveItem, id?: RequestId) => {
  if (!Predicate.isTagged(item, "Event")) return false;
  const event = item.envelope.event;

  if (Predicate.isTagged(event, "ApprovalRequested"))
    return id === undefined || event.request.id === id;

  return (
    (Predicate.isTagged(event, "ApprovalResolved") ||
      Predicate.isTagged(event, "ApprovalWithdrawn")) &&
    (id === undefined || event.requestId === id)
  );
};

export class DataApprovals extends Context.Service<
  DataApprovals,
  {
    readonly changes: Stream.Stream<void>;
    readonly writes: WriteApprovals;
    readonly read: (
      source: DataSource
    ) => Effect.Effect<{ access: DataSource["access"]; writes: DataSource["writes"] }, DataError>;
    readonly require: (
      sessionId: SessionId,
      source: DataSource,
      turn?: TurnId,
      approvalId?: RequestId
    ) => Effect.Effect<void, DataError | DataApprovalRequired>;
    readonly awaitApproval: (
      id: RequestId,
      timeoutMs: number
    ) => Effect.Effect<DataApprovalOutcome, DataError>;
    readonly change: (
      source: DataSource,
      writes?: DataSource["writes"],
      revoke?: boolean
    ) => Effect.Effect<void, DataError>;
  }
>()("polaris/data/Approvals") {
  static readonly layer = Layer.effect(
    DataApprovals,
    Effect.gen(function* () {
      const { db } = yield* DataDatabase;
      const events = yield* EventStore;

      const repository = yield* Effect.try({
        try: () => new ApprovalStore(db),
        catch: storageError,
      });

      const lock = yield* Semaphore.make(1);
      const changes = yield* PubSub.sliding<void>({ capacity: 1, replay: 1 });
      yield* Effect.addFinalizer(() => PubSub.shutdown(changes));

      const sync = lock
        .withPermits(1)(
          Effect.gen(function* () {
            const cut = (yield* events.model).sequence;
            const after = repository.cursor;

            if (cut <= after) return;

            const entries = yield* events.readEvents({
              after,
              upTo: cut,
              sessionId: null,
              eventTypes: ["ApprovalRequested", "ApprovalResolved", "ApprovalWithdrawn"],
            });

            yield* Effect.try({ try: () => repository.apply(entries, cut), catch: storageError });

            if (entries.length) yield* PubSub.publish(changes, undefined);
          })
        )
        .pipe(Effect.mapError(storageError));

      const read = Effect.fnUntraced(function* (source: DataSource) {
        yield* sync;

        return yield* Effect.try({ try: () => repository.read(source), catch: storageError });
      });

      const outcome = Effect.fnUntraced(function* (
        id: RequestId
      ): Effect.fn.Return<DataApprovalOutcome, DataError> {
        yield* sync;
        const row = repository.outcome(id);

        if (!row)
          return { status: "denied", reason: "This data source approval no longer exists." };

        if (row.status === "denied")
          return { status: "denied", reason: row.reason ?? "The user denied this data source." };

        if (row.status === "expired")
          return { status: "expired", reason: row.reason ?? "The write approval expired." };

        return { status: row.status };
      });

      const require = Effect.fnUntraced(function* (
        sessionId: SessionId,
        source: DataSource,
        turn?: TurnId,
        grantedId?: RequestId
      ) {
        const access = yield* read(source);

        if (
          (source.locality === "local" && access.access === "read") ||
          access.access === "approved"
        )
          return;

        if (access.access === "denied")
          return yield* new DataError({
            code: "E-DATA-DENIED",
            message: "The user denied this data source.",
            fix: "Don't retry; ask the user.",
          });
        const record = (yield* events.model).sessions.get(sessionId);
        const activeTurn = record === undefined ? undefined : workingTurn(record);

        if (
          grantedId &&
          activeTurn &&
          (turn === undefined || turn === activeTurn.id) &&
          repository.consume(grantedId, sessionId, activeTurn.id, source)
        )
          return;
        const target = targetOf(source);
        let approvalId: RequestId | undefined;
        yield* events
          .commit({
            commandId: null,
            decide: (model) => {
              const record = model.sessions.get(sessionId);
              const current = record === undefined ? undefined : workingTurn(record);

              if (
                record === undefined ||
                current === undefined ||
                (turn !== undefined && turn !== current.id)
              )
                return Effect.succeed([]);

              const pending = [...model.sessions.values()]
                .flatMap((session) => [...session.pending.values()])
                .find(
                  (request) =>
                    request.dataSource !== undefined &&
                    targetKey(request.dataSource) === targetKey(target)
                );

              if (pending) {
                approvalId = pending.id;

                return Effect.succeed([]);
              }

              const id = RequestId.make(`data-source-${crypto.randomUUID()}`);

              const request = new ApprovalRequest({
                id,
                sessionId,
                turnId: current.id,
                kind: "tool",
                dataSource: target,
                title: `Read ${source.name}`,
                detail: `${source.host}:${source.port}/${source.database} as ${source.user ?? ""}`,
                options: [],
                questions: [],
                openedAt: new Date().toISOString(),
              });

              const decision = decideSession(record, { type: "data.approvalRequested", request });

              if (decision.events.some((event) => Predicate.isTagged(event, "ApprovalRequested")))
                approvalId = id;

              return Effect.succeed(decision.events);
            },
          })
          .pipe(Effect.mapError(storageError));

        if (approvalId === undefined)
          return yield* new DataError({
            code: "E-DATA-DENIED",
            message: "There is no active turn for this data source approval.",
            fix: "Start a turn before asking to read this remote data source.",
          });

        if (activeTurn) repository.join(approvalId, sessionId, activeTurn.id);

        return yield* new DataApprovalRequired({
          approvalId,
          sourceId: source.id,
          sourceName: source.name,
        });
      });

      const awaitApproval = (id: RequestId, timeoutMs: number) =>
        Effect.scoped(
          Effect.gen(function* () {
            const commits = yield* events.subscribe({ filter: (item) => approvalItem(item, id) });
            const current = yield* outcome(id);

            if (current.status !== "pending") return current;

            const answer = yield* commits.pipe(
              Stream.mapEffect(() => outcome(id)),
              Stream.filter((value) => value.status !== "pending"),
              Stream.runHead,
              Effect.timeoutOption(timeoutMs)
            );

            return Option.isSome(answer) && Option.isSome(answer.value)
              ? answer.value.value
              : { status: "pending" as const };
          })
        );

      // The durable log closes the crash window; the subscription just keeps the projection fresh.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const commits = yield* events.subscribe({ filter: approvalItem });
          yield* sync;
          yield* Stream.runForEach(commits, () => sync);
        })
      ).pipe(
        Effect.forever,
        Effect.catchCause((cause) => Effect.logError("data approval projection failed", cause)),
        Effect.forkScoped
      );

      return {
        changes: Stream.fromPubSub(changes),
        writes: writeApprovalMethods(events, repository.writes, sync),
        read,
        require,
        awaitApproval,
        change: Effect.fnUntraced(function* (
          source: DataSource,
          writes?: DataSource["writes"],
          revoke?: boolean
        ) {
          yield* sync;
          yield* Effect.try({
            try: () => repository.change(source, writes, revoke),
            catch: storageError,
          });
          yield* PubSub.publish(changes, undefined);
        }),
      };
    })
  );
}
