import { describe, expect, test } from "bun:test";

import {
  BLOOM_MS,
  bloomAt,
  DOT_PITCH,
  type FieldColors,
  type FieldFrame,
  hueAlpha,
  liveAt,
  onLattice,
  paintFrame,
  RESTING,
  sparseAlpha,
  STILL,
  Trail,
} from "./glow";

/** Paper "02 · WORKING", the Dot bloom's dots, one character per 2px cell. */
const PAPER_CORNER = [
  "#######################.###.###.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#...#...#",
  "##.###.###.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#",
  "#################.###.###.###.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#...#",
  ".###.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#...#",
  "###############.#######.#.#.#.#.#.#.#.#.#.#.#.#.#.#...#.#.#.#.#...#",
  ".#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#...#...#...#",
  "#.###.###.###.#.#.###.#.#.#.#.#.#.#.#.#.#.#.#.#...#...#.#.#...#",
  ".#.#.#.#.#.#.#.#.#.#.#.#.#.#...#...#",
  "#.#.###.###.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#...#...#",
  ".#.#.#.#.#.#.#...#.#.#...#...#...#...#",
  "#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#...#...#...#",
  ".......#...#.......#",
  "#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#...#.#.#...#...#",
  ".....#...#...#...#",
  "#.#.#.#.#.#.#.#...#...#...#...#...#",
  "",
  "#.#.#...#.#.#...#...#...#...#.......#",
  "",
  "..#",
];

const WIDTH = 640;

const HEIGHT = 42;

const COLORS: FieldColors = {
  hue: [1, 0, 0],
  trail: [2, 0, 0],
  sparse: [3, 0, 0],
  hueAlpha: 0.29,
};

interface Dot {
  readonly x: number;
  readonly y: number;
  readonly ink: "hue" | "trail" | "sparse";
}

const INKS = ["hue", "trail", "sparse"] as const;

function dots(frame: FieldFrame): Dot[] {
  const pixels = new Uint32Array(WIDTH * HEIGHT);
  const found: Dot[] = [];

  paintFrame({ pixels, width: WIDTH, height: HEIGHT }, COLORS, frame);
  pixels.forEach((pixel, at) => {
    const ink = INKS[(pixel & 0xff) - 1];

    if (ink !== undefined) found.push({ x: at % WIDTH, y: Math.floor(at / WIDTH), ink });
  });

  return found;
}

const live = (step: number, seed: number): FieldFrame => ({
  ...STILL,
  ...liveAt(step, seed),
  seed,
});

const fingerprint = (frame: FieldFrame) =>
  dots(frame)
    .map((d) => `${d.x},${d.y},${d.ink}`)
    .join(";");

describe("the Working strip's dither field", () => {
  test("its still corner is Paper's: the same dots within 2% of the cells", () => {
    let wrong = 0;
    let cells = 0;

    for (let j = 0; j < HEIGHT / DOT_PITCH; j++) {
      for (let i = 0; i < 100; i++) {
        const paper = PAPER_CORNER[j]?.[i] === "#";

        cells++;

        if (paper !== hueAlpha(i, j, STILL) > 0) wrong++;
      }
    }

    expect(wrong / cells).toBeLessThan(0.02);
  });

  test("every dot of the corner weighs the same, as in Paper", () => {
    const alphas = new Set<number>();

    for (let i = 0; i < 70; i++) for (let j = 0; j < 20; j++) alphas.add(hueAlpha(i, j, STILL));

    expect([...alphas].filter((a) => a > 0)).toEqual([0.29]);
  });

  test("live, the corner stays within Paper's top-left reach and nothing else is lit", () => {
    for (const seed of [1, 42, 0xdeadbeef]) {
      for (let step = 0; step < 600; step += 7) {
        const frame = dots(live(step, seed));
        const corner = frame.filter((d) => d.ink === "hue");

        expect(Math.max(...corner.map((d) => d.x))).toBeLessThan(160);
        expect(Math.max(...corner.map((d) => d.y))).toBeLessThan(44);
        expect(corner.length).toBe(frame.length);
      }
    }
  });

  test("live, no frame comes back after a second, so the motion doesn't visibly loop", () => {
    const first = new Map<string, number>();
    let longest = 0;

    for (let step = 1; step <= 360; step++) {
      const frame = fingerprint(live(step, 7));
      const seen = first.get(frame);

      if (seen === undefined) first.set(frame, step);
      else longest = Math.max(longest, step - seen);
    }

    expect(longest).toBeLessThan(12);
  });

  test("the seed decides the motion: two strips never shimmer in step", () => {
    expect(fingerprint(live(50, 1))).not.toBe(fingerprint(live(50, 2)));
    expect(fingerprint(live(50, 1))).toBe(fingerprint(live(50, 1)));
  });

  test("the still frame's corner holds whatever the seed: no drift, no breath", () => {
    const corner = (seed: number) => fingerprint(live(0, seed));

    expect(corner(1)).toBe(corner(99));
    expect(corner(1)).not.toBe(fingerprint(live(12, 1)));
  });

  test("a bloom floods the corner, reaches further, then settles to rest", () => {
    expect(bloomAt(0).gain).toBe(0);
    expect(bloomAt(400).gain).toBeGreaterThan(RESTING.gain);
    expect(bloomAt(400).spread).toBeCloseTo(1.3);
    expect(bloomAt(BLOOM_MS)).toEqual(RESTING);
  });

  test("sparse dots sit on a staggered 8×4px lattice", () => {
    const on = [onLattice(0, 0), onLattice(8, 0), onLattice(4, 4), onLattice(12, 4)];
    const off = [onLattice(4, 0), onLattice(0, 4), onLattice(2, 2), onLattice(0, 2)];

    expect(on).toEqual([true, true, true, true]);
    expect(off).toEqual([false, false, false, false]);
  });

  test("sparse dots show within 22px of the pointer, brightest at its centre", () => {
    const frame = { ...STILL, pointer: { x: 200, y: 16 }, presence: 1 };

    expect(sparseAlpha(200, 16, frame)).toBeCloseTo(0.6);
    expect(sparseAlpha(216, 16, frame)).toBeLessThan(sparseAlpha(200, 16, frame));
    expect(sparseAlpha(232, 16, frame)).toBe(0);
    expect(sparseAlpha(200, 16, { ...frame, presence: 0 })).toBe(0);
  });

  test("under the pointer the trail is Paper's sparse, flat patch, not a round blob", () => {
    const trail = new Trail(WIDTH / DOT_PITCH, HEIGHT / DOT_PITCH);

    for (let k = 0; k < 10; k++) trail.update(16, 280 + k * 4, 21, 1);
    const lit = dots({ ...STILL, trail }).filter((d) => d.ink === "trail");
    const xs = lit.map((d) => d.x);
    const ys = lit.map((d) => d.y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    const cells = (width / DOT_PITCH + 1) * (height / DOT_PITCH + 1);

    // Paper's pointer patch: ~75×17px of dots, a quarter of the cells or fewer.
    expect(height).toBeLessThanOrEqual(17);
    expect(width).toBeLessThanOrEqual(110);
    expect(lit.length / cells).toBeLessThan(0.3);
  });

  test("the trail settles while the pointer rests, so the frame loop stops", () => {
    const trail = new Trail(150, 21);
    let moving = true;
    let frames = 0;

    while (moving && frames < 400) {
      moving = trail.update(16, 100, 20, 1);
      frames++;
    }

    expect(frames).toBeLessThan(400);
  });

  test("the trail dies away once the pointer leaves", () => {
    const trail = new Trail(150, 21);

    trail.update(16, 100, 20, 1);
    let frames = 0;

    while (trail.update(16, 0, 0, 0) && frames < 400) frames++;

    expect(frames).toBeLessThan(400);
    expect(trail.values.every((v) => v === 0)).toBe(true);
  });
});
