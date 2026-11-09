import { expect, test } from "bun:test";
import { join } from "node:path";
import { Effect, type Layer, Option, Redacted } from "effect";
import { SecureStorage } from "./secure/index.ts";
import { testSealer, withUserData } from "./secure/secure.testing.ts";
import { optionalUserKey, USER_KEY, userKeyForHost } from "./userKey.ts";

const files = (userData: string) =>
  SecureStorage.files({ dir: join(userData, "secure"), sealer: testSealer() });

/** What Main's startup does: the identity fields it spreads in, and its warnings. */
const start = async (layer: Layer.Layer<SecureStorage>, userData: string) => {
  const warnings: Array<string> = [];

  const input = {
    fileDirectory: join(userData, "user-access-private"),
    platform: "darwin" as const,
  };

  const options = await Effect.runPromise(
    Effect.provide(
      optionalUserKey(input, (message) => warnings.push(message)),
      layer
    )
  );

  return { key: "userKey" in options ? Redacted.value(options.userKey) : null, warnings };
};

test("the user key survives a restart, so an enrolled Host keeps recognising this Desktop App", () =>
  withUserData(async (userData) => {
    const first = await start(files(userData), userData);
    const second = await start(files(userData), userData);

    expect(first.key).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toEqual(first);
  }));

test("a corrupt stored key is reported and never replaced by a new one", () =>
  withUserData(async (userData) => {
    await Effect.runPromise(
      Effect.provide(
        SecureStorage.use((storage) => storage.set(USER_KEY, "not-a-key")),
        files(userData)
      )
    );

    const result = await start(files(userData), userData);

    const kept = await Effect.runPromise(
      Effect.provide(
        SecureStorage.use((storage) => storage.get(USER_KEY)),
        files(userData)
      )
    );

    expect(result).toEqual({ key: null, warnings: ["User key unavailable: corrupt user key"] });
    expect(Option.getOrNull(kept)).toBe("not-a-key");
  }));

test("each Host gets its own key, one the Host accepts, so a key captured on one opens no other", () => {
  const master = Redacted.make("c".repeat(64));
  const local = Redacted.value(userKeyForHost(master, "local"));

  expect(local).toMatch(/^[a-f0-9]{64}$/);
  expect(Redacted.value(userKeyForHost(master, "local"))).toBe(local);
  expect(Redacted.value(userKeyForHost(master, "lucas-rpi"))).not.toBe(local);
  expect(Redacted.value(userKeyForHost(Redacted.make("d".repeat(64)), "local"))).not.toBe(local);
});
