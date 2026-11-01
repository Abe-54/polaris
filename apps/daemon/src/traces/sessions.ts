import { TraceSessions } from "./sessionsService.ts";

export { TraceSessions } from "./sessionsService.ts";

import { realpath } from "node:fs/promises";
import { relative } from "node:path";
import { Effect, Layer } from "effect";
import {
  TraceError,
  TraceTurn,
  type SessionId,
  type WorkspaceId,
  type Turn,
} from "@polaris/protocol";
import { EventStore } from "../store/EventStore.ts";
import type { ReadModel } from "../store/model.ts";
import type { IngestContext } from "./ingest.ts";

const noSession = () =>
  new TraceError({
    code: "E-TRACE-NOT-FOUND",
    message: "The Agent Session or checkout is unavailable.",
    fix: "Select an existing Agent Session in this checkout.",
  });

const canonical = (path: string) =>
  Effect.tryPromise({ try: () => realpath(path), catch: noSession });

const interval = (id: SessionId, turn: Turn) => ({
  turn: TraceTurn.make({
    sessionId: id,
    id: turn.id,
    number: turn.userTurnNumber ?? turn.index + 1,
  }),
  start: epochNano(turn.startedAt),
  end: turn.endedAt === null ? null : epochNano(turn.endedAt),
});

const epochNano = (iso: string) => (BigInt(Date.parse(iso)) * 1000000n).toString();

const within = (parent: string, child: string) => {
  const path = relative(parent, child);

  return path === "" || (!path.startsWith("..") && !path.startsWith("/"));
};

/** Resolves checkout authority and historical Turn intervals from the event store, without writing it. */
export const traceSessionsLayer = Layer.effect(
  TraceSessions,
  Effect.gen(function* () {
    const store = yield* EventStore;

    const cache = new Map<
      SessionId,
      {
        boundary: string;
        count: number;
        cwd: string;
        workspaces: ReadModel["workspaces"];
        worktrees: ReadModel["worktrees"];
        context: IngestContext;
      }
    >();

    const active = (id: SessionId) =>
      Effect.map(store.model, (model) => {
        const record = model.sessions.get(id);
        const state = record?.session.state;

        return state !== undefined && state !== "archived" && state !== "failed";
      });

    const workspace = Effect.fnUntraced(function* (cwd: string, workspaceId?: WorkspaceId) {
      const checkout = yield* canonical(cwd);
      const model = yield* store.model;

      const roots = [
        ...[...model.workspaces.values()].map((w) => ({ path: w.path, workspaceId: w.id })),
        ...[...model.worktrees.values()].map((w) => ({
          path: w.path,
          workspaceId: w.workspaceId,
        })),
      ]
        .filter((root) => workspaceId === undefined || root.workspaceId === workspaceId)
        .sort((a, b) => b.path.length - a.path.length);

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

    const session = Effect.fnUntraced(function* (id: SessionId) {
      const model = yield* store.model;
      const record = model.sessions.get(id);

      if (record === undefined) {
        cache.delete(id);

        return yield* noSession();
      }

      const last = record.turns.at(-1);

      const boundary = JSON.stringify([
        record.session.turnCount,
        last?.id,
        last?.startedAt,
        last?.endedAt,
        last?.userTurnNumber,
      ]);

      const existing = cache.get(id);

      const sameCheckout =
        existing !== undefined &&
        existing.cwd === record.session.cwd &&
        existing.workspaces === model.workspaces &&
        existing.worktrees === model.worktrees &&
        existing.context.workspaceId === record.session.workspaceId;

      if (sameCheckout && existing.boundary === boundary) return existing.context;

      const checkout = sameCheckout
        ? existing.context.checkout
        : (yield* workspace(record.session.cwd, record.session.workspaceId)).checkout;

      const firstIndex = record.turns[0]?.index ?? record.session.turnCount;

      const turns =
        existing !== undefined && existing.count >= firstIndex
          ? [
              ...existing.context.turns.slice(0, firstIndex),
              ...record.turns.map((turn) => interval(id, turn)),
            ]
          : (yield* store
              .readTurns({ sessionId: id, beforeIndex: null, limit: null })
              .pipe(Effect.mapError(noSession))).map((turn) => interval(id, turn));

      const context: IngestContext = {
        checkout,
        workspaceId: record.session.workspaceId,
        sessionId: id,
        turns,
      };

      if (cache.size >= 64 && !cache.has(id)) cache.delete(cache.keys().next().value!);
      cache.set(id, {
        boundary,
        count: record.session.turnCount,
        cwd: record.session.cwd,
        workspaces: model.workspaces,
        worktrees: model.worktrees,
        context,
      });

      return context;
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
