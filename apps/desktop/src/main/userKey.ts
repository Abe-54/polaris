/**
 * The user key (ENG-700, ADR 0100): 32 random bytes this Desktop App presents in `hello`, so
 * a Host lets it approve and make the other user-only requests. Kept in `SecureStorage` as
 * `user-access/key`, never in an environment the Desktop App or a Daemon hands a child.
 */
import { createHmac, randomBytes } from "node:crypto";
import { UserKey } from "@polaris/protocol";
import { Effect, Option, Redacted, Schema } from "effect";
import { loadLanguageCredential } from "./languages/credential.ts";
import { SecureStorage } from "./secure/index.ts";

export const USER_KEY = "user-access/key";

const decodeKey = Schema.decodeUnknownEffect(UserKey);

/** No key could be loaded or made; this Desktop App then can't approve on any Host. */
export class UserKeyUnavailable extends Schema.TaggedError<UserKeyUnavailable>()(
  "UserKeyUnavailable",
  { message: Schema.String }
) {}

const refuse = (message: string) => () => new UserKeyUnavailable({ message });

const redact = (key: string) => Redacted.make(key, { label: "user key" });

export interface UserKeyInput {
  /** `<userData>/user-access-private`: the 0600 file used where there is no secret store. */
  readonly fileDirectory: string;
  readonly platform: NodeJS.Platform;
}

/** Linux without a keyring: the same owner-only file checks as the language proof's. */
const fileKey = (input: UserKeyInput) =>
  input.platform === "win32"
    ? Effect.fail(new UserKeyUnavailable({ message: "no secret store on this machine" }))
    : Effect.try({
        try: () => redact(Redacted.value(loadLanguageCredential(input.fileDirectory))),
        catch: refuse("the user key file is unsafe"),
      });

/** Loads the key, or makes one when there is none; a stored one that won't open is never replaced. */
export const loadUserKey = Effect.fn("loadUserKey")(function* (input: UserKeyInput) {
  const storage = yield* SecureStorage;

  if (!(yield* storage.available)) return yield* fileKey(input);

  const stored = yield* storage
    .get(USER_KEY)
    .pipe(Effect.mapError(refuse("the stored user key can't be opened")));

  if (Option.isSome(stored))
    return redact(yield* Effect.mapError(decodeKey(stored.value), refuse("corrupt user key")));

  const key = randomBytes(32).toString("hex");

  yield* storage.set(USER_KEY, key).pipe(Effect.mapError(refuse("the user key can't be stored")));

  return redact(key);
});

/**
 * The key one Host sees: HMAC of the master key and this app's own name for the Host (`local`,
 * the SSH alias), so a key captured on one Host is useless on every other.
 */
export const userKeyForHost = (
  master: Redacted.Redacted<string>,
  hostKey: string
): Redacted.Redacted<string> =>
  redact(
    createHmac("sha256", Redacted.value(master))
      .update(`polaris-user-key-v1:${hostKey}`)
      .digest("hex")
  );

/** Without a key the Desktop App still connects; Hosts refuse it approvals and secrets. */
export const optionalUserKey = (input: UserKeyInput, warn: (message: string) => void) =>
  loadUserKey(input).pipe(
    Effect.map((userKey) => ({ userKey })),
    Effect.catch((error) =>
      Effect.sync(() => {
        warn(`User key unavailable: ${error.message}`);

        return {};
      })
    )
  );
