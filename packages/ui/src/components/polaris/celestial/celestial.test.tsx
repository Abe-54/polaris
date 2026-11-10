import {
  CELESTIAL_MOONS,
  CELESTIAL_PLANETS,
  CELESTIAL_RARE,
  CELESTIAL_STARS,
} from "@polaris/protocol";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import { hueVar } from "../../../lib/hue";

import {
  Celestial,
  CELESTIAL_FRAMES,
  celestialCells,
  isKnownCelestial,
  leadStar,
  sessionCelestial,
  subagentMoon,
} from ".";

afterEach(cleanup);

const BODIES = [...CELESTIAL_PLANETS, ...CELESTIAL_STARS, ...CELESTIAL_MOONS, ...CELESTIAL_RARE];

const picture = (cells: ReturnType<typeof celestialCells>) =>
  cells.map((c) => `${c.x},${c.y},${c.tone}`).join(" ");

describe("the Celestial set", () => {
  test("every body in the protocol's catalogue is drawn, each its own picture", () => {
    expect(BODIES.filter((body) => !isKnownCelestial(body))).toEqual([]);
    expect(new Set(BODIES.map((body) => picture(celestialCells(body)))).size).toBe(BODIES.length);
  });

  test("every body sits on the 16 grid in two or three tones of its hue", () => {
    for (const body of BODIES) {
      const cells = celestialCells(body);
      const tones = new Set(cells.map((c) => c.tone));

      expect(cells.every((c) => c.x >= 0 && c.x < 16 && c.y >= 0 && c.y < 16)).toBe(true);
      expect([2, 3]).toContain(tones.size);
      expect(tones.has("glint")).toBe(false);
    }
  });

  test("every body but the Death Star moves inside itself while Working", () => {
    for (const body of BODIES.filter((b) => b !== "death-star")) {
      const frames = Array.from({ length: CELESTIAL_FRAMES }, (_, f) => celestialCells(body, f));
      const outline = new Set(celestialCells(body).map((c) => `${c.x},${c.y}`));

      expect(new Set(frames.map(picture)).size).toBeGreaterThan(1);
      expect(frames.flat().every((c) => outline.has(`${c.x},${c.y}`))).toBe(true);
    }
  });

  test("the Death Star fires its laser past its outline while Working, and rests still", () => {
    const outline = new Set(celestialCells("death-star").map((c) => `${c.x},${c.y}`));

    const frames = Array.from({ length: CELESTIAL_FRAMES }, (_, f) =>
      celestialCells("death-star", f)
    );

    const beam = frames.map((cells) => cells.filter((c) => !outline.has(`${c.x},${c.y}`)));

    expect(beam.some((cells) => cells.length > 0)).toBe(true);
    expect(beam.flat().every((c) => c.tone === "laser")).toBe(true);
    expect(beam.some((cells) => cells.length === 0)).toBe(true);
  });

  test("a body from a newer Daemon is drawn as the first planet", () => {
    expect(picture(celestialCells("comet"))).toBe(picture(celestialCells(CELESTIAL_PLANETS[0])));
  });

  test("a Lead shows a star kept from its planet; a Subagent a moon by its place", () => {
    expect(sessionCelestial("banded", true)).toBe(leadStar("banded"));
    expect(CELESTIAL_STARS.some((star) => star === leadStar("banded"))).toBe(true);
    expect(sessionCelestial("banded")).toBe("banded");
    expect(sessionCelestial(null)).toBe(CELESTIAL_PLANETS[0]);
    expect(new Set([0, 1, 2].map(subagentMoon)).size).toBe(CELESTIAL_MOONS.length);
  });
});

/** A hex colour whose channels sit within 16 of each other: no hue to speak of. */
const isGrey = (colour: string) => {
  const channels = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i
    .exec(colour)
    ?.slice(1)
    .map((c) => Number.parseInt(c, 16));

  return channels !== undefined && Math.max(...channels) - Math.min(...channels) <= 16;
};

describe("Celestial", () => {
  test("the Death Star wears grey whatever its Harness; planets wear their Harness's hue", () => {
    const { container, rerender } = render(
      <Celestial body="death-star" harness="codex" size={16} />
    );

    const hue = () =>
      container
        .querySelector<HTMLElement>("[data-slot=celestial]")
        ?.style.getPropertyValue("--celestial-hue");

    const deathStar = hue() ?? "";
    expect(isGrey(deathStar)).toBe(true);
    rerender(<Celestial body="death-star" harness="claude" size={16} />);
    expect(hue()).toBe(deathStar);
    rerender(<Celestial body="ringed" harness="codex" size={16} />);
    expect(hue()).toBe(hueVar("codex"));
  });

  test("only a Working Celestial carries the 12 fps strip", () => {
    const { container, rerender } = render(<Celestial body="ringed" harness="claude" size={24} />);

    expect(container.querySelector(".polaris-celestial-live")).toBeNull();

    rerender(<Celestial body="ringed" harness="claude" size={24} working />);
    const strip = container.querySelector(".polaris-celestial-live svg");

    expect(strip?.getAttribute("width")).toBe(String(24 * CELESTIAL_FRAMES));
    expect(strip?.getAttribute("viewBox")).toBe(`0 0 ${16 * CELESTIAL_FRAMES} 16`);
  });

  test("draws whole grid cells at every size, so 16, 24 and 32 stay crisp", () => {
    for (const size of [16, 24, 32] as const) {
      const { container } = render(<Celestial body="storm" harness="codex" size={size} />);
      const svg = container.querySelector("svg");

      expect(svg?.getAttribute("width")).toBe(String(size));

      for (const path of container.querySelectorAll("path")) {
        expect(path.getAttribute("d")).toMatch(/^(M\d+ \d+h1v1h-1z)+$/);
      }

      cleanup();
    }
  });
});
