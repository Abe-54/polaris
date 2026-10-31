/** Agent writes and user grid commits share attribution, source resolution and the Query Log. */
import {
  DataError,
  DataWriteResult,
  QueryLogEntry,
  scrubCredentials,
  type SessionId,
  type ExecuteDataInput,
  type CommitDataEdits,
} from "@polaris/protocol";
import { Effect, Predicate, Schema, Semaphore } from "effect";
import type { EventStore } from "../store/EventStore.ts";
import { duringWriteTurn } from "./writeTurn.ts";
import { writeRequestKey, writeRequestHash } from "./writeIdentity.ts";
import type { DataSources } from "./index.ts";
import type { DataApprovals } from "./approvals.ts";
import type { QueryLog } from "./queryLog.ts";
import type { DataPools } from "./pools.ts";
import { targetKey, targetOf } from "./approvalStore.ts";
import { DataApprovalRequired, type DataAgentContext } from "./approvalRequired.ts";
import { knownCredentials } from "./execution.ts";
import { editStatements } from "./writeEdits.ts";
import { queryError } from "./execution.ts";
import { writeEffect, editsEffect } from "./writeExecution.ts";

type Context = (
  id: SessionId,
  agent?: DataAgentContext
) => Effect.Effect<{ checkout: string; author: QueryLogEntry["author"] }, DataError>;

type ExecuteInput = typeof ExecuteDataInput.Type & DataAgentContext;

type EditsInput = typeof CommitDataEdits.payloadSchema.Type;

const fields = Schema.decodeUnknownSync(Schema.Struct(QueryLogEntry.fields));

const denied = (message: string, fix = "Don't retry; ask the user.") =>
  new DataError({ code: "E-DATA-DENIED", message, fix });

export const writeQueries = Effect.fnUntraced(function* (
  sources: DataSources["Service"],
  approvals: DataApprovals["Service"],
  log: QueryLog["Service"],
  pools: DataPools,
  context: Context,
  store: EventStore["Service"]
) {
  const lock = yield* Semaphore.make(1);

  const resolve = Effect.fnUntraced(function* (input: { sessionId: SessionId; source: string }) {
    const resolved = yield* sources.resolve(input);
    const access = yield* approvals.read(resolved.source);

    if (
      resolved.source.locality === "remote" &&
      (access.writes !== "ask" || access.access !== "approved")
    )
      return yield* denied(
        "Writes aren't allowed on this remote data source.",
        "The user can allow writes for this target in Data."
      );

    return resolved;
  });

  const entry = (
    input: { source: string; sql: string; tool?: string },
    ctx: Effect.Success<ReturnType<Context>>
  ) =>
    new QueryLogEntry({
      id: `q_${crypto.randomUUID()}`,
      checkout: ctx.checkout,
      source: { id: input.source, name: input.source },
      sql: scrubCredentials(input.sql).slice(0, 32000),
      state: "running",
      author: ctx.author,
      tool: input.tool ?? "data.edits.commit",
      at: new Date().toISOString(),
    });

  const logged = <A, E>(
    initial: QueryLogEntry,
    work: (
      update: (change: Partial<QueryLogEntry>) => Effect.Effect<void, DataError>
    ) => Effect.Effect<A, E>
  ) => {
    let current = initial;

    const update = (change: Partial<typeof current>) => {
      current = new QueryLogEntry({ ...fields(current), ...change });

      return log.put(current);
    };

    return work(update).pipe(
      Effect.tapError((error) =>
        Predicate.isTagged(error, "DataApprovalRequired")
          ? Effect.void
          : update({
              state: "failed",
              error: Predicate.hasProperty(error, "message")
                ? scrubCredentials(String(error.message))
                : "The write failed.",
            })
      ),
      Effect.onInterrupt(() => update({ state: "cancelled" }).pipe(Effect.ignore))
    );
  };

  const execute = Effect.fnUntraced(function* (input: ExecuteInput) {
    const ctx = yield* context(input.sessionId, input);

    if (ctx.author.kind !== "agent")
      return yield* denied("An execute call needs an active agent turn.");
    const turn = ctx.author.turn;
    const resolved = yield* resolve(input);
    const known = knownCredentials(resolved.connection);

    const fingerprint =
      writeRequestKey(input) ??
      Bun.CryptoHasher.hash(
        "sha256",
        JSON.stringify([
          input.sessionId,
          turn,
          resolved.source.id,
          targetKey(targetOf(resolved.source)),
          input.sql,
          input.params ?? [],
          input.reason,
        ]),
        "hex"
      );

    const previous = yield* approvals.writes.lookup(fingerprint);

    if (
      previous?.request.dataWrite &&
      targetKey(previous.request.dataWrite.target) !== targetKey(targetOf(resolved.source))
    )
      return yield* denied(
        "The data source target changed after approval.",
        "Preview the new target with a new requestId."
      );

    if (previous && previous.request.turnId !== turn)
      return yield* denied(
        "This write belongs to an earlier turn.",
        "Use a new requestId to preview a new write."
      );

    if (previous?.result) return previous.result;

    if (previous?.status === "denied")
      return yield* denied(previous.reason || "The user denied this write.");

    if (previous?.status === "started")
      return yield* denied(
        "This write already started. Its outcome may be unknown.",
        "Inspect the Query Log and database before requesting another write."
      );

    if (previous?.status === "pending")
      return yield* new DataApprovalRequired({
        approvalId: previous.request.id,
        sourceId: resolved.source.id,
        sourceName: resolved.source.name,
      });
    const created = entry({ ...input, tool: "execute" }, ctx);

    const initial = previous?.request.dataWrite
      ? new QueryLogEntry({ ...fields(created), id: previous.request.dataWrite.queryId })
      : created;

    return yield* logged(initial, (update) =>
      Effect.gen(function* () {
        yield* update({
          source: { id: resolved.source.id, name: resolved.source.name },
          target: targetKey(targetOf(resolved.source)),
          sql: scrubCredentials(input.sql, known).slice(0, 32000),
        });

        if (!previous) {
          const started = performance.now();

          const preview = yield* writeEffect(pools, {
            ...resolved,
            sql: input.sql,
            params: input.params ?? [],
            dryRun: true,
          });

          yield* log.put(
            new QueryLogEntry({
              ...fields(initial),
              id: `${initial.id}:dry-run`,
              source: { id: resolved.source.id, name: resolved.source.name },
              target: targetKey(targetOf(resolved.source)),
              sql: scrubCredentials(input.sql, known).slice(0, 32000),
              state: "dry-run",
              rows: preview.affected,
              elapsedMs: performance.now() - started,
            })
          );

          const approvalId = yield* approvals.writes.open(input.sessionId, turn, {
            target: targetOf(resolved.source),
            fingerprint,
            ...(input.requestId === undefined
              ? undefined
              : { requestHash: writeRequestHash(input) }),
            queryId: initial.id,
            sql: scrubCredentials(input.sql, known).slice(0, 32000),
            reason: scrubCredentials(input.reason, known).slice(0, 4000),
            affected: preview.affected,
            columns: preview.columns,
            before: preview.before,
            after: preview.after,
            note: preview.note,
          });

          yield* update({
            state: "waiting-approval",
            approval: { id: approvalId, status: "pending" },
          });

          return yield* new DataApprovalRequired({
            approvalId,
            sourceId: resolved.source.id,
            sourceName: resolved.source.name,
          });
        }

        const approvalId = previous.request.id;

        if (previous.status === "pending")
          return yield* new DataApprovalRequired({
            approvalId,
            sourceId: resolved.source.id,
            sourceName: resolved.source.name,
          });
        yield* context(input.sessionId, input);
        const fresh = yield* resolve(input);

        if (targetKey(targetOf(fresh.source)) !== targetKey(targetOf(resolved.source)))
          return yield* denied(
            "The data source target changed after approval.",
            "Preview the write on the new target."
          );

        yield* log.beforeWrite(
          new QueryLogEntry({
            ...fields(initial),
            source: { id: fresh.source.id, name: fresh.source.name },
            target: targetKey(targetOf(fresh.source)),
          })
        );

        if (!(yield* approvals.writes.claim(approvalId)))
          return yield* denied(
            "This write approval has already been consumed.",
            "Inspect the Query Log before requesting another write."
          );
        const started = performance.now();

        const result = yield* writeEffect(pools, {
          ...fresh,
          sql: input.sql,
          params: input.params ?? [],
          dryRun: false,
          expected: previous.request.dataWrite!.affected,
        });

        const answer = new DataWriteResult({
          queryId: previous.request.dataWrite!.queryId,
          affected: result.affected,
          elapsedMs: performance.now() - started,
        });

        yield* approvals.writes.finish(approvalId, answer);
        yield* update({
          id: answer.queryId,
          state: "completed",
          approval: { id: approvalId, status: "approved" },
          rows: answer.affected,
          elapsedMs: answer.elapsedMs,
          ...(result.target
            ? { affected: [{ ...result.target, rows: answer.affected }] }
            : undefined),
        });

        return answer;
      })
    );
  });

  const commitEdits = Effect.fnUntraced(function* (input: EditsInput) {
    const ctx = yield* context(input.sessionId);
    const resolved = yield* resolve(input);

    const statements = yield* Effect.try({
      try: () => editStatements(input, resolved.source.engine),
      catch: (error) => queryError(error, knownCredentials(resolved.connection)),
    });

    const initial = entry(
      { source: input.source, sql: statements.map((statement) => statement.sql).join(";\n") },
      ctx
    );

    return yield* logged(initial, (update) =>
      Effect.gen(function* () {
        yield* update({
          source: { id: resolved.source.id, name: resolved.source.name },
          target: targetKey(targetOf(resolved.source)),
        });
        const started = performance.now();
        yield* log.beforeWrite(
          new QueryLogEntry({
            ...fields(initial),
            source: { id: resolved.source.id, name: resolved.source.name },
            target: targetKey(targetOf(resolved.source)),
          })
        );
        const result = yield* editsEffect(pools, { ...resolved, edits: input });

        const answer = new DataWriteResult({
          queryId: initial.id,
          affected: result.affected,
          elapsedMs: performance.now() - started,
        });

        yield* update({
          state: "completed",
          rows: answer.affected,
          elapsedMs: answer.elapsedMs,
          affected: [{ ...result.target, rows: answer.affected }],
        });

        return answer;
      })
    );
  });

  return {
    execute: (input: ExecuteInput) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          yield* context(input.sessionId);
          const key = writeRequestKey(input);
          const prior = key === undefined ? undefined : yield* approvals.writes.lookup(key);

          if (prior && prior.request.dataWrite?.requestHash !== writeRequestHash(input))
            return yield* denied(
              "This requestId was already used with different write arguments.",
              "Retry the original arguments, or use a new requestId for a new write."
            );

          if (prior?.result) return prior.result;
          const ctx = yield* context(input.sessionId, input);

          if (ctx.author.kind !== "agent")
            return yield* denied("An execute call needs an active agent turn.");

          return yield* duringWriteTurn(store, input.sessionId, ctx.author.turn, execute(input));
        })
      ),
    commitEdits,
  };
});
