/**
 * The Deepgram client against a local fake of its streaming API, and, with
 * `POLARIS_DEEPGRAM_SMOKE_KEY` set on macOS, against the real one with audio
 * from `say`.
 */
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VoiceError } from "@polaris/protocol";
import { Effect, Exit, Fiber, Predicate, Redacted, Stream } from "effect";
import { deepgramProvider } from "./deepgram.ts";
import { snapshots } from "./provider.ts";
import { newTempDir, removeTempDir } from "../platform/tempDir.testing.ts";

const KEY = Redacted.make("0123456789abcdef0123456789abcdef01234567");

interface Seen {
  readonly url: URL;
  readonly authorization: string | null;
  readonly audio: Array<number>;
  readonly text: Array<string>;
}

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  void server?.stop(true);
  server = undefined;
});

const results = (transcript: string, isFinal: boolean) =>
  JSON.stringify({
    type: "Results",
    is_final: isFinal,
    speech_final: isFinal,
    channel: { alternatives: [{ transcript, confidence: 0.9 }] },
  });

/** Answers each audio frame with an interim result and `CloseStream` with a final one. */
const fakeDeepgram = (
  options: {
    readonly status?: number;
    readonly error?: string;
    readonly hang?: boolean;
    readonly closeEarly?: boolean;
    readonly flood?: number;
  } = {}
) => {
  const seen: Seen = { url: new URL("ws://x"), authorization: null, audio: [], text: [] };
  const opened = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();

  server = Bun.serve({
    port: 0,
    fetch: (request, srv) => {
      seen.url.href = request.url;
      Object.assign(seen, { authorization: request.headers.get("authorization") });

      if (options.status !== undefined) return new Response("no", { status: options.status });

      return srv.upgrade(request, { data: undefined })
        ? undefined
        : new Response("upgrade", { status: 400 });
    },
    websocket: {
      open: (ws) => {
        opened.resolve();

        if (options.closeEarly) ws.close(1000);

        for (let i = 0; i < (options.flood ?? 0); i++) ws.send(results("word", true));

        if (options.error !== undefined)
          ws.send(JSON.stringify({ type: "Error", description: options.error }));
      },
      close: () => closed.resolve(),
      message: (ws, message) => {
        if (Predicate.isString(message)) {
          seen.text.push(message);

          if (message.includes("CloseStream") && !options.hang) {
            ws.send(results("hello there", true));
            ws.send(JSON.stringify({ type: "Metadata", request_id: "r" }));
            ws.close(1000);
          }

          return;
        }

        seen.audio.push(message.byteLength);
        ws.send(results(`heard ${seen.audio.length}`, false));
      },
    },
  });

  return {
    seen,
    opened: opened.promise,
    closed: closed.promise,
    url: `ws://localhost:${server.port}/v1/listen`,
  };
};

const pcm = (bytes: number) => new Uint8Array(bytes);

test("streams linear16 with the key in the header, then CloseStream, and folds the results", async () => {
  const { seen, url } = fakeDeepgram();
  const provider = deepgramProvider({ url });

  const exit = await Effect.runPromiseExit(
    Stream.runCollect(snapshots(provider.transcribe(KEY, Stream.make(pcm(3200), pcm(3200)))))
  );

  expect(Exit.isSuccess(exit) ? exit.value.at(-1) : exit).toMatchObject({
    finalText: "hello there",
    finished: true,
  });
  expect(seen.authorization).toBe(`Token ${Redacted.value(KEY)}`);
  expect(Object.fromEntries(seen.url.searchParams)).toMatchObject({
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
    interim_results: "true",
  });
  expect(seen.audio).toEqual([3200, 3200]);
  expect(seen.text).toEqual([JSON.stringify({ type: "CloseStream" })]);
});

test("a refused key fails with key-rejected, other refusals with provider-failed", async () => {
  const rejected = fakeDeepgram({ status: 401 });

  const exit = await Effect.runPromiseExit(
    Stream.runCollect(deepgramProvider({ url: rejected.url }).transcribe(KEY, Stream.make(pcm(2))))
  );

  expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain('"reason":"key-rejected"');
  void server?.stop(true);

  const broken = fakeDeepgram({ status: 503 });

  const other = await Effect.runPromiseExit(
    Stream.runCollect(deepgramProvider({ url: broken.url }).transcribe(KEY, Stream.make(pcm(2))))
  );

  expect(other).toEqual(
    Exit.fail(
      new VoiceError({
        reason: "provider-failed",
        message: "Deepgram refused the connection (HTTP 503)",
      })
    )
  );
});

test("a failing audio stream fails the transcription", async () => {
  const { url } = fakeDeepgram();
  const broken = new VoiceError({ reason: "audio-failed", message: "the blob timed out" });

  const exit = await Effect.runPromiseExit(
    Stream.runCollect(
      deepgramProvider({ url }).transcribe(
        KEY,
        Stream.concat(Stream.make(pcm(2)), Stream.fail(broken))
      )
    )
  );

  expect(exit).toEqual(Exit.fail(broken));
});

test("a provider that never finalizes is timed out and its socket closed", async () => {
  const { url, closed } = fakeDeepgram({ hang: true });

  const exit = await Effect.runPromiseExit(
    Stream.runCollect(
      deepgramProvider({ url, finishTimeoutMs: 30 }).transcribe(KEY, Stream.make(pcm(2)))
    )
  );

  expect(exit).toEqual(
    Exit.fail(
      new VoiceError({
        reason: "provider-failed",
        message: "Deepgram did not finish the transcript in time",
      })
    )
  );
  await closed;
});

test("a provider handshake that stalls is timed out and closed", async () => {
  const accepted = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();

  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data: () => accepted.resolve(), close: () => closed.resolve() },
  });

  try {
    const exit = await Effect.runPromiseExit(
      Stream.runCollect(
        deepgramProvider({
          url: `ws://127.0.0.1:${listener.port}`,
          connectTimeoutMs: 50,
        }).transcribe(KEY, Stream.never)
      )
    );

    await accepted.promise;
    expect(exit).toEqual(
      Exit.fail(
        new VoiceError({
          reason: "provider-failed",
          message: "Deepgram did not open the connection in time",
        })
      )
    );
    await closed.promise;
  } finally {
    listener.stop(true);
  }
});

test("provider errors never repeat a key from the provider's description", async () => {
  const { url, closed } = fakeDeepgram({ error: `invalid credential ${Redacted.value(KEY)}` });

  const exit = await Effect.runPromiseExit(
    Stream.runCollect(deepgramProvider({ url }).transcribe(KEY, Stream.never))
  );

  expect(exit).toEqual(
    Exit.fail(
      new VoiceError({
        reason: "provider-failed",
        message: "Deepgram failed to transcribe the audio",
      })
    )
  );
  expect(JSON.stringify(exit)).not.toContain(Redacted.value(KEY));
  await closed;
});

test("a normal provider close before audio ends fails instead of reporting a finished transcript", async () => {
  const { url } = fakeDeepgram({ closeEarly: true });

  const exit = await Effect.runPromiseExit(
    Stream.runCollect(snapshots(deepgramProvider({ url }).transcribe(KEY, Stream.never)))
  );

  expect(Exit.isFailure(exit) && JSON.stringify(exit)).toContain('"reason":"provider-failed"');
});

test("a slow transcript consumer has a bounded provider result buffer", async () => {
  const { url } = fakeDeepgram({ flood: 1000 });

  const exit = await Effect.runPromiseExit(
    deepgramProvider({ url })
      .transcribe(KEY, Stream.never)
      .pipe(
        Stream.tap(() => Effect.sleep("10 millis")),
        Stream.runDrain
      )
  );

  expect(Exit.isFailure(exit) && JSON.stringify(exit)).toContain("transcript buffer");
});

test("cancelling a transcription closes the provider socket and stops reading audio", async () => {
  const { url, opened, closed } = fakeDeepgram({ hang: true });
  let stopped = false;

  const audio = Stream.never.pipe(
    Stream.ensuring(
      Effect.sync(() => {
        stopped = true;
      })
    )
  );

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fiber = yield* Stream.runDrain(deepgramProvider({ url }).transcribe(KEY, audio)).pipe(
          Effect.forkScoped
        );

        yield* Effect.promise(() => opened);
        yield* Effect.sleep("20 millis");
        yield* Fiber.interrupt(fiber);
        yield* Effect.promise(() => closed);
      })
    )
  );

  expect(stopped).toBe(true);
});

const smokeKey = process.env.POLARIS_DEEPGRAM_SMOKE_KEY;

test.skipIf(smokeKey === undefined || process.platform !== "darwin")(
  "real Deepgram transcribes speech from say",
  async () => {
    const dir = newTempDir("pl-dg-");

    try {
      const wav = join(dir, "speech.wav");

      const said = Bun.spawnSync([
        "/usr/bin/say",
        "-o",
        wav,
        "--data-format=LEI16@16000",
        "Polaris, run the tests.",
      ]);

      expect(said.exitCode).toBe(0);
      // The WAV header is 44 bytes or more; Deepgram ignores a few stray samples.
      const audio = readFileSync(wav).subarray(44);

      const chunks = Array.from({ length: Math.ceil(audio.length / 3200) }, (_, i) =>
        audio.subarray(i * 3200, (i + 1) * 3200)
      );

      const exit = await Effect.runPromiseExit(
        Stream.runCollect(
          snapshots(
            deepgramProvider().transcribe(
              Redacted.make(smokeKey ?? ""),
              Stream.fromIterable(chunks)
            )
          )
        )
      );

      expect(Exit.isSuccess(exit) ? exit.value.at(-1)?.finalText.toLowerCase() : exit).toContain(
        "tests"
      );
    } finally {
      removeTempDir(dir);
    }
  },
  30_000
);
