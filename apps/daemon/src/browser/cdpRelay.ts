/**
 * Each Agent Session's loopback CDP WebSocket (ENG-616, ADR 0092): `agent-browser` connects to
 * it (`AGENT_BROWSER_CDP`), and the Daemon relays it over a `cdp` Browser stream to the
 * Desktop App hosting the session's Browser. See `README.md`.
 */
import { DomainEvent, SessionId } from "@polaris/protocol";
import { Context, Effect, Layer, Option, Schema, Stream } from "effect";
import { join } from "node:path";
import { EventStore } from "../store/EventStore.ts";
import { LiveItem } from "../store/hub.ts";
import { BrowserHosting } from "./hosting.ts";
import { startRelayServer } from "./relayServer.ts";
import type { RelaySocket } from "./relaySocket.ts";
import { everySessionLive, type SessionLookup, sessionsFromStore } from "./relaySessions.ts";
import { CdpRelayStore } from "./relayStore.ts";
import { cdpRelayUrl } from "./relayUrl.ts";

export { type SessionLookup, type SessionPresence } from "./relaySessions.ts";

/** Agent sockets one session may hold open, and the relay as a whole. */
export const RELAY_MAX_SOCKETS_PER_SESSION = 8;

export const RELAY_MAX_SOCKETS = 64;

/** A relay URL exists only for a session the Daemon knows that isn't archived. */
export class CdpSessionNotLive extends Schema.TaggedError<CdpSessionNotLive>()(
  "CdpSessionNotLive",
  { sessionId: SessionId, presence: Schema.Literals(["archived", "unknown"]) }
) {
  override get message() {
    return this.presence === "archived"
      ? `Session ${this.sessionId} is archived: its Browser is gone`
      : `Session ${this.sessionId} is not known to this Daemon`;
  }
}

export { cdpRelayUrl } from "./relayUrl.ts";

export interface CdpEndpoint {
  /** `ws://127.0.0.1:<port>/browser/<sessionId>/<token>`. Secret: it carries the token. */
  readonly url: string;
}

export interface CdpRelayOptions {
  /** The Daemon's private home; the token store is `browser-cdp.sqlite` there. */
  readonly home: string;
  /** The Daemon's version, shown by `/json/version`. */
  readonly version: string;
  /** 0 (the default) picks a free port; a URL outlives the Daemon only on a fixed one. */
  readonly port?: number;
  /** Session State to issue and admit against; default the event store's, or every session live without one. */
  readonly sessions?: SessionLookup;
}

const archived = (item: LiveItem) =>
  LiveItem.$is("Event")(item) &&
  DomainEvent.guards.SessionStateChanged(item.envelope.event) &&
  item.envelope.event.state === "archived";

/** Revokes each session as it is archived; resubscribes if the feed drops it for lagging. */
const revokeArchived = (
  store: EventStore["Service"],
  revoke: (sessionId: SessionId) => Effect.Effect<void>
) =>
  Effect.gen(function* () {
    const items = yield* store.subscribe({ filter: archived });
    yield* items.pipe(
      Stream.runForEach((item) =>
        LiveItem.$is("Event")(item) && DomainEvent.guards.SessionStateChanged(item.envelope.event)
          ? revoke(item.envelope.event.sessionId)
          : Effect.void
      )
    );
  }).pipe(Effect.scoped, Effect.forever);

export class CdpRelay extends Context.Service<
  CdpRelay,
  {
    /** The session's relay URL, issuing a token on first use; the same URL until revoked. */
    readonly issue: (sessionId: SessionId) => Effect.Effect<CdpEndpoint, CdpSessionNotLive>;
    /** Revokes the session's token and closes its open relay sockets. Idempotent. */
    readonly revoke: (sessionId: SessionId) => Effect.Effect<void>;
  }
>()("polaris/daemon/browser/CdpRelay") {
  /** The relay on a loopback port, over `BrowserHosting`. */
  static layer(options: CdpRelayOptions) {
    return Layer.effect(
      CdpRelay,
      Effect.gen(function* () {
        const hosting = yield* BrowserHosting;
        const store = yield* CdpRelayStore;
        const eventStore = yield* Effect.serviceOption(EventStore);

        const sessions =
          options.sessions ??
          (Option.isSome(eventStore) ? sessionsFromStore(eventStore.value) : everySessionLive);

        const sockets = new Map<SessionId, Set<RelaySocket>>();
        let open = 0;

        const revoke = Effect.fn("CdpRelay.revoke")(function* (sessionId: SessionId) {
          yield* store.revoke(sessionId).pipe(Effect.orDie);

          for (const socket of sockets.get(sessionId) ?? []) socket.close(1008, "revoked");
        });

        /** Live when the session is; a token of a gone session dies the moment it is seen. */
        const live = Effect.fn("CdpRelay.live")(function* (sessionId: SessionId) {
          const presence = yield* sessions.presence(sessionId);

          if (presence === "live") return Option.none<"archived" | "unknown">();
          yield* revoke(sessionId);

          return Option.some(presence);
        });

        // Tokens of sessions archived (or forgotten) while the Daemon was down die at startup.
        for (const sessionId of yield* store.sessions.pipe(Effect.orDie)) yield* live(sessionId);

        const server = yield* startRelayServer({
          port: options.port ?? 0,
          version: options.version,
          store,
          authenticate: (sessionId, token) =>
            Effect.gen(function* () {
              if (!(yield* store.authenticate(sessionId, token).pipe(Effect.orDie))) return false;

              return Option.isNone(yield* live(sessionId));
            }),
          hosted: (sessionId) =>
            hosting.current(sessionId).pipe(
              Effect.as(true),
              Effect.catchTag("NoDesktopApp", () => Effect.succeed(false))
            ),
          hooks: {
            open: (sessionId) => hosting.open(sessionId, "cdp"),
            remembered: (sessionId) => store.remembered(sessionId).pipe(Effect.orDie),
            remember: (sessionId, tabs) => store.remember(sessionId, tabs).pipe(Effect.orDie),
            opened: (socket) => {
              const set = sockets.get(socket.sessionId) ?? new Set<RelaySocket>();

              if (set.size >= RELAY_MAX_SOCKETS_PER_SESSION || open >= RELAY_MAX_SOCKETS)
                return false;
              set.add(socket);
              sockets.set(socket.sessionId, set);
              open += 1;

              return true;
            },
            closed: (socket) => {
              const set = sockets.get(socket.sessionId);

              if (set?.delete(socket) === true) open -= 1;

              if (set?.size === 0) sockets.delete(socket.sessionId);
            },
          },
        });

        const port = server.port ?? options.port ?? 0;

        // An archived session's URL dies with it, as its MCP bindings do (`mcp/revoke.ts`).
        if (Option.isSome(eventStore))
          yield* Effect.forkScoped(revokeArchived(eventStore.value, revoke));

        return CdpRelay.of({
          issue: Effect.fn("CdpRelay.issue")(function* (sessionId: SessionId) {
            const gone = yield* live(sessionId);

            if (Option.isSome(gone))
              return yield* new CdpSessionNotLive({ sessionId, presence: gone.value });
            const token = yield* store.issue(sessionId).pipe(Effect.orDie);

            return { url: cdpRelayUrl(port, sessionId, token) };
          }),
          revoke,
        });
      })
    ).pipe(Layer.provide(CdpRelayStore.layer(join(options.home, "browser-cdp.sqlite"))));
  }

  /** Placeholder for tests and Daemons without a Browser: `issue` dies, `revoke` does nothing. */
  static readonly layerStub = Layer.succeed(CdpRelay)(
    CdpRelay.of({
      issue: Effect.fn("CdpRelay.issue")(function* (sessionId: SessionId) {
        return yield* Effect.die(new Error(`the CDP relay for ${sessionId} is not implemented`));
      }),
      revoke: Effect.fn("CdpRelay.revoke")(function* () {}),
    })
  );
}
