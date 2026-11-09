import { FRAME_HEIGHT_MAX, FRAME_HEIGHT_MIN } from "@polaris/visualization";
import { describe, expect, test } from "bun:test";
import { frameRequest } from "./messages.ts";
import { STATE_MAX_BYTES } from "./state.ts";

// SAFETY: the filter only compares `source` by identity; plain objects stand in for windows.
const frame = {} as Window;

// SAFETY: as above.
const other = {} as Window;

type Data = MessageEvent<unknown>["data"];

const from = (source: Window | null, data: Data) => frameRequest({ source, data }, frame);

describe("frame messages", () => {
  test("a message from another window is ignored, whatever it says", () => {
    expect(from(other, { type: "pv:height", height: 300 })).toBeNull();
    expect(from(null, { type: "pv:open-link", url: "https://example.com" })).toBeNull();
  });

  test("before the frame has a window, nothing is accepted", () => {
    expect(
      frameRequest({ source: frame, data: { type: "pv:height", height: 300 } }, null)
    ).toBeNull();
  });

  test.each([
    [300, 300],
    [12.2, FRAME_HEIGHT_MIN],
    [1e9, FRAME_HEIGHT_MAX],
    [240.4, 241],
  ])("height %p is clamped to %p", (height, expected) => {
    expect(from(frame, { type: "pv:height", height })).toEqual({
      kind: "height",
      height: expected,
    });
  });

  test("a height that isn't a number is dropped", () => {
    expect(from(frame, { type: "pv:height", height: Number.NaN })).toBeNull();
    expect(from(frame, { type: "pv:height", height: "300" })).toBeNull();
  });

  test.each([
    "http://example.com",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,hi",
    "app://polaris/index.html",
    "not a url",
  ])("a link to %s is refused without asking", (url) => {
    expect(from(frame, { type: "pv:open-link", url })).toBeNull();
  });

  test("an https link asks to open", () => {
    expect(from(frame, { type: "pv:open-link", url: "https://example.com/a b" })).toEqual({
      kind: "open-link",
      url: "https://example.com/a%20b",
    });
  });

  test("pv.state arrives as the JSON it will be stored as", () => {
    const state = { pv: 1, value: { rate: 5.5 }, tabs: { t: 1 } };

    expect(from(frame, { type: "pv:state", state })).toEqual({
      kind: "state",
      json: JSON.stringify(state),
    });
  });

  test("unknown message types are dropped", () => {
    expect(from(frame, { type: "pv:navigate", url: "https://example.com" })).toBeNull();
  });

  test("a pv.state too large to keep is dropped without serialising it whole", () => {
    let read = 0;

    const state = Array.from({ length: 100_000 }, (_, n) => ({
      get n() {
        read += 1;

        return n;
      },
    }));

    expect(from(frame, { type: "pv:state", state })).toBeNull();
    expect(read).toBeLessThan(STATE_MAX_BYTES);
  });
});
