/**
 * Just enough HTTP/1.1 to read one response from the hub over a byte stream: the head, then a
 * body that is chunked, sized or runs to the close. One request per connection.
 */

const CRLF = Buffer.from("\r\n");

const HEAD_END = Buffer.from("\r\n\r\n");

/** A head larger than this is refused. */
export const MAX_RESPONSE_HEAD = 16 * 1024;

export interface ResponseHead {
  readonly status: number;
  /** Lowercased names; a repeated header keeps its last value. */
  readonly headers: ReadonlyMap<string, string>;
}

export const concatBytes = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  if (a.length === 0) return b;

  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);

  out.set(a);
  out.set(b, a.length);

  return out;
};

const indexOf = (bytes: Uint8Array, needle: Uint8Array, from = 0) =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).indexOf(needle, from);

export type HeadRead =
  | { readonly kind: "more" }
  | { readonly kind: "invalid" }
  | { readonly kind: "done"; readonly head: ResponseHead; readonly rest: Uint8Array };

/** The response head once it has all arrived, and the bytes after it. */
export const readHead = (bytes: Uint8Array): HeadRead => {
  const end = indexOf(bytes, HEAD_END);

  if (end === -1) return bytes.length > MAX_RESPONSE_HEAD ? { kind: "invalid" } : { kind: "more" };

  const [statusLine = "", ...lines] = Buffer.from(bytes.subarray(0, end))
    .toString("latin1")
    .split("\r\n");

  const match = /^HTTP\/1\.[01] (\d{3})(?: .*)?$/.exec(statusLine);

  if (match === null) return { kind: "invalid" };
  const headers = new Map<string, string>();

  for (const line of lines) {
    const colon = line.indexOf(":");

    if (colon > 0)
      headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }

  return {
    kind: "done",
    head: { status: Number(match[1]), headers },
    rest: bytes.subarray(end + HEAD_END.length),
  };
};

export interface BodyRead {
  readonly chunks: ReadonlyArray<Uint8Array>;
  /** The body has ended; anything after it is ignored. */
  readonly done: boolean;
  /** The framing is broken: the connection must close. */
  readonly invalid: boolean;
}

export interface BodyDecoder {
  readonly push: (bytes: Uint8Array) => BodyRead;
}

const body = (chunks: ReadonlyArray<Uint8Array>, done = false, invalid = false): BodyRead => ({
  chunks,
  done,
  invalid,
});

/** `Transfer-Encoding: chunked`: sizes in hex, each chunk followed by CRLF, ending at size 0. */
const chunkedDecoder = (): BodyDecoder => {
  let buffer: Uint8Array = new Uint8Array();
  /** Data bytes left in the current chunk, then its CRLF; -1 while reading a size line. */
  let left = -1;

  const step = (out: Array<Uint8Array>): "more" | "done" | "invalid" | "continue" => {
    if (left === -1) {
      const end = indexOf(buffer, CRLF);

      if (end === -1) return buffer.length > 1024 ? "invalid" : "more";
      const size = Number.parseInt(Buffer.from(buffer.subarray(0, end)).toString("latin1"), 16);

      if (!Number.isSafeInteger(size) || size < 0) return "invalid";
      buffer = buffer.subarray(end + CRLF.length);

      if (size === 0) return "done";
      left = size + CRLF.length;

      return "continue";
    }

    if (buffer.length === 0) return "more";
    const data = Math.max(0, left - CRLF.length);
    const take = Math.min(buffer.length, data);

    if (take > 0) out.push(buffer.slice(0, take));
    const skip = Math.min(buffer.length, left);

    buffer = buffer.subarray(skip);
    left -= skip;

    if (left === 0) left = -1;

    return "continue";
  };

  return {
    push: (bytes) => {
      buffer = concatBytes(buffer, bytes);
      const out: Array<Uint8Array> = [];

      for (;;) {
        const next = step(out);

        if (next === "continue") continue;

        return body(out, next === "done", next === "invalid");
      }
    },
  };
};

const sizedDecoder = (length: number): BodyDecoder => {
  let left = length;

  return {
    push: (bytes) => {
      const kept = bytes.subarray(0, left);

      left -= kept.length;

      return body(kept.length > 0 ? [kept] : [], left === 0);
    },
  };
};

const untilClose = (): BodyDecoder => ({ push: (bytes) => body(bytes.length > 0 ? [bytes] : []) });

/** The decoder a response's headers call for. */
export const bodyDecoder = (head: ResponseHead): BodyDecoder => {
  const encoding = head.headers.get("transfer-encoding")?.toLowerCase();

  if (encoding !== undefined && encoding.split(",").at(-1)?.trim() === "chunked")
    return chunkedDecoder();
  const length = head.headers.get("content-length");

  return length !== undefined && /^\d{1,15}$/.test(length)
    ? sizedDecoder(Number(length))
    : untilClose();
};

/** A GET for `path` on the hub, its token in the header, the connection closed after. */
export const getRequest = (port: number, path: string, token: string): Uint8Array =>
  Buffer.from(
    [
      `GET ${path} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      `Authorization: Bearer ${token}`,
      "Accept: */*",
      "Connection: close",
      "",
      "",
    ].join("\r\n"),
    "latin1"
  );
