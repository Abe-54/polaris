import { Effect, Option, Predicate, Stream } from "effect";
import { EventStore } from "../store/EventStore.ts";
import type { TraceTokenVault } from "./tokens.ts";

/** The event log owns token lifetime; Harness scopes may close without ending their sessions. */
export const followTokenLifecycle = Effect.fnUntraced(function* (vault: TraceTokenVault) {
  const service = yield* Effect.serviceOption(EventStore);

  if (Option.isNone(service)) return;
  const store = service.value;

  const reconcile = Effect.gen(function* () {
    const model = yield* store.model;
    yield* Effect.sync(() =>
      vault.prune(
        (id) => {
          const session = model.sessions.get(id)?.session;

          return (
            session !== undefined && session.state !== "archived" && session.state !== "failed"
          );
        },
        (id) => model.workspaces.has(id)
      )
    );
  });

  const follow = Effect.gen(function* () {
    const events = yield* store.subscribe({
      filter: (item) =>
        Predicate.isTagged(item, "Event") &&
        (Predicate.isTagged(item.envelope.event, "WorkspaceRemoved") ||
          Predicate.isTagged(item.envelope.event, "SessionStateChanged")),
    });

    yield* reconcile;
    yield* events.pipe(
      Stream.runForEach((item) =>
        Effect.gen(function* () {
          if (!Predicate.isTagged(item, "Event")) return;
          const event = item.envelope.event;

          if (Predicate.isTagged(event, "WorkspaceRemoved")) {
            yield* Effect.sync(() => vault.revokeWorkspace(event.workspaceId));
          }

          yield* reconcile;
        })
      )
    );
  });

  yield* Effect.forkScoped(Effect.forever(follow));
});
