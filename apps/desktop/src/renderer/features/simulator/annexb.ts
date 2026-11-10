/**
 * serve-emu's video, one H.264 Annex B access unit per binary message, behind a 16-byte header
 * with `frame-meta=1`: `"SEMU"`, version 1, flags (bit 0 keyframe), 2 zero bytes, u64 BE pts µs.
 * Keyframes carry SPS and PPS ahead of the IDR.
 */

const MAGIC = 0x53454d55;

const HEADER = 16;

export interface AccessUnit {
  readonly keyframe: boolean;
  readonly timestampUs: number;
  readonly data: Uint8Array;
}

/** A message's access unit, or null when its header isn't serve-emu's v1. */
export const readAccessUnit = (message: Uint8Array): AccessUnit | null => {
  if (message.length <= HEADER) return null;
  const view = new DataView(message.buffer, message.byteOffset, HEADER);

  if (view.getUint32(0) !== MAGIC || message[4] !== 1) return null;

  return {
    keyframe: (message[5]! & 1) === 1,
    timestampUs: Number(view.getBigUint64(8)),
    data: message.subarray(HEADER),
  };
};

/** The NAL units of an Annex B access unit, start codes removed. */
export const nalUnits = (data: Uint8Array): ReadonlyArray<Uint8Array> => {
  const starts: Array<{ at: number; code: number }> = [];

  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] !== 0 || data[i + 1] !== 0) continue;

    if (data[i + 2] === 1) starts.push({ at: i, code: 3 });
    else if (data[i + 2] === 0 && data[i + 3] === 1) starts.push({ at: i, code: 4 });
    else continue;
    i += starts.at(-1)!.code - 1;
  }

  return starts.map(({ at, code }, index) =>
    data.subarray(at + code, starts[index + 1]?.at ?? data.length)
  );
};

const hex = (byte: number) => byte.toString(16).padStart(2, "0");

/** The WebCodecs codec string from the access unit's SPS (NAL type 7), or null without one. */
export const codecOfAnnexB = (data: Uint8Array): string | null => {
  const sps = nalUnits(data).find((nal) => (nal[0]! & 0x1f) === 7 && nal.length >= 4);

  return sps === undefined ? null : `avc1.${hex(sps[1]!)}${hex(sps[2]!)}${hex(sps[3]!)}`;
};
