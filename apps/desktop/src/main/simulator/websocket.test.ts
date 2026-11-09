import { describe, expect, test } from "bun:test";
import { acceptFor, encodeFrame, frameDecoder, OPCODE } from "./websocket.ts";

/** A server frame: unmasked, as the hub sends them. */
const serverFrame = (opcode: number, payload: Uint8Array | string, fin = true) => {
  const data = Buffer.from(payload);
  const extended = data.length < 126 ? 0 : 2;
  const frame = new Uint8Array(2 + extended + data.length);

  frame[0] = (fin ? 0x80 : 0) | opcode;
  frame[1] = extended === 0 ? data.length : 126;

  if (extended === 2) new DataView(frame.buffer).setUint16(2, data.length);
  frame.set(data, 2 + extended);

  return frame;
};

const feedBytewise = (bytes: Uint8Array) => {
  const decode = frameDecoder();

  return [...bytes].flatMap((byte) => decode(Uint8Array.of(byte)));
};

describe("frameDecoder", () => {
  test("joins a fragmented message split at every byte, passing a ping through between", () => {
    const stream = Buffer.concat([
      serverFrame(OPCODE.text, "hel", false),
      serverFrame(OPCODE.ping, "p"),
      serverFrame(OPCODE.continuation, "lo"),
      serverFrame(OPCODE.binary, new Uint8Array(300).fill(7)),
    ]);

    expect(feedBytewise(stream)).toEqual([
      { kind: "ping", data: Uint8Array.from(Buffer.from("p")) },
      { kind: "text", text: "hello" },
      { kind: "binary", data: new Uint8Array(300).fill(7) },
    ]);
  });

  test("a close carries its code and reason", () => {
    const payload = Buffer.concat([Buffer.from([0x03, 0xf5]), Buffer.from("try again")]);

    expect(frameDecoder()(serverFrame(OPCODE.close, payload))).toEqual([
      { kind: "close", code: 1013, reason: "try again" },
    ]);
  });

  test.each([
    ["a continuation without a start", serverFrame(OPCODE.continuation, "x")],
    ["a masked server frame", encodeFrame(OPCODE.text, Buffer.from("x"))],
  ])("%s is invalid", (_, bytes) => {
    expect(frameDecoder()(bytes).at(-1)?.kind).toBe("invalid");
  });
});

describe("encodeFrame", () => {
  test("masks a 16-bit length payload so the server can unmask it", () => {
    const payload = new Uint8Array(200).map((_, i) => i);
    const mask = Uint8Array.of(1, 2, 3, 4);
    const frame = encodeFrame(OPCODE.binary, payload, mask);
    const view = new DataView(frame.buffer);
    const body = frame.subarray(8).map((byte, i) => byte ^ mask[i % 4]!);

    expect([frame[0], frame[1], view.getUint16(2)]).toEqual([0x82, 0x80 | 126, 200]);
    expect(body).toEqual(payload);
  });
});

test("the accept key is RFC 6455's example", () => {
  expect(acceptFor("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});
