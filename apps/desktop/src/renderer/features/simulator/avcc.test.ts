import { describe, expect, test } from "bun:test";
import { avccDemuxer, codecOfAvcc } from "./avcc.ts";

const chunk = (tag: number, payload: ReadonlyArray<number>) => {
  const out = new Uint8Array(5 + payload.length);

  new DataView(out.buffer).setUint32(0, payload.length + 1);
  out[4] = tag;
  out.set(payload, 5);

  return out;
};

const join = (...parts: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;

  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }

  return out;
};

const tags = (read: ReturnType<ReturnType<typeof avccDemuxer>["push"]>) =>
  read.kind === "chunks" ? read.chunks.map((c) => [c.tag, [...c.payload]]) : read.kind;

/** As the hub sent it on connect (spike, 2026-11-09): seed, description, keyframe, deltas. */
const stream = join(
  chunk(4, [0xff, 0xd8, 0xff, 0xd9]),
  chunk(1, [1, 0x64, 0x00, 0x33]),
  chunk(2, [0, 0, 0, 1, 0x65]),
  chunk(3, [0, 0, 0, 1, 0x41]),
  chunk(3, [])
);

describe("avccDemuxer", () => {
  test("reads the chunks of one push in order, including an empty payload", () => {
    expect(tags(avccDemuxer().push(stream))).toEqual([
      [4, [0xff, 0xd8, 0xff, 0xd9]],
      [1, [1, 0x64, 0x00, 0x33]],
      [2, [0, 0, 0, 1, 0x65]],
      [3, [0, 0, 0, 1, 0x41]],
      [3, []],
    ]);
  });

  test.each([1, 2, 3, 4, 5, 7])("gives the same chunks when bytes arrive %i at a time", (size) => {
    const demuxer = avccDemuxer();
    const seen: Array<unknown> = [];

    for (let at = 0; at < stream.length; at += size) {
      const read = demuxer.push(stream.subarray(at, at + size));

      if (read.kind === "chunks") seen.push(...read.chunks.map((c) => [c.tag, [...c.payload]]));
    }

    expect<unknown>(seen).toEqual(tags(avccDemuxer().push(stream)));
  });

  test("holds a chunk until its last byte arrives", () => {
    const demuxer = avccDemuxer();
    const whole = chunk(3, [9, 8, 7]);

    expect(tags(demuxer.push(whole.subarray(0, whole.length - 1)))).toEqual([]);
    expect(tags(demuxer.push(whole.subarray(whole.length - 1)))).toEqual([[3, [9, 8, 7]]]);
  });

  test("a payload stays intact after later pushes reuse the buffer", () => {
    const demuxer = avccDemuxer();
    const bytes = join(chunk(2, [1, 2, 3]), chunk(3, [4]).subarray(0, 2));
    const read = demuxer.push(bytes);

    bytes.fill(0);
    demuxer.push(chunk(3, [5, 5, 5, 5]));
    expect(tags(read)).toEqual([[2, [1, 2, 3]]]);
  });

  test("a zero length is a broken stream", () => {
    expect(avccDemuxer().push(new Uint8Array([0, 0, 0, 0, 3])).kind).toBe("invalid");
  });

  test("a length beyond any frame is a broken stream, without waiting for its bytes", () => {
    expect(avccDemuxer().push(new Uint8Array([0x7f, 0xff, 0xff, 0xff, 3])).kind).toBe("invalid");
  });
});

describe("codecOfAvcc", () => {
  test("names the profile, constraints and level of the hub's avcC (High 5.1)", () => {
    const description = Uint8Array.from(
      Buffer.from("01640033ffe1001127640033ac56804c0149e6a806d044235001000428ee3cb0", "hex")
    );

    expect(codecOfAvcc(description)).toBe("avc1.640033");
  });

  test("refuses a record that isn't avcC version 1", () => {
    expect(codecOfAvcc(new Uint8Array([0, 0x64, 0, 0x33]))).toBeNull();
    expect(codecOfAvcc(new Uint8Array([1, 0x64]))).toBeNull();
  });
});
