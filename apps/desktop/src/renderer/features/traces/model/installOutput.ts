/**
 * The last lines a terminal printed, as plain text for a failure message: escape sequences
 * removed, a line redrawn with a carriage return kept as its last drawing, blank lines dropped.
 */

/** CSI (colours, cursor moves) and OSC (titles, links) sequences. */
// oxlint-disable-next-line no-control-regex -- matching the terminal's escape bytes is the point.
const ESCAPES = /\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;

const KEPT_BYTES = 16_384;

export interface OutputTail {
  readonly push: (data: Uint8Array) => void;
  /** At most `lines` lines, the newest last; empty when nothing was printed. */
  readonly lines: (lines: number) => ReadonlyArray<string>;
}

export const outputTail = (): OutputTail => {
  const decoder = new TextDecoder();
  let text = "";

  return {
    push: (data) => {
      text = (text + decoder.decode(data, { stream: true })).slice(-KEPT_BYTES);
    },
    lines: (count) =>
      text
        .replace(ESCAPES, "")
        .split("\n")
        .map((line) => (line.split("\r").findLast((part) => part.trim() !== "") ?? "").trim())
        .filter((line) => line !== "")
        .slice(-count),
  };
};
