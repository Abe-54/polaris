/**
 * `voice.transcribe` over a real socket (ENG-404): an Extension with the voice
 * Grant streams PCM as a blob and gets snapshots back from a fake provider;
 * without the Grant, or without a key, it is refused; the key never comes back.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { connectRpcWith, socketTransport } from "@polaris/client";
import {
  ExtensionDaemonRpcs,
  type Grant,
  NotGranted,
  VoiceError,
  VoiceSettings,
  VoiceTranscript,
} from "@polaris/protocol";
import { Deferred, Effect, Exit, Fiber, Layer, Redacted, Scope, Stream } from "effect";
import type { RpcGroup } from "effect/rpc";
import { shortTemp } from "../platform/testing.ts";
import { startServer } from "../transport/server.ts";
import { HostSecrets, memorySecrets } from "../secrets/index.ts";
import { VoiceProvider } from "./provider.ts";
import { makeVoiceRpcs } from "./VoiceRpcs.ts";
import { NO_KEY_MESSAGE } from "./keys.ts";
import { deepgramProvider } from "./deepgram.ts";

const KEY = "0123456789abcdef0123456789abcdef01234567";

/** Says how many bytes it heard after each chunk, then the total as final text, under the key it got. */
const countingProvider = VoiceProvider.of({
  kind: "deepgram",
  transcribe: (key, audio) =>
    Stream.unwrap(
      Effect.sync(() => {
        let heard = 0;

        return audio.pipe(
          Stream.map((chunk) => {
            heard += chunk.byteLength;

            return { text: `${heard} bytes`, isFinal: false };
          }),
          Stream.concat(
            Stream.sync(() => ({
              text: `${heard} bytes for ${Redacted.value(key).slice(0, 4)}`,
              isFinal: true,
            }))
          )
        );
      })
    ),
});

const temporary = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(shortTemp("pl-voice-"))),
  (root) => Effect.sync(() => rmSync(root, { recursive: true, force: true }))
);

const identity = { clientName: "test", clientVersion: "0", deviceLabel: "Test", capabilities: [] };

const pcm = (bytes: number) => new Uint8Array(bytes).fill(1);

const run = <A>(
  body: (helpers: Helpers) => Effect.Effect<A, unknown, Scope.Scope>,
  limit?: number,
  provider = countingProvider,
  limits?: { readonly maxAudioBytes: number; readonly maxDurationMs: number },
  secrets = memorySecrets()
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporary;

        const server = yield* startServer({
          root,
          socketPath: join(root, "d.sock"),
          lockPath: join(root, "d.lock"),
          handlers: makeVoiceRpcs(limit, limits).pipe(
            Layer.provide(
              Layer.merge(
                Layer.succeed(VoiceProvider)(provider),
                Layer.succeed(HostSecrets)(secrets)
              )
            )
          ),
        });

        const connect = () =>
          Effect.flatMap(socketTransport(server.socketPath), (transport) =>
            connectRpcWith(ExtensionDaemonRpcs, transport)
          );

        const desktop = yield* connect();
        yield* desktop.client.hello(identity);

        const extension = (grant: Grant) =>
          Effect.gen(function* () {
            const { token } = yield* desktop.client["extensions.pair"]({ name: "G2", grant });
            const connection = yield* connect();
            yield* connection.client.hello({ ...identity, extensionToken: Redacted.make(token) });

            return connection;
          });

        return yield* body({ desktop, extension });
      })
    )
  );

type Connection = Effect.Success<
  ReturnType<typeof connectRpcWith<RpcGroup.Rpcs<typeof ExtensionDaemonRpcs>>>
>;

interface Helpers {
  readonly desktop: Connection;
  readonly extension: (grant: Grant) => Effect.Effect<Connection, unknown, Scope.Scope>;
}

const transcribe = (
  connection: Connection,
  chunks: ReadonlyArray<Uint8Array>
): Effect.Effect<ReadonlyArray<VoiceTranscript>, unknown> =>
  Effect.gen(function* () {
    const audio = yield* connection.blobs.offer(Stream.fromIterable(chunks));

    return yield* Stream.runCollect(connection.client["voice.transcribe"]({ audio }));
  });

test("an Extension with the voice Grant streams audio and gets snapshots, ending finished", async () => {
  const snapshots = await run(({ desktop, extension }) =>
    Effect.gen(function* () {
      const settings = yield* desktop.client["voice.setKey"]({
        provider: "deepgram",
        key: Redacted.make(` ${KEY}\n`),
      });

      expect(settings).toEqual(
        new VoiceSettings({ provider: "deepgram", keySet: true, store: "file" })
      );
      const glasses = yield* extension(["voice"]);

      return yield* transcribe(glasses, [pcm(3200), pcm(3200), pcm(1600)]);
    })
  );

  expect(snapshots.map((s) => [s.finalText, s.interimText, s.finished])).toEqual([
    ["", "3200 bytes", false],
    ["", "6400 bytes", false],
    ["", "8000 bytes", false],
    ["8000 bytes for 0123", "", false],
    ["8000 bytes for 0123", "", true],
  ]);
});

test("oversized audio fails before the provider receives the excess and releases its slot", async () => {
  const result = await run(
    ({ desktop, extension }) =>
      Effect.gen(function* () {
        yield* desktop.client["voice.setKey"]({ provider: "deepgram", key: Redacted.make(KEY) });
        const glasses = yield* extension(["voice"]);
        const oversized = yield* Effect.exit(transcribe(glasses, [pcm(6), pcm(4)]));
        const next = yield* transcribe(glasses, [pcm(8)]);

        return { oversized, next: next.at(-1) };
      }),
    1,
    countingProvider,
    { maxAudioBytes: 8, maxDurationMs: 1000 }
  );

  expect(result.oversized).toEqual(
    Exit.fail(new VoiceError({ reason: "audio-failed", message: "Voice audio exceeds 8 bytes" }))
  );
  expect(result.next?.finalText).toBe("8 bytes for 0123");
  expect(result.next?.finished).toBe(true);
});

test("a stalled transcription reaches its deadline and releases its slot", async () => {
  const result = await run(
    ({ desktop, extension }) =>
      Effect.gen(function* () {
        yield* desktop.client["voice.setKey"]({ provider: "deepgram", key: Redacted.make(KEY) });
        const glasses = yield* extension(["voice"]);
        const audio = yield* glasses.blobs.offer(Stream.never);

        const expired = yield* Effect.exit(
          Stream.runCollect(glasses.client["voice.transcribe"]({ audio }))
        );

        const next = yield* transcribe(glasses, [pcm(2)]);

        return { expired, next: next.at(-1) };
      }),
    1,
    countingProvider,
    { maxAudioBytes: 8, maxDurationMs: 50 }
  );

  expect(result.expired).toEqual(
    Exit.fail(
      new VoiceError({
        reason: "audio-failed",
        message: "Voice transcription exceeded its time limit",
      })
    )
  );
  expect(result.next?.finished).toBe(true);
});

test("disconnecting an Extension closes its Deepgram socket and releases the Host's slot", async () => {
  const opened = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();

  const providerServer = Bun.serve({
    port: 0,
    fetch: (request, server) =>
      server.upgrade(request) ? undefined : new Response("upgrade", { status: 400 }),
    websocket: {
      open: () => opened.resolve(),
      message: () => {},
      close: () => closed.resolve(),
    },
  });

  try {
    const outcome = await run(
      ({ desktop, extension }) =>
        Effect.gen(function* () {
          yield* desktop.client["voice.setKey"]({ provider: "deepgram", key: Redacted.make(KEY) });
          const scope = yield* Scope.make();
          const glasses = yield* extension(["voice"]).pipe(Scope.provide(scope));
          const audio = yield* glasses.blobs.offer(Stream.never);
          yield* Stream.runDrain(glasses.client["voice.transcribe"]({ audio })).pipe(
            Effect.forkScoped
          );
          yield* Effect.promise(() => opened.promise);
          yield* Scope.close(scope, Exit.void);
          yield* Effect.promise(() => closed.promise);
          // The slot and provider release in the same handler scope.
          yield* Effect.sleep("20 millis");
          const reader = yield* extension(["voice"]);
          const nextAudio = yield* reader.blobs.offer(Stream.fail("aborted"));

          return yield* Effect.exit(
            Stream.runCollect(reader.client["voice.transcribe"]({ audio: nextAudio }))
          );
        }),
      1,
      deepgramProvider({ url: `ws://localhost:${providerServer.port}` })
    );

    expect(Exit.isFailure(outcome) && JSON.stringify(outcome)).toContain('"reason":"audio-failed"');
  } finally {
    await providerServer.stop(true);
  }
});

test("without the voice Grant transcribing is refused, and Extensions never touch the key", async () => {
  const outcomes = await run(({ desktop, extension }) =>
    Effect.gen(function* () {
      yield* desktop.client["voice.setKey"]({ provider: "deepgram", key: Redacted.make(KEY) });
      const reader = yield* extension(["read", "turn"]);
      const glasses = yield* extension(["voice"]);

      return {
        transcribe: yield* Effect.exit(transcribe(reader, [pcm(10)])),
        setKey: yield* Effect.exit(
          glasses.client["voice.setKey"]({ provider: "deepgram", key: null })
        ),
        settings: yield* Effect.exit(glasses.client["voice.settings"]()),
      };
    })
  );

  expect(outcomes.transcribe).toEqual(
    Exit.fail(new NotGranted({ what: "voice.transcribe", needed: "voice" }))
  );
  expect(outcomes.setKey).toEqual(
    Exit.fail(new NotGranted({ what: "voice.setKey", needed: null }))
  );
  expect(outcomes.settings).toEqual(
    Exit.fail(new NotGranted({ what: "voice.settings", needed: null }))
  );
});

test("with no key set, transcribing fails saying how to set one", async () => {
  const outcome = await run(({ extension }) =>
    Effect.gen(function* () {
      const glasses = yield* extension(["voice"]);

      return yield* Effect.exit(transcribe(glasses, [pcm(10)]));
    })
  );

  expect(outcome).toEqual(Exit.fail(new VoiceError({ reason: "no-key", message: NO_KEY_MESSAGE })));
});

test("settings say whether a key is set, never the key; a malformed key is refused unrepeated", async () => {
  const result = await run(({ desktop }) =>
    Effect.gen(function* () {
      const before = yield* desktop.client["voice.settings"]();

      const bad = yield* Effect.exit(
        desktop.client["voice.setKey"]({ provider: "deepgram", key: Redacted.make("Token sk-x y") })
      );

      yield* desktop.client["voice.setKey"]({ provider: "deepgram", key: Redacted.make(KEY) });
      const set = yield* desktop.client["voice.settings"]();
      const cleared = yield* desktop.client["voice.setKey"]({ provider: "deepgram", key: null });

      return { before, bad, set, cleared };
    })
  );

  expect([result.before.keySet, result.set.keySet, result.cleared.keySet]).toEqual([
    false,
    true,
    false,
  ]);
  expect(JSON.stringify(result.set)).not.toContain(KEY);
  expect(Exit.isFailure(result.bad)).toBe(true);
  expect(JSON.stringify(result.bad)).toContain("invalid-key");
  expect(JSON.stringify(result.bad)).not.toContain("sk-x");
});

test("the Host runs a bounded number of transcriptions at once and frees a slot when one ends", async () => {
  const outcomes = await run(
    ({ desktop, extension }) =>
      Effect.gen(function* () {
        yield* desktop.client["voice.setKey"]({ provider: "deepgram", key: Redacted.make(KEY) });
        const glasses = yield* extension(["voice"]);
        const endless = yield* glasses.blobs.offer(Stream.never);

        const first = yield* glasses.client["voice.transcribe"]({ audio: endless }).pipe(
          Stream.runDrain,
          Effect.forkScoped
        );

        yield* Effect.sleep("100 millis");
        const second = yield* Effect.exit(transcribe(glasses, [pcm(10)]));
        yield* Fiber.interrupt(first);
        yield* Effect.sleep("100 millis");
        const third = yield* transcribe(glasses, [pcm(10)]);

        return { second, third: third.at(-1) };
      }),
    1
  );

  expect(outcomes.second).toEqual(
    Exit.fail(
      new VoiceError({
        reason: "busy",
        message: "This Host runs at most 1 transcription at once; end one first.",
      })
    )
  );
  expect(outcomes.third?.finished).toBe(true);
});

test("a busy Host refuses a transcription before reading secure storage", async () => {
  const reading = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  const memory = memorySecrets();

  await Effect.runPromise(memory.set("voice/deepgram", Redacted.make(KEY)));

  const secrets = HostSecrets.of({
    ...memory,
    get: (key) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(reading, undefined);
        yield* Deferred.await(release);

        return yield* memory.get(key);
      }),
  });

  const outcome = await run(
    ({ extension }) =>
      Effect.gen(function* () {
        const glasses = yield* extension(["voice"]);
        const first = yield* transcribe(glasses, [pcm(2)]).pipe(Effect.forkScoped);
        yield* Deferred.await(reading);

        const second = yield* transcribe(glasses, [pcm(2)]).pipe(
          Effect.timeoutOrElse({
            duration: "100 millis",
            orElse: () => Effect.fail("read storage before admission"),
          }),
          Effect.exit
        );

        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);

        return second;
      }),
    1,
    countingProvider,
    undefined,
    secrets
  );

  expect(outcome).toEqual(
    Exit.fail(
      new VoiceError({
        reason: "busy",
        message: "This Host runs at most 1 transcription at once; end one first.",
      })
    )
  );
});
