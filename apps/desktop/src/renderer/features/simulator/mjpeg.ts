/**
 * The hub's `stream.mjpeg`, local Hosts only: `multipart/x-mixed-replace; boundary=frame`, each
 * part `--frame`, its headers, a blank line and one JPEG of `Content-Length` bytes.
 */

const encoder = new TextEncoder();

const decoder = new TextDecoder("latin1");

const indexOf = (haystack: Uint8Array, needle: Uint8Array, from: number) => {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;

    return i;
  }

  return -1;
};

/** Headers longer than this mean the stream isn't multipart. */
const MAX_PART_HEAD = 4096;

export type MjpegRead =
  | { readonly kind: "frames"; readonly frames: ReadonlyArray<Uint8Array> }
  | { readonly kind: "invalid" };

export interface MjpegParser {
  readonly push: (bytes: Uint8Array) => MjpegRead;
}

const lengthOf = (head: string) => {
  const match = /(?:^|\r\n)content-length:\s*(\d{1,9})\s*(?:\r\n|$)/i.exec(head);

  return match === null ? null : Number(match[1]);
};

/** Reads JPEGs out of the multipart body however its bytes are split. */
export const mjpegParser = (boundary = "frame"): MjpegParser => {
  const marker = encoder.encode(`--${boundary}`);
  const headEnd = encoder.encode("\r\n\r\n");
  let buffer = new Uint8Array(0);

  const next = (): Uint8Array | "more" | "invalid" => {
    const start = indexOf(buffer, marker, 0);

    if (start === -1) return buffer.length > MAX_PART_HEAD ? "invalid" : "more";
    const end = indexOf(buffer, headEnd, start);

    if (end === -1) return buffer.length - start > MAX_PART_HEAD ? "invalid" : "more";
    const length = lengthOf(decoder.decode(buffer.subarray(start + marker.length, end)));

    if (length === null) return "invalid";
    const body = end + headEnd.length;

    if (buffer.length < body + length) return "more";
    const frame = buffer.slice(body, body + length);

    buffer = buffer.subarray(body + length);

    return frame;
  };

  return {
    push: (bytes) => {
      const joined = new Uint8Array(buffer.length + bytes.length);

      joined.set(buffer);
      joined.set(bytes, buffer.length);
      buffer = joined;
      const frames: Array<Uint8Array> = [];

      for (;;) {
        const frame = next();

        if (frame === "invalid") return { kind: "invalid" };

        if (frame === "more") return { kind: "frames", frames };
        frames.push(frame);
      }
    },
  };
};

/**
 * The frames to paint: the first JPEG on a connect is the frame cached before it, so it may show
 * the screen before the latest input (spike surprise 7). It is skipped.
 */
export const freshFrames = () => {
  let skipped = false;

  return (frames: ReadonlyArray<Uint8Array>): ReadonlyArray<Uint8Array> => {
    if (skipped || frames.length === 0) return frames;
    skipped = true;

    return frames.slice(1);
  };
};
