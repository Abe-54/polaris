/**
 * What the CDP relay keeps per Agent Session (ENG-616): its tokens, hashed as `mcp/tokens.ts`
 * hashes MCP tokens, and the tabs its Browser last reported, so a Desktop App that takes the
 * Browser over reopens them. Raw tokens live only in memory, so the same URL is reissued
 * until the Daemon restarts; the hashes outlive it, so an agent's URL keeps working.
 */
import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { SessionId } from "@polaris/protocol";
import { Context, Effect, Layer, Option, Schema } from "effect";

export class CdpRelayStoreError extends Schema.TaggedError<CdpRelayStoreError>()(
  "CdpRelayStoreError",
  { message: Schema.String }
) {}

/** A tab as the hosting Desktop App reports it, enough for `/json/list` and a reopen. */
export const RememberedTab = Schema.Struct({
  targetId: Schema.String,
  url: Schema.String,
  title: Schema.String,
});

export type RememberedTab = typeof RememberedTab.Type;

const decodeTabs = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(RememberedTab)));

const Row = Schema.Struct({ n: Schema.Number });

const decodeCount = Schema.decodeUnknownSync(Row);

const TabsRow = Schema.Struct({ tabs: Schema.String });

const IdRow = Schema.Struct({ id: SessionId });

const decodeIdRow = Schema.decodeUnknownSync(IdRow);

const decodeTabsRow = Schema.decodeUnknownOption(TabsRow);

const TOKEN = /^[a-f0-9]{64}$/;

const digest = (token: string) => createHash("sha256").update(token).digest("hex");

export class CdpRelayStore extends Context.Service<
  CdpRelayStore,
  {
    /** The session's current token, issuing one when this process has none. */
    readonly issue: (sessionId: SessionId) => Effect.Effect<string, CdpRelayStoreError>;
    /** Whether `token` is a live token of `sessionId`. */
    readonly authenticate: (
      sessionId: SessionId,
      token: string
    ) => Effect.Effect<boolean, CdpRelayStoreError>;
    /** Revokes every token of the session, in memory and on disk. */
    readonly revoke: (sessionId: SessionId) => Effect.Effect<void, CdpRelayStoreError>;
    /** Every session with a live token on disk, for reconciling against Session State. */
    readonly sessions: Effect.Effect<ReadonlyArray<SessionId>, CdpRelayStoreError>;
    readonly remember: (
      sessionId: SessionId,
      tabs: ReadonlyArray<RememberedTab>
    ) => Effect.Effect<void, CdpRelayStoreError>;
    readonly remembered: (
      sessionId: SessionId
    ) => Effect.Effect<ReadonlyArray<RememberedTab>, CdpRelayStoreError>;
  }
>()("polaris/daemon/browser/CdpRelayStore") {
  static layer(path: string) {
    return Layer.effect(
      CdpRelayStore,
      Effect.gen(function* () {
        const db = yield* Effect.acquireRelease(
          Effect.try({
            try: () => {
              const database = new Database(path, { create: true });
              chmodSync(path, 0o600);

              return database;
            },
            catch: () => new CdpRelayStoreError({ message: "Could not open the CDP relay store" }),
          }),
          (database) => Effect.sync(() => database.close())
        );

        db.exec(`CREATE TABLE IF NOT EXISTS cdp_tokens (
          hash TEXT PRIMARY KEY, session_id TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
        )`);
        db.exec(
          `CREATE TABLE IF NOT EXISTS cdp_tabs (session_id TEXT PRIMARY KEY, tabs TEXT NOT NULL)`
        );
        const issued = new Map<SessionId, string>();

        const run = <A>(body: () => A) =>
          Effect.try({
            try: body,
            catch: () =>
              new CdpRelayStoreError({ message: "Could not access the CDP relay store" }),
          });

        return CdpRelayStore.of({
          issue: (sessionId) =>
            run(() => {
              const current = issued.get(sessionId);

              if (current !== undefined) return current;
              const token = randomBytes(32).toString("hex");
              db.query("INSERT INTO cdp_tokens (hash, session_id) VALUES (?, ?)").run(
                digest(token),
                sessionId
              );
              issued.set(sessionId, token);

              return token;
            }),
          authenticate: (sessionId, token) =>
            run(() => {
              if (!TOKEN.test(token)) return false;

              const row = decodeCount(
                db
                  .query(
                    "SELECT COUNT(*) AS n FROM cdp_tokens WHERE hash = ? AND session_id = ? AND revoked = 0"
                  )
                  .get(digest(token), sessionId)
              );

              return row.n > 0;
            }),
          sessions: run(() =>
            db
              .query("SELECT DISTINCT session_id AS id FROM cdp_tokens WHERE revoked = 0")
              .all()
              .map((row) => decodeIdRow(row).id)
          ),
          revoke: (sessionId) =>
            run(() => {
              issued.delete(sessionId);
              db.query("UPDATE cdp_tokens SET revoked = 1 WHERE session_id = ?").run(sessionId);
              db.query("DELETE FROM cdp_tabs WHERE session_id = ?").run(sessionId);
            }),
          remember: (sessionId, tabs) =>
            run(() => {
              db.query(
                "INSERT INTO cdp_tabs (session_id, tabs) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET tabs = excluded.tabs"
              ).run(sessionId, JSON.stringify(tabs));
            }),
          remembered: (sessionId) =>
            run(() => {
              const row = decodeTabsRow(
                db.query("SELECT tabs FROM cdp_tabs WHERE session_id = ?").get(sessionId)
              );

              return Option.getOrElse(
                Option.flatMap(row, (r) => decodeTabs(r.tabs)),
                () => []
              );
            }),
        });
      })
    );
  }
}
