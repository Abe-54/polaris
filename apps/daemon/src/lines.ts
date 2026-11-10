/**
 * Newline-delimited text from a byte stream (a child's stdout, an SSE body). Each chunk is
 * scanned once: a line split over many chunks is kept as fragments and joined at its newline,
 * so a long line costs linear time rather than a rescan of the whole buffer per chunk.
 */

/** Where the next "\n" in `text` is at or after `from`, or -1. */
export type FindNewline = (text: string, from: number) => number;

const nextNewline: FindNewline = (text, from) => text.indexOf("\n", from);

export interface LineSplitter {
  /** The lines `chunk` completes, without their "\n" (a "\r" before it stays). */
  readonly push: (chunk: Uint8Array) => Array<string>;
  /** The text after the last "\n" so far: the unterminated last line at the end of the stream. */
  readonly rest: () => string;
}

/** Decodes UTF-8 across chunk boundaries and splits it into lines; `find` is a test seam. */
export const lineSplitter = (find: FindNewline = nextNewline): LineSplitter => {
  const decoder = new TextDecoder();
  let fragments: Array<string> = [];

  const push = (chunk: Uint8Array): Array<string> => {
    const text = decoder.decode(chunk, { stream: true });
    const lines: Array<string> = [];
    let start = 0;

    for (let end = find(text, 0); end >= 0; end = find(text, start)) {
      const tail = text.slice(start, end);
      lines.push(fragments.length === 0 ? tail : fragments.join("") + tail);
      fragments = [];
      start = end + 1;
    }

    if (start < text.length) fragments.push(text.slice(start));

    return lines;
  };

  return { push, rest: () => fragments.join("") };
};

export interface ReadLinesOptions {
  /** Yield the unterminated last line, when there is one, as the stream ends. Default false. */
  readonly unterminated?: boolean;
  readonly find?: FindNewline;
}

/** The lines of `stream`, without their "\n". Breaking out of the loop cancels the stream. */
export async function* readLines(
  stream: AsyncIterable<Uint8Array>,
  options: ReadLinesOptions = {}
): AsyncGenerator<string> {
  const splitter = lineSplitter(options.find);

  for await (const chunk of stream) yield* splitter.push(chunk);

  const rest = splitter.rest();

  if (options.unterminated === true && rest !== "") yield rest;
}
