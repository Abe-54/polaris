import { expect, test } from "bun:test";
import {
  CdpFramingError,
  CdpMessageDecoder,
  encodeCdpMessage,
  parseCdpMessage,
} from "./cdpFraming.ts";

const pretty =
  '{\n  "id": 1,\n  "method": "Page.navigate",\n  "params": {\n    "url": "http://localhost:3000/"\n  }\n}';

test("a pretty-printed CDP message is compacted before it is delimited, so it stays one message", () => {
  const parsed = parseCdpMessage(pretty);
  expect(parsed).not.toBeNull();
  const bytes = encodeCdpMessage(parsed ?? {});
  expect(bytes.filter((byte) => byte === 0x0a)).toHaveLength(1);

  const decoder = new CdpMessageDecoder();
  const messages = [...decoder.feed(bytes.subarray(0, 7)), ...decoder.feed(bytes.subarray(7))];
  expect(messages).toEqual([
    { id: 1, method: "Page.navigate", params: { url: "http://localhost:3000/" } },
  ]);
});

test("two messages in one chunk and one message across three chunks both decode whole", () => {
  const a = encodeCdpMessage({ id: 1, result: {} });
  const b = encodeCdpMessage({ method: "Page.loadEventFired", params: { timestamp: 2 } });
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a);
  joined.set(b, a.length);
  const decoder = new CdpMessageDecoder();
  expect(decoder.feed(joined)).toEqual([
    { id: 1, result: {} },
    { method: "Page.loadEventFired", params: { timestamp: 2 } },
  ]);
  expect(decoder.feed(b.subarray(0, 3))).toEqual([]);
  expect(decoder.feed(b.subarray(3, 20))).toEqual([]);
  expect(decoder.feed(b.subarray(20))).toEqual([
    { method: "Page.loadEventFired", params: { timestamp: 2 } },
  ]);
});

test("raw pretty-printed JSON on the stream is a framing error, not a silent split", () => {
  const decoder = new CdpMessageDecoder();
  expect(() => decoder.feed(new TextEncoder().encode(`${pretty}\n`))).toThrow(CdpFramingError);
});

test("JSON that is not a CDP message is refused at the boundary", () => {
  expect(parseCdpMessage('{"id":"x","method":5}')).toBeNull();
  expect(parseCdpMessage("[1,2]")).toBeNull();
  expect(parseCdpMessage('{"id":1,"error":{"code":"nope"}}')).toBeNull();
  expect(parseCdpMessage('{"id":1,"result":{"ok":true},"extra":1}')).toEqual({
    id: 1,
    result: { ok: true },
  });
});
