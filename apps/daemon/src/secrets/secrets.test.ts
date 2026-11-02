import { expect, test } from "bun:test";
import { rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer, Option, Redacted } from "effect";
import { suiteTempDir } from "../platform/tempDir.testing.ts";
import { CommandRunner } from "../service/CommandRunner.ts";
import { fileSecrets, HostSecrets, keychainSecrets } from "./index.ts";

const temporary = suiteTempDir("pl-sec-", { short: true });

const VALUE = Redacted.make("0123456789abcdef0123456789abcdef01234567");

const revealed = (value: Option.Option<Redacted.Redacted<string>>) =>
  Option.getOrNull(Option.map(value, Redacted.value));

test("the file store keeps a key only its user can read, and removes it", async () => {
  const dir = join(temporary(), "secrets");
  const store = fileSecrets(dir);

  const [missing, stored] = await Effect.runPromise(
    Effect.gen(function* () {
      const missing = yield* store.get("voice/deepgram");
      yield* store.set("voice/deepgram", VALUE);

      return [missing, yield* store.get("voice/deepgram")] as const;
    })
  );

  expect(revealed(missing)).toBeNull();
  expect(revealed(stored)).toBe(Redacted.value(VALUE));
  // Windows has no POSIX modes; the key lives in the user's own profile there.

  if (process.platform !== "win32") {
    expect(statSync(join(dir, "voice/deepgram.secret")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  }

  await Effect.runPromise(store.remove("voice/deepgram"));
  expect(revealed(await Effect.runPromise(store.get("voice/deepgram")))).toBeNull();
});

// Planting a symlink on Windows needs Developer Mode or an administrator.
test.skipIf(process.platform === "win32")(
  "the file store does not follow a link planted in place of a key",
  async () => {
    const root = temporary();
    const dir = join(root, "secrets");
    const elsewhere = join(root, "elsewhere");
    writeFileSync(elsewhere, "planted");
    await Effect.runPromise(fileSecrets(dir).set("voice/deepgram", VALUE));
    rmSync(join(dir, "voice/deepgram.secret"));
    symlinkSync(elsewhere, join(dir, "voice/deepgram.secret"));

    const exit = await Effect.runPromiseExit(fileSecrets(dir).get("voice/deepgram"));
    expect(exit._tag).toBe("Failure");
  }
);

test("a key that is not a namespaced name, or a value with spaces, is refused", async () => {
  const store = fileSecrets(join(temporary(), "secrets"));
  const traversal = await Effect.runPromiseExit(store.set("../escape", VALUE));
  const spaced = await Effect.runPromiseExit(store.set("voice/deepgram", Redacted.make("a b")));

  expect([traversal._tag, spaced._tag]).toEqual(["Failure", "Failure"]);
});

test("the Keychain store passes the value on stdin, never in a command line", async () => {
  const argvs: Array<ReadonlyArray<string>> = [];
  let stored: string | null = null;

  const runner = CommandRunner.of({
    run: (argv, options) =>
      Effect.sync(() => {
        argvs.push(argv);

        if (argv[1] === "-i") {
          stored = /-w (\S+)/.exec(options?.stdin ?? "")?.[1] ?? null;

          return { code: 0, stdout: "", stderr: "" };
        }

        return stored === null
          ? { code: 44, stdout: "", stderr: "" }
          : { code: 0, stdout: `${stored}\n`, stderr: "" };
      }),
  });

  const value = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* keychainSecrets();
      yield* store.set("voice/deepgram", VALUE);

      return yield* store.get("voice/deepgram");
    }).pipe(Effect.provide(Layer.succeed(CommandRunner)(runner)))
  );

  expect(revealed(value)).toBe(Redacted.value(VALUE));
  expect(argvs.flat().some((arg) => arg.includes(Redacted.value(VALUE)))).toBe(false);
});

test.skipIf(process.platform !== "darwin")(
  "the Keychain store round-trips through a real keychain file",
  async () => {
    const keychain = join(temporary(), "test.keychain-db");
    const security = (...args: Array<string>) => Bun.spawnSync(["/usr/bin/security", ...args]);
    expect(security("create-keychain", "-p", "pw", keychain).exitCode).toBe(0);

    try {
      expect(security("unlock-keychain", "-p", "pw", keychain).exitCode).toBe(0);

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* keychainSecrets({ keychain });
          const before = yield* store.get("voice/deepgram");
          yield* store.set("voice/deepgram", VALUE);
          const after = yield* store.get("voice/deepgram");
          yield* store.remove("voice/deepgram");

          return [before, after, yield* store.get("voice/deepgram")] as const;
        }).pipe(Effect.provide(CommandRunner.layer))
      );

      expect(result.map(revealed)).toEqual([null, Redacted.value(VALUE), null]);
    } finally {
      security("delete-keychain", keychain);
    }
  }
);

// RV1 / RX1-4: an inherited environment must not move the Host's identity off the Keychain.
test.if(process.platform === "darwin")(
  "POLARIS_SECRETS=file no longer selects the file store on macOS",
  async () => {
    const before = process.env.POLARIS_SECRETS;
    process.env.POLARIS_SECRETS = "file";

    try {
      const store = await Effect.runPromise(
        Effect.provide(
          Effect.map(HostSecrets, (secrets) => secrets.store),
          HostSecrets.layer
        )
      );

      expect(store).toBe("keychain");
    } finally {
      if (before === undefined) delete process.env.POLARIS_SECRETS;
      else process.env.POLARIS_SECRETS = before;
    }
  }
);
