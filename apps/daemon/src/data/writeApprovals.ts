/** Write cards use the existing Session machine and RespondToApproval decision channel. */
import {
  ApprovalRequest,
  DataError,
  RequestId,
  type SessionId,
  type TurnId,
  type DataWriteResult,
} from "@polaris/protocol";
import { Effect, Predicate } from "effect";
import type { EventStore } from "../store/EventStore.ts";
import { workingTurn } from "../store/model.ts";
import { decideSession } from "../engine/session.ts";
import { storageError } from "./database.ts";
import type { WriteApprovalStore } from "./writeApprovalStore.ts";

export const writeApprovalMethods = (
  events: EventStore["Service"],
  repository: WriteApprovalStore,
  sync: Effect.Effect<void, DataError>
) => {
  const lookup = Effect.fnUntraced(function* (fingerprint: string) {
    yield* sync;

    return yield* Effect.try({ try: () => repository.find(fingerprint), catch: storageError });
  });

  return {
    lookup,
    open: Effect.fnUntraced(function* (
      sessionId: SessionId,
      turnId: TurnId,
      dataWrite: NonNullable<ApprovalRequest["dataWrite"]>
    ) {
      const existing = yield* lookup(dataWrite.fingerprint);

      if (existing) return existing.request.id;
      let id: RequestId | undefined;
      yield* events
        .commit({
          commandId: null,
          decide: (model) => {
            const record = model.sessions.get(sessionId);

            if (!record || workingTurn(record)?.id !== turnId) return Effect.succeed([]);

            const pending = [...record.pending.values()].find(
              (request) => request.dataWrite?.fingerprint === dataWrite.fingerprint
            );

            if (pending) {
              id = pending.id;

              return Effect.succeed([]);
            }

            const request = new ApprovalRequest({
              id: RequestId.make(`data-write-${crypto.randomUUID()}`),
              sessionId,
              turnId,
              kind: "tool",
              dataWrite,
              title:
                dataWrite.previewed === false
                  ? "Run without preview"
                  : `Run ${dataWrite.affected}-row write`,
              detail: `${dataWrite.previewed === false ? dataWrite.note : `Dry run · rolled back · ${dataWrite.affected} rows`}\n${dataWrite.sql}\n${dataWrite.reason}`,
              options: [],
              questions: [],
              openedAt: new Date().toISOString(),
            });

            const decision = decideSession(record, { type: "data.approvalRequested", request });

            if (decision.events.some((event) => Predicate.isTagged(event, "ApprovalRequested")))
              id = request.id;

            return Effect.succeed(decision.events);
          },
        })
        .pipe(Effect.mapError(storageError));

      if (id === undefined)
        return yield* new DataError({
          code: "E-DATA-DENIED",
          message: "The write's turn is no longer active.",
          fix: "Request the write in the current turn.",
        });
      yield* sync;

      return id;
    }),
    claim: Effect.fnUntraced(function* (id: RequestId) {
      yield* sync;

      return yield* Effect.try({ try: () => repository.claim(id), catch: storageError });
    }),
    fail: (id: RequestId, error: DataError) =>
      Effect.try({ try: () => repository.fail(id, error), catch: storageError }),
    finish: (id: RequestId, result: DataWriteResult) =>
      Effect.try({ try: () => repository.finish(id, result), catch: storageError }),
  };
};

export type WriteApprovals = ReturnType<typeof writeApprovalMethods>;
