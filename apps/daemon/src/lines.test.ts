import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { type FindNewline, lineSplitter, readLines } from "./lines.ts";

const encoder = new TextEncoder();

/** `bytes` cut at each of `cuts` (byte offsets, any order). */
const chunked = (bytes: Uint8Array, cuts: ReadonlyArray<number>): Array<Uint8Array> => {
  const at = [...new Set(cuts)].filter((c) => c > 0 && c < bytes.length).sort((a, b) => a - b);

  return [0, ...at].map((start, i) => bytes.subarray(start, at[i] ?? bytes.length));
};

const split = (chunks: ReadonlyArray<Uint8Array>) => {
  const splitter = lineSplitter();
  const lines = chunks.flatMap((chunk) => splitter.push(chunk));

  return { lines, rest: splitter.rest() };
};

/** What one string splits into: every "\n"-terminated line, and what follows the last "\n". */
const expected = (text: string) => {
  const parts = text.split("\n");

  return { lines: parts.slice(0, -1), rest: parts.at(-1) ?? "" };
};

const stream = (chunks: ReadonlyArray<Uint8Array>) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

const collect = async (source: AsyncIterable<string>) => {
  const out: Array<string> = [];

  for await (const line of source) out.push(line);

  return out;
};

const EDGES = "first\r\n\n  padded  \r\n\r\né😀 split\n\nlast, unterminated é";

describe("lineSplitter", () => {
  test("cutting the bytes at any one point gives the lines of one chunk", () => {
    const bytes = encoder.encode(EDGES);

    for (let cut = 0; cut <= bytes.length; cut += 1)
      expect(split(chunked(bytes, [cut]))).toEqual(expected(EDGES));
  });

  test("one byte per chunk splits multi-byte characters and CRLF and still decodes them", () => {
    const bytes = encoder.encode(EDGES);
    const cuts = Array.from(bytes, (_, i) => i);

    expect(split(chunked(bytes, cuts))).toEqual({
      lines: ["first\r", "", "  padded  \r", "\r", "é😀 split", ""],
      rest: "last, unterminated é",
    });
  });

  test("any text cut at any points gives the lines of one chunk", () => {
    const text = fc.string({
      unit: fc.constantFrom("a", " ", "\n", "\r", "é", "😀", " "),
      maxLength: 60,
    });

    fc.assert(
      fc.property(text, fc.array(fc.nat(240)), (value, cuts) => {
        expect(split(chunked(encoder.encode(value), cuts))).toEqual(expected(value));
      })
    );
  });

  test("a 16 MB line in 64 KB chunks is scanned once, not once per chunk", () => {
    let scanned = 0;

    const counting: FindNewline = (text, from) => {
      const at = text.indexOf("\n", from);
      scanned += (at < 0 ? text.length : at + 1) - from;

      return at;
    };

    const size = 16 * 1024 * 1024;
    const chunk = 64 * 1024;
    const line = new Uint8Array(size).fill(0x61);
    const splitter = lineSplitter(counting);

    for (let at = 0; at < size; at += chunk)
      expect(splitter.push(line.subarray(at, at + chunk))).toEqual([]);

    const [done] = splitter.push(encoder.encode("\n"));

    expect(done?.length).toBe(size);
    expect(scanned).toBe(size + 1);
  });
});

describe("readLines", () => {
  test("drops the unterminated last line unless asked for it, and keeps empty lines", async () => {
    const chunks = chunked(encoder.encode("a\n\nb\r\nc"), [1, 3, 5]);

    expect(await collect(readLines(stream(chunks)))).toEqual(["a", "", "b\r"]);
    expect(await collect(readLines(stream(chunks), { unterminated: true }))).toEqual([
      "a",
      "",
      "b\r",
      "c",
    ]);
  });

  test("a stream ending in a newline has no unterminated line to add", async () => {
    const lines = readLines(stream([encoder.encode("a\nb\n")]), { unterminated: true });

    expect(await collect(lines)).toEqual(["a", "b"]);
  });

  test("breaking out of the loop cancels the stream", async () => {
    let cancelled = false;

    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode("line\n"));
      },
      cancel() {
        cancelled = true;
      },
    });

    for await (const line of readLines(source)) {
      expect(line).toBe("line");
      break;
    }

    expect(cancelled).toBe(true);
  });
});
