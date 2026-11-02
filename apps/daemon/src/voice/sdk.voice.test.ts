/**
 * The SDK's `transcribe` against the real server and Wire (ENG-403): an
 * Extension's audio iterator reaches the voice relay as a blob, and the
 * provider's snapshots come back through the SDK's async iterator.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { connectRpc, socketTransport as clientSocket } from "@polaris/client";
import { createPolarisWith, encodePairing, socketTransport, type Transcript } from "@polaris/sdk";
import { Effect, Layer, Redacted, Stream } from "effect";
import { HostSecrets, memorySecrets } from "../secrets/index.ts";
import { startServer } from "../transport/server.ts";
import { VoiceProvider } from "./provider.ts";
import { makeVoiceRpcs } from "./VoiceRpcs.ts";
import { newTempDir, removeTempDir } from "../platform/tempDir.testing.ts";

const KEY = "0123456789abcdef0123456789abcdef01234567";

/** Says how many bytes it heard after each chunk, then the total as final text. */
const countingProvider = VoiceProvider.of({
  kind: "deepgram",
  transcribe: (_key, audio) =>
    Stream.unwrap(
      Effect.sync(() => {
        let heard = 0;

        return audio.pipe(
          Stream.map((chunk) => {
            heard += chunk.byteLength;

            return { text: `${heard} bytes`, isFinal: false };
          }),
          Stream.concat(Stream.sync(() => ({ text: `${heard} bytes`, isFinal: true })))
        );
      })
    ),
});

const identity = { clientName: "test", clientVersion: "0", deviceLabel: "Test", capabilities: [] };

async function* microphone() {
  for (const bytes of [3200, 3200, 1600]) yield new Uint8Array(bytes).fill(1);
}

const collect = async (feed: AsyncIterable<Transcript>) => {
  const seen: Array<Transcript> = [];

  for await (const transcript of feed) seen.push(transcript);

  return seen;
};

test("the SDK streams an audio iterator to the relay and yields its snapshots", async () => {
  const root = newTempDir("pl-sdk-voice-", { short: true });

  const snapshots = await Effect.runPromise(
    Effect.gen(function* () {
      const server = yield* startServer({
        root,
        socketPath: join(root, "d.sock"),
        lockPath: join(root, "d.lock"),
        handlers: makeVoiceRpcs().pipe(
          Layer.provide(
            Layer.merge(
              Layer.succeed(VoiceProvider)(countingProvider),
              Layer.succeed(HostSecrets)(memorySecrets())
            )
          )
        ),
      });

      const desktop = yield* connectRpc(yield* clientSocket(server.socketPath));
      const hello = yield* desktop.client.hello(identity);

      yield* desktop.client["voice.setKey"]({ provider: "deepgram", key: Redacted.make(KEY) });

      const { token } = yield* desktop.client["extensions.pair"]({
        name: "Glasses",
        grant: ["voice"],
      });

      const hostId = hello.host.hostId;

      const pairing = encodePairing({
        hostId,
        hostName: "Test",
        url: null,
        token,
        name: "Glasses",
      });

      return yield* Effect.promise(async () => {
        const polaris = await createPolarisWith(
          { pairings: [pairing], clientName: "glasses" },
          () => socketTransport(server.socketPath, hostId)
        );

        try {
          return await collect(polaris.transcribe(hostId, microphone()));
        } finally {
          await polaris.close();
        }
      });
    }).pipe(Effect.scoped, Effect.ensuring(Effect.sync(() => removeTempDir(root))))
  );

  expect(snapshots.map((s) => [s.finalText, s.interimText, s.finished])).toEqual([
    ["", "3200 bytes", false],
    ["", "6400 bytes", false],
    ["", "8000 bytes", false],
    ["8000 bytes", "", false],
    ["8000 bytes", "", true],
  ]);
});
