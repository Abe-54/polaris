/** Agent Sends to Remote Origins ask through the Session machine, as Data Sources do (ADR 0098). */
import {
  ApprovalRequest,
  OriginApproval,
  RequestId,
  RequestsError,
  isWriteMethod,
  type SessionId,
} from "@polaris/protocol";
import { Effect, Layer, Option, Predicate, PubSub, Semaphore, Stream } from "effect";
import { EventStore } from "../../store/EventStore.ts";
import { workingTurn } from "../../store/model.ts";
import { decideSession } from "../../engine/session.ts";
import { DataDatabase } from "../../data/database.ts";
import { approvalItem } from "../../data/approvals.ts";
import { originLocality, parseOrigin, type OwnerLookup, type ParsedOrigin } from "./locality.ts";
import { OriginApprovalStore, scopeAllows } from "./store.ts";
import {
  OriginApprovalRequired,
  OriginApprovals,
  type AgentSend,
  type AgentSendContext,
} from "./service.ts";

const storageError = () =>
  new RequestsError({
    code: "E-REQUESTS-UNAVAILABLE",
    message: "Polaris couldn't save the origin approval on this host.",
    fix: "Check the host's storage and retry.",
  });

const approvalOf = (send: AgentSend, parsed: ParsedOrigin) =>
  new OriginApproval({
    origin: parsed.origin,
    ...(send.variable === undefined ? undefined : { variable: send.variable }),
    ...(send.environment === undefined ? undefined : { environment: send.environment }),
    method: send.method,
    path: parsed.path,
    write: isWriteMethod(send.method),
    ...(send.tokenSource === undefined ? undefined : { tokenSource: { ...send.tokenSource } }),
  });

const requestOf = (sessionId: SessionId, turnId: ApprovalRequest["turnId"], o: OriginApproval) =>
  new ApprovalRequest({
    id: RequestId.make(`origin-${crypto.randomUUID()}`),
    sessionId,
    turnId,
    kind: "tool",
    origin: o,
    title: `${o.write ? "Write to" : "Read from"} ${o.origin}`,
    detail: [
      `${o.method} ${o.path}`,
      ...(o.tokenSource ? [`Token from ${o.tokenSource.name} in ${o.tokenSource.file}`] : []),
    ].join("\n"),
    options: [],
    questions: [],
    openedAt: new Date().toISOString(),
  });

export const originApprovalsLayer = (owners?: OwnerLookup) =>
  Layer.effect(
    OriginApprovals,
    Effect.gen(function* () {
      const { db } = yield* DataDatabase;
      const events = yield* EventStore;

      const store = yield* Effect.try({
        try: () => new OriginApprovalStore(db),
        catch: storageError,
      });

      const lock = yield* Semaphore.make(1);
      const changes = yield* PubSub.sliding<void>({ capacity: 1, replay: 1 });
      yield* Effect.addFinalizer(() => PubSub.shutdown(changes));

      const sync = lock
        .withPermits(1)(
          Effect.gen(function* () {
            const cut = (yield* events.model).sequence;
            const after = store.cursor;

            if (cut <= after) return;

            const entries = yield* events.readEvents({
              after,
              upTo: cut,
              sessionId: null,
              eventTypes: ["ApprovalRequested", "ApprovalResolved", "ApprovalWithdrawn"],
            });

            yield* Effect.try({ try: () => store.apply(entries, cut), catch: storageError });

            if (entries.length) yield* PubSub.publish(changes, undefined);
          })
        )
        .pipe(Effect.mapError(storageError));

      const storage = <A>(f: () => A) => Effect.try({ try: f, catch: storageError });

      /** Opens one card per origin, or returns the id of the one already pending. */
      const raise = Effect.fnUntraced(function* (
        sessionId: SessionId,
        approval: OriginApproval,
        turn: AgentSendContext["turn"]
      ) {
        let approvalId: RequestId | undefined;
        yield* events
          .commit({
            commandId: null,
            decide: (model) => {
              const record = model.sessions.get(sessionId);
              const current = record === undefined ? undefined : workingTurn(record);

              if (!record || !current || (turn !== undefined && turn !== current.id))
                return Effect.succeed([]);

              const pending = [...model.sessions.values()]
                .flatMap((session) => [...session.pending.values()])
                .find((request) => request.origin?.origin === approval.origin);

              if (pending) {
                approvalId = pending.id;

                return Effect.succeed([]);
              }

              const request = requestOf(sessionId, current.id, approval);
              const decision = decideSession(record, { type: "data.approvalRequested", request });

              if (decision.events.some((event) => Predicate.isTagged(event, "ApprovalRequested")))
                approvalId = request.id;

              return Effect.succeed(decision.events);
            },
          })
          .pipe(Effect.mapError(storageError));

        return approvalId;
      });

      const require = Effect.fnUntraced(function* (
        sessionId: SessionId,
        send: AgentSend,
        context: AgentSendContext = {}
      ) {
        const parsed = parseOrigin(send.url);

        if (!parsed)
          return yield* new RequestsError({
            code: "E-INPUT",
            message: `${send.url} isn't an absolute http or https URL.`,
            fix: "Send to a full URL, such as https://api.example.com/path.",
          });

        if ((yield* Effect.promise(() => originLocality(parsed, owners))) === "local") return;

        const write = isWriteMethod(send.method);
        yield* sync;

        if (scopeAllows(yield* storage(() => store.rule(parsed.origin)), write)) return;

        const record = (yield* events.model).sessions.get(sessionId);
        const active = record === undefined ? undefined : workingTurn(record);
        const turnMatches = context.turn === undefined || context.turn === active?.id;
        const { approvalId: granted } = context;

        if (granted && active && turnMatches) {
          const spent = yield* storage(() =>
            store.consume(granted, sessionId, active.id, parsed.origin, write)
          );

          if (spent) return;
        }

        const approvalId = yield* raise(sessionId, approvalOf(send, parsed), context.turn);

        if (approvalId === undefined)
          return yield* new RequestsError({
            code: "E-INPUT",
            message: "There is no active turn for this origin approval.",
            fix: "Send from the current turn.",
          });

        if (active) yield* storage(() => store.join(approvalId, sessionId, active.id));

        return yield* new OriginApprovalRequired({ approvalId, origin: parsed.origin });
      });

      const outcome = (id: RequestId, write: boolean) =>
        sync.pipe(Effect.andThen(storage(() => store.outcome(id, write))));

      const awaitApproval = (id: RequestId, write: boolean, timeoutMs: number) =>
        Effect.scoped(
          Effect.gen(function* () {
            const commits = yield* events.subscribe({ filter: (item) => approvalItem(item, id) });
            const current = yield* outcome(id, write);

            if (current.status !== "pending") return current;

            const answer = yield* commits.pipe(
              Stream.mapEffect(() => outcome(id, write)),
              Stream.filter((value) => value.status !== "pending"),
              Stream.runHead,
              Effect.timeoutOption(timeoutMs)
            );

            return Option.isSome(answer) && Option.isSome(answer.value)
              ? answer.value.value
              : { status: "pending" as const };
          })
        );

      // Keeps the projection and `changes` fresh between Sends; the event log stays the truth.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const commits = yield* events.subscribe({ filter: approvalItem });
          yield* sync;
          yield* Stream.runForEach(commits, () => sync);
        })
      ).pipe(
        Effect.forever,
        Effect.catchCause((cause) => Effect.logError("origin approval projection failed", cause)),
        Effect.forkScoped
      );

      return {
        changes: Stream.fromPubSub(changes),
        require,
        awaitApproval,
        rules: sync.pipe(Effect.andThen(storage(() => store.rules()))),
        revoke: (origin: string) =>
          sync.pipe(
            Effect.andThen(storage(() => store.revoke(origin))),
            Effect.andThen(PubSub.publish(changes, undefined)),
            Effect.asVoid
          ),
      };
    })
  );

/** The Host's Origin Approvals, with the real listener-owner lookup. */
export const OriginApprovalsLive = originApprovalsLayer();
