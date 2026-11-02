# Voice

`voice.transcribe` (ADR 0077, ENG-404): an Extension with the `voice` Grant streams 16 kHz s16le
mono PCM to the Daemon as a client-offered Wire blob (`{ audio: BlobId }`, taken with
`takeStream`, idle timeout on: a live microphone sends samples even in silence), and gets
`VoiceTranscript` snapshots `{ finalText, interimText, finished }` back. Ending the blob finishes
the stream with one `finished` snapshot; ending the RPC early stops the provider.

| File | What |
|---|---|
| `provider.ts` | `VoiceProvider` (audio in, interim and final results out) and `snapshots`, the fold into `VoiceTranscript`s. |
| `deepgram.ts` | Deepgram's streaming API: `wss://api.deepgram.com/v1/listen`, linear16 at 16000, the key as `Authorization: Token …`, `CloseStream` at the end, `KeepAlive` during pauses. A 401/403 handshake is `key-rejected`. |
| `keys.ts` | The provider's key in `HostSecrets` (`secrets/`, ADR 0079): read per transcription, checked when set, `no-key` with how to set one. |
| `VoiceRpcs.ts` | The handlers for `voice.transcribe`, `voice.settings` and `voice.setKey`; at most `MAX_TRANSCRIPTIONS` (4) at once per Host, then `busy`, since each is a provider connection billed to the key. |
| `limits.ts` | Audio byte bounds and the elapsed transcription deadline. |
| `socket.ts` | Bounded audio frames, WebSocket backpressure and KeepAlive. |
| `cli.ts` | `polaris voice key set|clear|status`; `set` reads the key from stdin, hidden on a terminal. |

`voice.settings` and `voice.setKey` are Client-only (`grants.ts`): Extensions never see or change
the key, and no response carries it. Provider errors use fixed messages rather than repeating
provider descriptions or headers.

## Limits and cleanup

Slots are acquired before reading secure storage. Each transcription accepts up to 9,600,000 bytes
of 16 kHz s16le mono PCM (five minutes) and lasts at most five minutes of elapsed time,
including provider connection and finalization. Either limit fails with `audio-failed` and
releases the provider and the Host's slot. The Wire's separate idle and aggregate incoming
blob limits still apply; the audio limit is enforced as the relay consumes the blob.

Deepgram connection and finalization each have a ten-second deadline. A close before all
audio has been sent fails even if its WebSocket code is 1000. Canceling the RPC, disconnecting
the Extension, or failing the audio closes the provider socket and stops its audio reader and
KeepAlive fiber. No voice timers run without an active transcription.

The audio reader splits chunks into at most 32,000-byte frames and waits while the provider
WebSocket's buffered output exceeds 64 KiB. Its ten-millisecond backpressure checks run only
while blocked. Up to 64 provider results can queue for a slow transcript consumer; overflow
fails the transcription rather than dropping final text or accumulating an unbounded queue.

## Tests

`voice.socket.slow.test.ts` runs the real server and Wire with a fake provider; `deepgram.test.ts`
runs the client against a local fake of Deepgram's API. `socket.test.ts` injects the WebSocket
send boundary to exercise backpressure deterministically. The real-Deepgram smoke runs on
macOS with a key (it speaks with `say`), and remains skipped without it:

```
POLARIS_DEEPGRAM_SMOKE_KEY=<key> bun test apps/daemon/src/voice/deepgram.test.ts
```
