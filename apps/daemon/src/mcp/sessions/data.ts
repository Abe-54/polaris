/** Resolve checkout and Turn from the authenticated binding, never tool arguments. */
import { NotFound, type RequestId, type SessionId } from "@polaris/protocol";
import { Effect } from "effect";
import type { DataQueries, DataSources } from "../../data/index.ts";
import { knownFromConnection } from "../../data/knownCredentials.ts";
import type { EventStore } from "../../store/EventStore.ts";
import { workingTurn } from "../../store/model.ts";

export type DataSessionTools = ReturnType<typeof sessionDataTools>;

export const sessionDataTools = (
  store: EventStore["Service"],
  sources: DataSources["Service"],
  queries: DataQueries["Service"]
) => {
  const context = Effect.fnUntraced(function* (sessionId: SessionId) {
    const record = (yield* store.model).sessions.get(sessionId);

    if (record === undefined) return yield* new NotFound({ what: "Agent session", id: sessionId });
    const turn = workingTurn(record)?.id;

    return { checkout: record.session.cwd, turn };
  });

  return {
    sources: Effect.fnUntraced(function* (sessionId: SessionId) {
      const { checkout } = yield* context(sessionId);

      return { checkout, sources: yield* sources.list({ sessionId }) };
    }),
    describe: Effect.fnUntraced(function* (
      input: Parameters<DataQueries["Service"]["describe"]>[0] & { approvalId?: RequestId }
    ) {
      const { turn } = yield* context(input.sessionId);
      const call = { ...input, tool: "describe" as const };

      return yield* queries.describe(
        Object.assign(call, turn === undefined ? undefined : { turn })
      );
    }),
    execute: Effect.fnUntraced(function* (input: Parameters<DataQueries["Service"]["execute"]>[0]) {
      const { turn } = yield* context(input.sessionId);
      const call = { ...input, tool: "execute" as const };

      return yield* queries.execute(Object.assign(call, turn === undefined ? undefined : { turn }));
    }),
    query: Effect.fnUntraced(function* (
      input: Parameters<DataQueries["Service"]["query"]>[0] & { approvalId?: RequestId }
    ) {
      const { turn } = yield* context(input.sessionId);
      const call = { ...input, tool: "query" as const };

      return yield* queries.query(Object.assign(call, turn === undefined ? undefined : { turn }));
    }),
    credentials: Effect.fnUntraced(function* (sessionId: SessionId, name?: string) {
      if (name === undefined) return [];
      const resolved = yield* sources.resolve({ sessionId, source: name });

      return knownFromConnection(resolved.connection, resolved.matchUrl);
    }),
    awaitApproval: (
      id: Parameters<typeof queries.awaitApproval>[0],
      timeoutMs: number,
      sessionId: SessionId
    ) => context(sessionId).pipe(Effect.flatMap(() => queries.awaitApproval(id, timeoutMs))),
  };
};
