/**
 * Which Agent Sessions may hold a relay token (ENG-616): a token is issued and admitted only
 * for a session the Daemon knows that isn't archived, and revoked once it is.
 */
import type { SessionId } from "@polaris/protocol";
import { Effect, Schema } from "effect";
import type { EventStore } from "../store/EventStore.ts";

export const SessionPresence = Schema.Literals(["live", "archived", "unknown"]);

export type SessionPresence = typeof SessionPresence.Type;

export interface SessionLookup {
  readonly presence: (sessionId: SessionId) => Effect.Effect<SessionPresence>;
}

/** Reads the committed Session State from the event store's model. */
export const sessionsFromStore = (store: EventStore["Service"]): SessionLookup => ({
  presence: (sessionId) =>
    Effect.map(store.model, (model) => {
      const record = model.sessions.get(sessionId);

      if (record === undefined) return "unknown";

      return record.session.state === "archived" ? "archived" : "live";
    }),
});

/** For Daemons without an event store (tests): every session is live. */
export const everySessionLive: SessionLookup = { presence: () => Effect.succeed("live") };
