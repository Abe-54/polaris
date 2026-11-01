/**
 * The files a Secret Request's value lands in (ADR 0089): one per secret under
 * `<root>/<sessionId>/`, private by POSIX modes or Windows DACLs, deleted after `ttlMs`
 * by one timer per live secret (and a sweep on start), so an idle Daemon never wakes.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createPrivateDirectory,
  setPrivateDacl,
  writePrivateFile,
} from "../platform/windowsNative.ts";
import { SECRET_TTL_MS, SessionId, TurnItem } from "@polaris/protocol";
import { Duration, Effect, Redacted, Schema } from "effect";

export class SessionSecretError extends Schema.TaggedError<SessionSecretError>()(
  "SessionSecretError",
  { message: Schema.String }
) {}

/** What stands in for a live secret in anything Polaris records. */
export const REDACTED = "[secret]";

/** Shorter values would match ordinary text, so they aren't redacted. */
const MIN_REDACTED_LENGTH = 6;

export interface SessionSecretFiles {
  /** A fresh path for a secret of this session; nothing is written yet. */
  readonly reserve: (sessionId: SessionId) => string;
  readonly write: (
    sessionId: SessionId,
    path: string,
    value: Redacted.Redacted<string>
  ) => Effect.Effect<void, SessionSecretError>;
  /** Deletes one secret, written or not. */
  readonly discard: (path: string) => Effect.Effect<void>;
  /** Deletes every secret of the session (it was archived or removed). */
  readonly forget: (sessionId: SessionId) => Effect.Effect<void>;
  /**
   * `item` with every live secret on the Host replaced by `[secret]`, in every field. Any agent
   * running as this user could read another session's file, so redaction isn't per session.
   */
  readonly redact: (item: TurnItem) => TurnItem;
  readonly redactText: (text: string) => string;
}

/** `text` with each secret, as JSON escapes it, replaced by `[secret]`. */
const replaceAll = (json: string, secrets: ReadonlyArray<string>) =>
  secrets.reduce(
    (acc, secret) => acc.split(JSON.stringify(secret).slice(1, -1)).join(REDACTED),
    json
  );

const decodeItem = Schema.decodeUnknownSync(Schema.fromJsonString(TurnItem));

const failed = (message: string) => (cause: unknown) =>
  new SessionSecretError({
    message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

/** One path segment per session whatever its id holds ("..", "/"): the id's UTF-8 bytes in hex. */
const segmentOf = (sessionId: SessionId) => Buffer.from(sessionId, "utf8").toString("hex");

const sessionOf = (segment: string): SessionId | null =>
  /^(?:[0-9a-f]{2})+$/.test(segment)
    ? SessionId.make(Buffer.from(segment, "hex").toString("utf8"))
    : null;

const removeQuietly = (path: string) =>
  Effect.promise(() => rm(path, { force: true, recursive: true }).catch(() => undefined));

/** The store, swept and with its timers armed; timers end with the scope. */
export const sessionSecretFiles = Effect.fn("sessionSecretFiles")(function* (
  root: string,
  options: { readonly ttlMs?: number; readonly now?: () => number } = {}
) {
  const ttlMs = options.ttlMs ?? SECRET_TTL_MS;
  const now = options.now ?? Date.now;
  const scope = yield* Effect.scope;
  /** Live values by session, then by path. */
  const live = new Map<SessionId, Map<string, string>>();

  const drop = (sessionId: SessionId, path: string) => {
    const paths = live.get(sessionId);
    paths?.delete(path);

    if (paths?.size === 0) live.delete(sessionId);
  };

  const discard = (path: string) =>
    Effect.suspend(() => {
      for (const [sessionId, paths] of live) if (paths.has(path)) drop(sessionId, path);

      return removeQuietly(path);
    });

  const arm = (sessionId: SessionId, path: string, value: string, remainingMs: number) =>
    Effect.suspend(() => {
      const paths = live.get(sessionId) ?? new Map<string, string>();
      paths.set(path, value);
      live.set(sessionId, paths);

      return Effect.sleep(Duration.millis(Math.max(0, remainingMs))).pipe(
        Effect.andThen(discard(path)),
        Effect.forkIn(scope),
        Effect.asVoid
      );
    });

  // Sweep: delete what expired while the Daemon was down; re-arm the rest.
  const sessions = yield* Effect.promise(() => readdir(root).catch(() => []));

  for (const name of sessions) {
    const sessionId = sessionOf(name);
    const dir = join(root, name);

    if (sessionId === null) {
      yield* removeQuietly(dir);
      continue;
    }

    const files = yield* Effect.promise(() => readdir(dir).catch(() => []));

    for (const file of files) {
      const path = join(dir, file);
      const info = yield* Effect.promise(() => stat(path).catch(() => null));
      const remaining = info === null ? 0 : info.mtimeMs + ttlMs - now();

      if (info === null || !info.isFile() || remaining <= 0 || file.endsWith(".tmp")) {
        yield* removeQuietly(path);
        continue;
      }

      const value = yield* Effect.promise(() => readFile(path, "utf8").catch(() => null));

      if (value === null) yield* removeQuietly(path);
      else yield* arm(sessionId, path, value, remaining);
    }
  }

  const redactable = () =>
    [...live.values()]
      .flatMap((paths) => [...paths.values()])
      .filter((secret) => secret.length >= MIN_REDACTED_LENGTH);

  const files: SessionSecretFiles = {
    reserve: (sessionId) => join(root, segmentOf(sessionId), randomBytes(16).toString("hex")),
    write: (sessionId, path, value) =>
      Effect.tryPromise({
        try: async () => {
          const dir = join(root, segmentOf(sessionId));

          if (process.platform === "win32") {
            await mkdir(root, { recursive: true, mode: 0o700 });

            if (!setPrivateDacl(root, "directory"))
              throw new Error("could not protect secret root");

            if (!createPrivateDirectory(dir) && !setPrivateDacl(dir, "directory"))
              throw new Error("could not protect secret directory");

            writePrivateFile(path, Redacted.value(value));

            return;
          }

          await mkdir(dir, { recursive: true, mode: 0o700 });
          await chmod(root, 0o700);
          await chmod(dir, 0o700);
          const temporary = `${path}.tmp`;
          await writeFile(temporary, Redacted.value(value), { mode: 0o600, flag: "wx" });
          await rename(temporary, path);
        },
        catch: failed("could not save the secret"),
      }).pipe(Effect.andThen(arm(sessionId, path, Redacted.value(value), ttlMs))),
    discard,
    forget: (sessionId) =>
      Effect.suspend(() => {
        live.delete(sessionId);

        return removeQuietly(join(root, segmentOf(sessionId)));
      }),
    redact: (item) => {
      const secrets = redactable();

      if (secrets.length === 0) return item;
      const json = JSON.stringify(item);
      const redacted = replaceAll(json, secrets);

      return redacted === json ? item : decodeItem(redacted);
    },
    redactText: (text) => {
      const secrets = redactable();

      return secrets.length === 0
        ? text
        : secrets.reduce((acc, secret) => acc.split(secret).join(REDACTED), text);
    },
  };

  return files;
});
