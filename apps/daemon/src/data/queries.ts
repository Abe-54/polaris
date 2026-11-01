import { sourceKey } from "./approvalStore.ts";
/** Shared agent and Client reads, attribution and bounded result streams. */
import {
  DataError,
  QueryLogEntry,
  QueryResult,
  SchemaTree,
  TableDetail,
  scrubCredentials,
  scrubDataValue,
  dataJsonBytes,
  type SessionId,
} from "@polaris/protocol";
import { Effect, Predicate, Schema, Stream } from "effect";
import { EventStore } from "../store/EventStore.ts";
import { workingTurn } from "../store/model.ts";
import { DataSources, type DataQueries } from "./index.ts";
import { DataApprovals } from "./approvals.ts";
import { QueryLog } from "./queryLog.ts";
import { DataPools } from "./pools.ts";
import { readEffect, knownCredentials } from "./execution.ts";
import { readCatalog } from "./catalog.ts";
import { resultChunks } from "./chunks.ts";
import { resolveReadSource } from "./readSource.ts";
import { writeQueries } from "./writeQueries.ts";
import { type DataAgentContext } from "./approvalRequired.ts";

const noSession = () =>
  new DataError({
    code: "E-DATA-UNKNOWN-SOURCE",
    message: "This agent session no longer exists.",
    fix: "Select an agent session and list its data sources again.",
  });

export const queries = Effect.gen(function* () {
  const sources = yield* DataSources;
  const approvals = yield* DataApprovals;
  const log = yield* QueryLog;
  const store = yield* EventStore;
  const pools = new DataPools();
  yield* Effect.addFinalizer(() => Effect.promise(() => pools.close()));

  const context = Effect.fnUntraced(function* (sessionId: SessionId, agent: DataAgentContext = {}) {
    const record = (yield* store.model).sessions.get(sessionId);

    if (!record) return yield* noSession();
    const current = workingTurn(record);
    const turn = agent.turn ?? current?.id;

    if (agent.tool !== undefined && (turn === undefined || turn !== current?.id))
      return yield* new DataError({
        code: "E-DATA-DENIED",
        message: "The query's turn is no longer active.",
        fix: "Run the query in the current turn.",
      });

    const author: QueryLogEntry["author"] =
      agent.tool !== undefined && turn !== undefined
        ? { kind: "agent", sessionId, turn }
        : { kind: "user", sessionId, ...(turn === undefined ? undefined : { turn }) };

    return { checkout: record.session.cwd, author };
  });

  const writes = yield* writeQueries(sources, approvals, log, pools, context, store);

  const query = Effect.fnUntraced(function* (
    input: Parameters<DataQueries["Service"]["query"]>[0],
    limit: number = input.limit ?? 200,
    agentCap = true,
    authorized = false
  ) {
    const ctx = yield* context(input.sessionId, input);
    const started = performance.now();

    let entry = new QueryLogEntry({
      id: `q_${crypto.randomUUID()}`,
      checkout: ctx.checkout,
      source: { id: input.source, name: input.source },
      sql: scrubCredentials(input.sql).slice(0, 32000),
      state: "running",
      author: ctx.author,
      at: new Date().toISOString(),
      tool: input.tool ?? "query",
    });

    const work = Effect.gen(function* () {
      const resolved = yield* resolveReadSource(sources, input);
      const known = knownCredentials(resolved.connection);
      entry = new QueryLogEntry({
        ...Schema.decodeUnknownSync(Schema.Struct(QueryLogEntry.fields))(entry),
        source: { id: resolved.source.id, name: resolved.source.name },
        target: sourceKey(resolved.source),
        sql: scrubCredentials(input.sql, known).slice(0, 32000),
      });

      if (resolved.source.locality === "local" && dataJsonBytes([...(input.params ?? [])]) < 16000)
        entry = new QueryLogEntry({
          ...Schema.decodeUnknownSync(Schema.Struct(QueryLogEntry.fields))(entry),
          params: (input.params ?? []).map((value) => scrubDataValue(value, known)),
        });
      yield* log.put(entry);

      if (input.tool !== undefined && !authorized)
        yield* approvals.require(input.sessionId, resolved.source, input.turn, input.approvalId);

      if (sources.inspect) yield* sources.inspect(resolved.source, resolved.connection);

      yield* log.touch(entry);

      const result = yield* readEffect(pools, {
        source: resolved.source,
        connection: resolved.connection,
        sql: input.sql,
        params: input.params ?? [],
        limit,
      });

      let rows = result.rows;

      if (agentCap) {
        let used = JSON.stringify(result.columns).length + 256;
        rows = [];

        for (const row of result.rows) {
          const size = JSON.stringify(row).length + 1;

          if (used + size > 16000) break;
          used += size;
          rows.push(row);
        }
      }

      const elapsedMs = performance.now() - started;
      yield* log.put(
        new QueryLogEntry({
          ...Schema.decodeUnknownSync(Schema.Struct(QueryLogEntry.fields))(entry),
          state: "completed",
          rows: rows.length,
          elapsedMs,
        })
      );

      return {
        queryId: entry.id,
        columns: result.columns,
        rows,
        rowCount: rows.length,
        returned: rows.length,
        truncated: result.truncated || rows.length < result.rows.length,
        elapsedMs,
      };
    });

    return yield* work.pipe(
      Effect.tapError((error) =>
        Predicate.isTagged(error, "DataApprovalRequired")
          ? log.put(
              new QueryLogEntry({
                ...Schema.decodeUnknownSync(Schema.Struct(QueryLogEntry.fields))(entry),
                state: "waiting-approval",
                approval: { id: error.approvalId, status: "pending" },
              })
            )
          : log.put(
              new QueryLogEntry({
                ...Schema.decodeUnknownSync(Schema.Struct(QueryLogEntry.fields))(entry),
                state: "failed",
                error: scrubCredentials(error.message),
                elapsedMs: performance.now() - started,
              })
            )
      ),
      Effect.onInterrupt(() =>
        log
          .put(
            new QueryLogEntry({
              ...Schema.decodeUnknownSync(Schema.Struct(QueryLogEntry.fields))(entry),
              state: "cancelled",
              elapsedMs: performance.now() - started,
            })
          )
          .pipe(Effect.ignore)
      )
    );
  });

  const describe: DataQueries["Service"]["describe"] = Effect.fnUntraced(function* (input) {
    const ctx = yield* context(input.sessionId, input);
    const resolved = yield* resolveReadSource(sources, input);

    if (input.tool !== undefined)
      yield* approvals.require(input.sessionId, resolved.source, input.turn, input.approvalId);

    if (sources.inspect) yield* sources.inspect(resolved.source, resolved.connection);
    yield* log.touch(
      new QueryLogEntry({
        id: `describe:${crypto.randomUUID()}`,
        checkout: ctx.checkout,
        source: { id: resolved.source.id, name: resolved.source.name },
        target: sourceKey(resolved.source),
        sql: "",
        state: "running",
        author: ctx.author,
        tool: "describe",
        at: new Date().toISOString(),
      })
    );
    const result = yield* readCatalog(pools, resolved, input.table);

    if (result instanceof SchemaTree) return result;

    if ((input.sample ?? 0) === 0) return result.detail;

    const sample = yield* query(
      { ...input, sql: result.sampleSql, limit: input.sample ?? 0 },
      input.sample ?? 0,
      true,
      true
    );

    return new TableDetail({
      ...Schema.decodeUnknownSync(Schema.Struct(TableDetail.fields))(result.detail),
      sample: new QueryResult(sample),
    });
  });

  const queryStream: DataQueries["Service"]["queryStream"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const result = yield* query(input, input.limit ?? 10000, false);

        return Stream.fromIterable(resultChunks(result));
      })
    );

  const checkout = Effect.fnUntraced(function* (sessionId: SessionId) {
    return (yield* context(sessionId)).checkout;
  });

  return {
    ...writes,
    query: (input) => Effect.map(query(input), (result) => new QueryResult(result)),
    describe,
    queryStream,
    awaitApproval: (id, timeout) =>
      approvals
        .awaitApproval(id, timeout)
        .pipe(Effect.catch(() => Effect.succeed({ status: "pending" as const }))),
    recordOutside: Effect.fnUntraced(function* (input) {
      const ctx = yield* context(input.sessionId);
      const resolved = yield* sources.resolve(input);

      const command = scrubCredentials(input.command, knownCredentials(resolved.connection)).slice(
        0,
        32000
      );

      yield* log.put(
        new QueryLogEntry({
          id: `outside:${input.sessionId}:${input.itemId}`,
          checkout: ctx.checkout,
          source: { id: resolved.source.id, name: resolved.source.name },
          target: sourceKey(resolved.source),
          sql: command,
          state: "completed",
          author: { kind: "outside", sessionId: input.sessionId, turn: input.turn, command },
          tool: "shell",
          at: new Date().toISOString(),
        }),
        true
      );
    }),
    watchLog: (input) =>
      Stream.unwrap(Effect.map(checkout(input.sessionId), (path) => log.watch(path))),
    pageLog: Effect.fnUntraced(function* (input) {
      return yield* log.page(yield* checkout(input.sessionId), input.before, input.limit);
    }),
  } satisfies DataQueries["Service"];
});
