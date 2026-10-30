import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { StrictMode } from "react";

import { DitherField, frameDt } from "./field";

afterEach(() => {
  cleanup();
  bounds?.mockRestore();

  if (realGetContext !== undefined)
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", realGetContext);
});

interface Painted {
  readonly width: number;
  readonly lit: number;
}

let painted: Painted[] = [];

/** A 2D context that records each frame put on the canvas: its width and how many dots it lit. */
function fakeContext() {
  return {
    fillStyle: "",
    fillRect: () => undefined,
    getImageData: () => ({ data: new Uint8ClampedArray([200, 120, 90, 255]) }),
    createImageData: (width: number, height: number) => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
    }),
    putImageData: (image: { width: number; data: Uint8ClampedArray }) => {
      let lit = 0;

      for (let at = 3; at < image.data.length; at += 4) if ((image.data[at] ?? 0) > 0) lit++;
      painted.push({ width: image.width, lit });
    },
  };
}

let bounds: { mockRestore: () => void } | undefined;

const realGetContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");

beforeEach(() => {
  painted = [];
  // The field only calls the members fakeContext provides.
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: fakeContext,
  });
  bounds = spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 0, 640, 42)
  );
});

describe("the live dither field", () => {
  test("re-run by StrictMode, it still paints the whole strip, not a 1px canvas", () => {
    render(
      <StrictMode>
        <div>
          <DitherField hue="claude" seed={3} />
        </div>
      </StrictMode>
    );

    const last = painted.at(-1);

    expect(last?.width).toBe(640);
    expect(last?.lit ?? 0).toBeGreaterThan(200);
  });

  test("a frame's step never runs backwards, so a bloom can't rewind", () => {
    expect(frameDt(-12)).toBe(0);
    expect(frameDt(16)).toBe(16);
    expect(frameDt(400)).toBe(50);
  });
});
