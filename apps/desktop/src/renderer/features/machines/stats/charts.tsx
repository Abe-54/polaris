/**
 * The Hosts pixel charts (DESIGN.md, Settings → Hosts redesign): crisp 2px columns over a
 * 1px track, and the 40-cell meter. Neutral inside a host page; the list's sparkline takes the
 * host's own colour (rule/host-hue-sparkline). Reduce Motion holds the last frame.
 */
import { useReducedMotion, useStill } from "./hooks.ts";
import { METER_CELLS, sparkBars } from "./model.ts";

const TRACK = "light-dark(#00000014,#ffffff14)";

/** History in the neutral mid grey, the latest sample in text-strong. */
const NEUTRAL = {
  history: "light-dark(#a4a6ac,#6b6d75)",
  latest: "var(--color-text-strong)",
} as const;

/** The host's hue: history at ~55%, the latest at full. */
const hued = (colour: string) => ({
  history: `color-mix(in srgb, ${colour} 55%, transparent)`,
  latest: colour,
});

/** One 2px column per bar, standing on `floor`. */
const bar = (column: number, height: number, floor: number) =>
  `M${column * 2} ${floor - height}h2v${height}h-2z`;

export interface SparklineProps {
  readonly values: ReadonlyArray<number | null>;
  /** Columns: 40 in the list, 60 in Vitals. */
  readonly count: number;
  readonly height: number;
  /** The host's colour; null draws it neutral. */
  readonly colour?: string | null;
  readonly label: string;
}

export const Sparkline = ({ values, count, height, colour = null, label }: SparklineProps) => {
  const shown = useStill(values, useReducedMotion());
  const floor = height - 1;
  const heights = sparkBars(shown, count, floor - 1);
  const last = heights.length - 1;
  const tone = colour === null ? NEUTRAL : hued(colour);
  const lastHeight = heights[last] ?? null;

  return (
    <svg
      role="img"
      aria-label={label}
      data-testid="sparkline"
      data-bars={heights.map((h) => h ?? 0).join(",")}
      width={count * 2}
      height={height}
      viewBox={`0 0 ${count * 2} ${height}`}
      className="block shrink-0 [shape-rendering:crispEdges]"
    >
      <path d={`M0 ${floor}h${count * 2}v1h-${count * 2}z`} fill={TRACK} />
      <path
        d={heights
          .slice(0, last)
          .map((h, i) => (h === null ? "" : bar(i, h, floor)))
          .join("")}
        fill={tone.history}
      />
      {lastHeight === null ? null : <path d={bar(last, lastHeight, floor)} fill={tone.latest} />}
    </svg>
  );
};

/** A 40-cell track: lit cells in text-default, the rest faint (Usage's meter). */
export const Meter = ({ lit, label }: { readonly lit: number; readonly label: string }) => (
  <svg
    role="img"
    aria-label={label}
    width={METER_CELLS * 3}
    height={10}
    viewBox={`0 0 ${METER_CELLS * 3} 10`}
    className="block shrink-0 [shape-rendering:crispEdges]"
  >
    {Array.from({ length: METER_CELLS }, (_, i) => (
      <rect
        key={i}
        x={i * 3}
        width={2}
        height={10}
        fill={i < lit ? "light-dark(#333438,#c9cbd1)" : TRACK}
      />
    ))}
  </svg>
);
