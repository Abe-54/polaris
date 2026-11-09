import { describe, expect, test } from "bun:test";
import { bodyDecoder, MAX_RESPONSE_HEAD, readHead } from "./http.ts";

const text = (value: string) => new Uint8Array(Buffer.from(value, "latin1"));

const headOf = (raw: string) => {
  const read = readHead(text(raw));

  if (read.kind !== "done") throw new Error(`head ${read.kind}`);

  return read;
};

/** Feeds `bytes` in pieces of `size`, returning the body and whether it ended. */
const decode = (headers: string, bytes: Uint8Array, size: number) => {
  const decoder = bodyDecoder(headOf(`HTTP/1.1 200 OK\r\n${headers}\r\n\r\n`).head);
  const parts: Array<Uint8Array> = [];
  let done = false;
  let invalid = false;

  for (let at = 0; at < bytes.length && !done && !invalid; at += size) {
    const read = decoder.push(bytes.subarray(at, at + size));

    parts.push(...read.chunks);
    done = read.done;
    invalid = read.invalid;
  }

  return { body: Buffer.concat(parts).toString("latin1"), done, invalid };
};

describe("readHead", () => {
  test("reads the status, lowercased headers, and the bytes after the head", () => {
    const read = headOf("HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\n\r\nno");

    expect([read.head.status, read.head.headers.get("content-type")]).toEqual([401, "text/plain"]);
    expect(Buffer.from(read.rest).toString()).toBe("no");
  });

  test("an unfinished head waits; one past the cap is refused", () => {
    expect(readHead(text("HTTP/1.1 200 OK\r\nX: y\r\n")).kind).toBe("more");
    expect(readHead(text(`HTTP/1.1 200 OK\r\nX: ${"y".repeat(MAX_RESPONSE_HEAD)}`)).kind).toBe(
      "invalid"
    );
  });
});

describe("bodyDecoder", () => {
  const chunked = text(
    "4\r\nWiki\r\n6;ext=1\r\npedia \r\nE\r\nin \r\n\r\nchunks.\r\n0\r\n\r\ntrailing"
  );

  test.each([1, 2, 7, chunked.length])("a chunked body in pieces of %i", (size) => {
    expect(decode("Transfer-Encoding: chunked", chunked, size)).toEqual({
      body: "Wikipedia in \r\n\r\nchunks.",
      done: true,
      invalid: false,
    });
  });

  test("a chunk size that isn't hex breaks the connection", () => {
    expect(decode("Transfer-Encoding: chunked", text("zz\r\nhi\r\n"), 64).invalid).toBe(true);
  });

  test("a sized body ends at its length and ignores what follows", () => {
    expect(decode("Content-Length: 5", text("hello, world"), 3)).toEqual({
      body: "hello",
      done: true,
      invalid: false,
    });
  });
});
