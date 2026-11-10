/**
 * The speech-to-text provider behind `voice.transcribe` (ADR 0077): audio in,
 * the provider's interim and final results out. Deepgram is the first
 * (`deepgram.ts`); tests use a fake one at this boundary.
 */
import { VoiceError, type VoiceProviderKind, VoiceTranscript } from "@polaris/protocol";
import { Context, type Redacted, Stream } from "effect";

/** One result: `text` replaces the interim guess, or is final and will not change. */
export interface ProviderResult {
  readonly text: string;
  readonly isFinal: boolean;
}

export class VoiceProvider extends Context.Service<
  VoiceProvider,
  {
    readonly kind: VoiceProviderKind;
    /** Ends after the provider's last result once `audio` ends; ending it early stops the provider. */
    readonly transcribe: (
      key: Redacted.Redacted<string>,
      audio: Stream.Stream<Uint8Array, VoiceError>
    ) => Stream.Stream<ProviderResult, VoiceError>;
  }
>()("polaris/daemon/voice/VoiceProvider") {}

interface Heard {
  readonly final: ReadonlyArray<string>;
  readonly interim: string;
}

const joined = (parts: ReadonlyArray<string>) =>
  parts.flatMap((part) => (part.trim() === "" ? [] : [part.trim()])).join(" ");

const snapshot = (heard: Heard, finished: boolean) =>
  new VoiceTranscript({
    finalText: joined(heard.final),
    interimText: heard.interim.trim(),
    finished,
  });

/**
 * Folds results into snapshots, one per result, then a `finished` one. A guess
 * still pending when the provider ends is kept as final text; a provider failure
 * ends the stream with no `finished` snapshot.
 */
export const snapshots = <E>(
  results: Stream.Stream<ProviderResult, E>
): Stream.Stream<VoiceTranscript, E> =>
  results.pipe(
    Stream.map((result): ProviderResult | null => result),
    // The end marker follows only a clean end: concat never runs it after a failure.
    Stream.concat(Stream.make(null)),
    Stream.mapAccum(
      (): Heard => ({ final: [], interim: "" }),
      (heard, result) => {
        if (result === null)
          return [
            heard,
            [snapshot({ final: [...heard.final, heard.interim], interim: "" }, true)],
          ] as const;

        const next = result.isFinal
          ? { final: [...heard.final, result.text], interim: "" }
          : { final: heard.final, interim: result.text };

        return [next, [snapshot(next, false)]] as const;
      }
    )
  );

export const providerFailed = (message: string) =>
  new VoiceError({ reason: "provider-failed", message });
