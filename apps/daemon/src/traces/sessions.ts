import { realpath } from "node:fs/promises";
import { relative } from "node:path";
import { Context, Effect, Layer } from "effect";
import { TraceError, TraceTurn, type SessionId, type WorkspaceId } from "@polaris/protocol";
import { EventStore } from "../store/EventStore.ts";
import type { SessionRecord } from "../store/model.ts";
import type { IngestContext } from "./ingest.ts";

const noSession = () =>
  new TraceError({
    code: "E-TRACE-NOT-FOUND",
    message: "The Agent Session or checkout is unavailable.",
    fix: "Select an existing Agent Session in this checkout.",
  });

const canonical = (path: string) =>
  Effect.tryPromise({ try: () => realpath(path), catch: noSession });

const epochNano = (iso: string) => (BigInt(Date.parse(iso)) * 1000000n).toString();

const within = (parent: string, child: string) => {
  const path = relative(parent, child);

  return path === "" || (!path.startsWith("..") && !path.startsWith("/"));
};

/** Resolves checkout authority and historical Turn intervals from the event store, without writing it. */
export class TraceSessions extends Context.Service<
  TraceSessions,
  {
    readonly session: (id: SessionId) => Effect.Effect<IngestContext, TraceError>;
    readonly workspace: (cwd: string) => Effect.Effect<IngestContext, TraceError>;
    readonly active: (id: SessionId) => Effect.Effect<boolean>;
    readonly workspaceActive: (id: WorkspaceId, checkout: string) => Effect.Effect<boolean>;
  }
>()("polaris/traces/Sessions") {
  static readonly layer = Layer.effect(
    TraceSessions,
    Effect.gen(function* () {
      const store = yield* EventStore;
      const cache = new Map<SessionId, { record: SessionRecord; context: IngestContext }>();

      const active = (id: SessionId) =>
        Effect.map(store.model, (model) => {
          const session = model.sessions.get(id)?.session;

          return (
            session !== undefined && session.state !== "archived" && session.state !== "failed"
          );
        });

      const session = Effect.fnUntraced(function* (id: SessionId) {
        const model = yield* store.model;
        const record = model.sessions.get(id);

        if (record === undefined) return yield* noSession();
        const existing = cache.get(id);

        if (existing?.record === record) return existing.context;
        const checkout = yield* canonical(record.session.cwd);

        const turns = yield* store
          .readTurns({ sessionId: id, beforeIndex: null, limit: null })
          .pipe(Effect.mapError(noSession));

        const context: IngestContext = {
          checkout,
          workspaceId: record.session.workspaceId,
          sessionId: id,
          turns: turns.map((turn) => ({
            turn: TraceTurn.make({
              sessionId: id,
              id: turn.id,
              number: turn.userTurnNumber ?? turn.index + 1,
            }),
            start: epochNano(turn.startedAt),
            end: turn.endedAt === null ? null : epochNano(turn.endedAt),
          })),
        };

        if (cache.size >= 64) cache.delete(cache.keys().next().value!);
        cache.set(id, { record, context });

        return context;
      });

      const workspace = Effect.fnUntraced(function* (cwd: string) {
        const checkout = yield* canonical(cwd);
        const model = yield* store.model;

        const roots = [
          ...[...model.workspaces.values()].map((w) => ({ path: w.path, workspaceId: w.id })),
          ...[...model.worktrees.values()].map((w) => ({
            path: w.path,
            workspaceId: w.workspaceId,
          })),
        ].sort((a, b) => b.path.length - a.path.length);

        for (const root of roots) {
          const path = yield* canonical(root.path).pipe(Effect.orElseSucceed(() => null));

          if (path !== null && within(path, checkout))
            return {
              checkout: path,
              workspaceId: root.workspaceId,
              sessionId: null,
              turns: [],
            } satisfies IngestContext;
        }

        return yield* noSession();
      });

      return TraceSessions.of({
        session,
        workspace,
        active,
        workspaceActive: (id, checkout) =>
          workspace(checkout).pipe(
            Effect.map((w) => w.workspaceId === id),
            Effect.orElseSucceed(() => false)
          ),
      });
    })
  );
}
