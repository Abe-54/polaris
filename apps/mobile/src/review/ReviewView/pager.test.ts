import { describe, expect, test } from "bun:test";
import { finding } from "../review.testing.ts";
import { keepPositions, NO_POSITIONS, pageTo, pillCount } from "./pager.ts";

const findings = [
  finding("c1", "critical"),
  finding("m1", "medium"),
  finding("h1", "high"),
  finding("m2", "medium"),
];

const visit = (severity: "medium" | "high" | "low", taps: number) => {
  let positions = NO_POSITIONS;
  const seen: Array<string> = [];

  for (let i = 0; i < taps; i += 1) {
    const page = pageTo(findings, positions, severity);

    if (page === null) break;
    positions = page.positions;
    seen.push(page.finding.identity);
  }

  return { seen, positions };
};

describe("the severity pager", () => {
  test("a pill pages through only its severity, in Review's order, and cycles back", () => {
    expect(visit("medium", 3).seen).toEqual(["m1", "m2", "m1"]);
  });

  test("a severity with no findings goes nowhere", () => {
    expect(pageTo(findings, NO_POSITIONS, "low")).toBeNull();
  });

  test("the Critical pill skips a dismissed Critical, which the tally leaves out", () => {
    const dismissed = [finding("c0", "critical", { status: "dismissed" }), ...findings];

    expect(pageTo(dismissed, NO_POSITIONS, "critical")?.finding.identity).toBe("c1");
  });

  test("the pill shows its position once it has paged", () => {
    expect(pillCount(2, null)).toBe("2");
    expect(pillCount(2, visit("medium", 2).positions.medium)).toBe("2/2");
  });

  test("a position past a severity's shrunken list is dropped, so the next tap starts over", () => {
    const { positions } = visit("medium", 2);
    const kept = keepPositions([finding("m1", "medium")], positions);

    expect(kept.medium).toBeNull();
    expect(pageTo([finding("m1", "medium")], kept, "medium")?.finding.identity).toBe("m1");
  });
});
