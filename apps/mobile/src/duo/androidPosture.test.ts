import { describe, expect, test } from "bun:test";
import { arrangementOf } from "./arrangement.ts";
import { postureOf, readReport } from "./posture.ts";

// Android reports dp: a 2208 × 1840 window at density 2 is 1104 × 920 here.
const book = JSON.stringify({
  hinge: { status: "partiallyOpen", angle: 90 },
  width: 1104,
  height: 920,
  divisions: [{ x: 552, y: 0, width: 0, height: 920 }],
});

const tabletop = JSON.stringify({
  hinge: { status: "partiallyOpen", angle: 90 },
  width: 920,
  height: 1104,
  divisions: [{ x: 0, y: 552, width: 920, height: 0 }],
});

describe("Android fold reports through the shared layout", () => {
  test("a zero-width book crease gives the thread and context adjacent panes", () => {
    expect(
      arrangementOf(postureOf(readReport(book)), {
        screen: "thread",
        hostId: "h",
        sessionId: "s",
      })
    ).toEqual({
      kind: "context",
      first: { x: 0, y: 0, width: 552, height: 920 },
      second: { x: 552, y: 0, width: 552, height: 920 },
    });
  });

  test("rotating a half-open device to tabletop moves the composer under a zero-height crease", () => {
    expect(
      arrangementOf(postureOf(readReport(tabletop)), {
        screen: "thread",
        hostId: "h",
        sessionId: "s",
      })
    ).toEqual({
      kind: "laptop",
      bottom: { x: 0, y: 552, width: 920, height: 552 },
      division: { x: 0, y: 552, width: 920, height: 0 },
    });
  });

  test("cover display and flat non-separating crease return to a single pane", () => {
    const posture = postureOf(readReport('{"hinge":null,"width":412,"height":892,"divisions":[]}'));

    expect(arrangementOf(posture, { screen: "tabs" })).toEqual({ kind: "single" });
  });

  test("a separating flat horizontal hinge stacks panes without enabling the laptop", () => {
    const posture = postureOf(
      readReport(
        '{"hinge":{"status":"fullyOpen","angle":180},"width":920,"height":1104,"divisions":[{"x":0,"y":548,"width":920,"height":8}]}'
      )
    );

    expect(posture).toEqual({
      kind: "unfolded",
      first: { x: 0, y: 0, width: 920, height: 548 },
      second: { x: 0, y: 556, width: 920, height: 548 },
      division: { x: 0, y: 548, width: 920, height: 8 },
    });
  });
});
