import { expect, test } from "bun:test";
import { Option } from "effect";
import { frameRecord, idleRecord } from "./capture.testing.ts";
import { CaptureRecord, recordParser } from "./records.ts";

const facts = { window: 4242, width: 640, height: 417, capturedAt: 1_794_000_000_000 };

/** A JPEG-like payload holding newlines and braces, which must never be read as a header. */
const jpeg = new Uint8Array([0xff, 0xd8, 0x0a, 0x7b, 0x0a, 0x7d, 0x0a, 0xff, 0xd9]);

const stream = () => {
  const idle = idleRecord("screen-locked");
  const frame = frameRecord(facts, jpeg);
  const all = new Uint8Array(frame.length * 2 + idle.length);
  all.set(frame);
  all.set(idle, frame.length);
  all.set(frame, frame.length + idle.length);

  return all;
};

const parse = (bytes: Uint8Array, chunk: number) => {
  const parser = recordParser();
  const records: Array<CaptureRecord> = [];

  for (let at = 0; at < bytes.length; at += chunk) {
    const parsed = parser.push(bytes.subarray(at, at + chunk));

    if (Option.isNone(parsed)) return null;
    records.push(...parsed.value);
  }

  return records;
};

test.each([1, 7, 64, 10_000])(
  "records come out whole whatever the chunking (%d bytes)",
  (chunk) => {
    expect(parse(stream(), chunk)).toEqual([
      CaptureRecord.Frame({ ...facts, jpeg }),
      CaptureRecord.Idle({ reason: "screen-locked" }),
      CaptureRecord.Frame({ ...facts, jpeg }),
    ]);
  }
);

test("a frame's bytes are its own, not a view of the next chunk's buffer", () => {
  const parser = recordParser();
  const bytes = frameRecord(facts, jpeg);
  const first = Option.getOrThrow(parser.push(bytes))[0];
  bytes.fill(0);

  expect(first).toMatchObject({ jpeg });
});

test.each([
  ["a line that is no header", "hello\n"],
  [
    "a frame over the size a preview image may have",
    `{"frame":{"window":1,"width":1,"height":1,"capturedAt":1,"bytes":${600 * 1024}}}\n`,
  ],
  ["an idle reason the protocol doesn't have", '{"idle":"asleep"}\n'],
  ["a header that never ends", "x".repeat(2000)],
])("%s stops the stream, for good", (_, text) => {
  const parser = recordParser();

  expect(Option.isNone(parser.push(new TextEncoder().encode(text)))).toBe(true);
  expect(Option.isNone(parser.push(idleRecord("no-window")))).toBe(true);
});
