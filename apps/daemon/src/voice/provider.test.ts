import { expect, test } from "bun:test";
import { VoiceTranscript } from "@polaris/protocol";
import { Effect, Exit, Stream } from "effect";
import { providerFailed, snapshots } from "./provider.ts";

const fold = (stream: Parameters<typeof snapshots>[0]) =>
  Effect.runPromiseExit(Stream.runCollect(snapshots(stream)));

test("finals accumulate, a guess is replaced, and one still pending at the end is kept", async () => {
  const exit = await fold(
    Stream.make(
      { text: "hey", isFinal: false },
      { text: "Hey Polaris,", isFinal: true },
      { text: "run the", isFinal: false },
      { text: "run the tests", isFinal: false }
    )
  );

  expect(exit).toEqual(
    Exit.succeed([
      new VoiceTranscript({ finalText: "", interimText: "hey", finished: false }),
      new VoiceTranscript({ finalText: "Hey Polaris,", interimText: "", finished: false }),
      new VoiceTranscript({ finalText: "Hey Polaris,", interimText: "run the", finished: false }),
      new VoiceTranscript({
        finalText: "Hey Polaris,",
        interimText: "run the tests",
        finished: false,
      }),
      new VoiceTranscript({
        finalText: "Hey Polaris, run the tests",
        interimText: "",
        finished: true,
      }),
    ])
  );
});

test("a provider failure fails the stream without a finished snapshot", async () => {
  const seen: VoiceTranscript[] = [];

  const exit = await Effect.runPromiseExit(
    Stream.runForEach(
      snapshots(
        Stream.concat(
          Stream.make({ text: "hey", isFinal: false }),
          Stream.fail(providerFailed("gone"))
        )
      ),
      (transcript) => Effect.sync(() => seen.push(transcript))
    )
  );

  expect(exit).toEqual(Exit.fail(providerFailed("gone")));
  expect(seen).toEqual([
    new VoiceTranscript({ finalText: "", interimText: "hey", finished: false }),
  ]);
});
