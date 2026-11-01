import { type HTMLAttributes, useId } from "react";

import { cn } from "../../../lib/cn";
import { BIRDS, DAWN_TILES, MOON, MOON_HALO, RIDGES, STARS } from "./art";

/** The horizon's box: 140px of sky, the ridges in its bottom 72px. */
const SKY = 140;

const RIDGE = 72;

const ART_WIDTH = 1440;

/** Stars left of this sit over the sidebar's bare ground at a fixed offset; the rest scale. */
const FIXED_STARS = 300;

/** Each dawn band's top and height, foot first; the first is solid, the rest a thinning dither. */
const DAWN_BANDS = [
  { y: 96, height: 22 },
  { y: 76, height: 20 },
  { y: 56, height: 20 },
  { y: 36, height: 20 },
  { y: 16, height: 20 },
] as const;

/** Moonlit's colour, or Midnight's under `--midnight: 1` (theme.css), which the nearest theme sets. */
const dark = (moonlit: string, midnight: string) =>
  `color-mix(in oklab, ${midnight} calc(var(--midnight, 0) * 100%), ${moonlit})`;

/*
 * Per-theme colours as light-dark() pairs, so the system appearance needs no JavaScript: light
 * draws the dawn, dark the night; Midnight swaps the night for a new moon.
 */
const THEME: Readonly<Record<`--hz-${string}`, string>> = {
  "--hz-back": `light-dark(#C9D3C4, ${dark("#262B45", "#151A3A")})`,
  "--hz-front": `light-dark(#B7C4B9, ${dark("#1E2236", "#0B1026")})`,
  "--hz-glow-0": `light-dark(#F6D9C466, ${dark("#465CBE1F", "#465CBE29")})`,
  "--hz-glow-1": `light-dark(#F6D9C41F, ${dark("#465CBE0A", "#465CBE0D")})`,
  "--hz-star": "light-dark(transparent, #BCD3FF)",
  "--hz-dawn": "light-dark(#F6D9C4, transparent)",
};

const night = (color: string) => `light-dark(transparent, ${color})`;

const day = (color: string) => `light-dark(${color}, transparent)`;

const starX = (x: number) => (x < FIXED_STARS ? x : `${((x / ART_WIDTH) * 100).toFixed(2)}%`);

const Stars = () => (
  <svg
    width="100%"
    height={SKY}
    className="pixelated absolute inset-x-0 top-0"
    style={{ opacity: "calc(0.7 + 0.3 * var(--midnight, 0))" }}
  >
    {STARS.map((star) => (
      <rect
        key={`${star.x},${star.y}`}
        x={starX(star.x)}
        y={star.y}
        width={star.size}
        height={star.size}
        style={{
          fill: "var(--hz-star)",
          opacity: star.moonlit ? star.opacity : `calc(${star.opacity} * var(--midnight, 0))`,
        }}
      />
    ))}
  </svg>
);

const Dawn = () => {
  const id = useId().replaceAll(/[^\w-]/g, "");

  return (
    <svg width="100%" height={SKY} className="pixelated absolute inset-x-0 top-0">
      <defs>
        {DAWN_TILES.map((tile, index) => (
          <pattern
            key={tile}
            id={`${id}-dawn-${index}`}
            width="8"
            height="8"
            patternUnits="userSpaceOnUse"
          >
            <path d={tile} style={{ fill: "var(--hz-dawn)" }} />
          </pattern>
        ))}
      </defs>
      <rect y={118} width="100%" height={22} style={{ fill: "var(--hz-dawn)" }} />
      {DAWN_BANDS.map((band, index) => (
        <rect
          key={band.y}
          y={band.y}
          width="100%"
          height={band.height}
          fill={`url(#${id}-dawn-${index})`}
        />
      ))}
    </svg>
  );
};

const Ridges = () => (
  <svg
    width="100%"
    height={RIDGE}
    viewBox={`0 0 ${ART_WIDTH} ${RIDGE}`}
    preserveAspectRatio="none"
    className="pixelated absolute inset-x-0 bottom-0"
  >
    <path d={RIDGES[0]} style={{ fill: "var(--hz-back)" }} />
    <path d={RIDGES[1]} style={{ fill: "var(--hz-front)" }} />
  </svg>
);

/** Moonlit's pixel moon, over the sidebar's ground; Midnight is a new moon. */
const Moon = () => (
  <svg
    width="72"
    height="72"
    viewBox="0 0 72 72"
    className="pixelated absolute top-5 left-[68px]"
    data-slot="horizon-moon"
    style={{ opacity: "calc(1 - var(--midnight, 0))" }}
  >
    <path d={MOON_HALO} style={{ fill: night("#D9DEE833") }} />
    {MOON.map(([fill, d]) => (
      <path key={fill} d={d} style={{ fill: night(fill) }} />
    ))}
  </svg>
);

const Birds = () => (
  <svg
    width="48"
    height="20"
    viewBox="0 0 48 20"
    className="pixelated absolute top-[22px] left-[178px]"
  >
    {BIRDS.map(([fill, d]) => (
      <path key={d} d={d} style={{ fill: day(fill) }} />
    ))}
  </svg>
);

/**
 * The horizon (DESIGN.md, Chrome redesign): a stepped pixel ridge with a faint glow and sparse
 * stars along the window's foot, drawn behind the panels. It takes no height: put it inside a
 * `relative isolate` container, whose in-flow content paints over it. Stars sit only where the
 * ground is bare (the sidebar's sky above its footer, the gaps); it is static, with no timers.
 * `moon={false}` leaves out Moonlit's moon, for a sidebar whose footer text would sit over it.
 */
export function Horizon({
  className,
  moon = true,
  ...props
}: HTMLAttributes<HTMLDivElement> & { readonly moon?: boolean }) {
  return (
    <div
      aria-hidden="true"
      data-slot="horizon"
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-0 -z-10 overflow-hidden select-none",
        className
      )}
      style={{ ...THEME, height: SKY }}
      {...props}
    >
      <div className="absolute inset-0 bg-[linear-gradient(in_oklab_to_top,var(--hz-glow-0),var(--hz-glow-1)_45%,transparent)]" />
      <Dawn />
      <Stars />
      <Birds />
      {moon ? <Moon /> : null}
      <Ridges />
    </div>
  );
}
