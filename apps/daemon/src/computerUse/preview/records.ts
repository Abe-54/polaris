/**
 * What `polaris-capture` writes on stdout (`service/computerUse/capture`): a JSON line, then
 * for a frame its JPEG. Parsed here as the bytes arrive, whatever the chunking.
 */
import { PREVIEW_MAX_FRAME_BYTES, PreviewIdleReason } from "@polaris/protocol";
import { Data, Option, Schema } from "effect";

const Header = Schema.Union([
  Schema.Struct({
    frame: Schema.Struct({
      window: Schema.Int,
      width: Schema.Int,
      height: Schema.Int,
      /** Milliseconds since the epoch. */
      capturedAt: Schema.Number,
      bytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: PREVIEW_MAX_FRAME_BYTES })),
    }),
  }),
  Schema.Struct({ idle: PreviewIdleReason }),
]);

const decodeHeader = Schema.decodeUnknownOption(Schema.fromJsonString(Header));

export type CaptureRecord = Data.TaggedEnum<{
  Frame: {
    readonly window: number;
    readonly width: number;
    readonly height: number;
    readonly capturedAt: number;
    readonly jpeg: Uint8Array;
  };
  Idle: { readonly reason: PreviewIdleReason };
}>;

export const CaptureRecord = Data.taggedEnum<CaptureRecord>();

/** No header is near this long; a longer line means the stream is not the capture tool's. */
const MAX_HEADER_BYTES = 1024;

const NEWLINE = 0x0a;

const concat = (left: Uint8Array, right: Uint8Array) => {
  if (left.length === 0) return right;
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left);
  joined.set(right, left.length);

  return joined;
};

export interface RecordParser {
  /** The records `chunk` completes, in order; none when the stream stopped making sense. */
  readonly push: (chunk: Uint8Array) => Option.Option<ReadonlyArray<CaptureRecord>>;
}

export const recordParser = (): RecordParser => {
  let pending: Uint8Array = new Uint8Array(0);
  let broken = false;

  /** The next whole record and the bytes it took; `undefined` while more bytes are needed. */
  const next = (): Option.Option<readonly [CaptureRecord, number]> | undefined => {
    const end = pending.indexOf(NEWLINE);

    if (end < 0) return pending.length > MAX_HEADER_BYTES ? Option.none() : undefined;
    const header = decodeHeader(new TextDecoder().decode(pending.subarray(0, end)));

    if (Option.isNone(header)) return Option.none();

    if ("idle" in header.value)
      return Option.some([CaptureRecord.Idle({ reason: header.value.idle }), end + 1]);
    const { bytes, ...facts } = header.value.frame;
    const start = end + 1;

    if (pending.length < start + bytes) return undefined;
    // A copy: `pending` is dropped as soon as its records are taken.
    const jpeg = pending.slice(start, start + bytes);

    return Option.some([CaptureRecord.Frame({ ...facts, jpeg }), start + bytes]);
  };

  return {
    push: (chunk) => {
      if (broken) return Option.none();
      pending = concat(pending, chunk);
      const records: Array<CaptureRecord> = [];

      for (let step = next(); step !== undefined; step = next()) {
        if (Option.isNone(step)) {
          broken = true;

          return Option.none();
        }

        records.push(step.value[0]);
        pending = pending.subarray(step.value[1]);
      }

      return Option.some(records);
    },
  };
};
