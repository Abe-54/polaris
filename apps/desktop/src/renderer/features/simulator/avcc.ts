/**
 * The hub's `stream.avcc` (serve-sim's StreamFormat): `[len: u32 BE][tag: u8][payload]`, where
 * `len` counts the tag. Bytes arrive in any split; the demuxer hands out whole chunks.
 */

export const AVCC_TAG = {
  /** The avcC record (SPS and PPS): configures the decoder; replayed to late joiners. */
  description: 0x01,
  /** An IDR frame, length-prefixed NALs. */
  keyframe: 0x02,
  delta: 0x03,
  /** A JPEG of the screen, sent first so a viewer paints before the first IDR decodes. */
  seed: 0x04,
} as const;

export interface AvccChunk {
  readonly tag: number;
  readonly payload: Uint8Array;
}

/** A chunk claiming more than this is a broken stream, not a frame. */
export const MAX_AVCC_CHUNK = 32 * 1024 * 1024;

export type AvccRead =
  | { readonly kind: "chunks"; readonly chunks: ReadonlyArray<AvccChunk> }
  | { readonly kind: "invalid" };

export interface AvccDemuxer {
  readonly push: (bytes: Uint8Array) => AvccRead;
}

export const avccDemuxer = (): AvccDemuxer => {
  let buffer: Uint8Array = new Uint8Array(0);
  let used = 0;

  const append = (bytes: Uint8Array) => {
    const left = buffer.length - used;

    if (left === 0) {
      buffer = bytes;
      used = 0;

      return;
    }

    const next = new Uint8Array(left + bytes.length);

    next.set(buffer.subarray(used));
    next.set(bytes, left);
    buffer = next;
    used = 0;
  };

  return {
    push: (bytes) => {
      append(bytes);
      const chunks: Array<AvccChunk> = [];

      while (buffer.length - used >= 5) {
        const view = new DataView(buffer.buffer, buffer.byteOffset + used, 4);
        const length = view.getUint32(0);

        if (length < 1 || length > MAX_AVCC_CHUNK) return { kind: "invalid" };

        if (buffer.length - used < 4 + length) break;
        // A copy, so the decoder may keep it after the buffer moves on.
        chunks.push({
          tag: buffer[used + 4]!,
          payload: buffer.slice(used + 5, used + 4 + length),
        });
        used += 4 + length;
      }

      return { kind: "chunks", chunks };
    },
  };
};

const hex = (byte: number) => byte.toString(16).padStart(2, "0");

/**
 * The WebCodecs codec string for an avcC record: `avc1.` then the profile, its compatibility
 * flags and the level (bytes 1–3), or null when the record is too short or not version 1.
 */
export const codecOfAvcc = (description: Uint8Array): string | null => {
  if (description.length < 4 || description[0] !== 1) return null;

  return `avc1.${hex(description[1]!)}${hex(description[2]!)}${hex(description[3]!)}`;
};
