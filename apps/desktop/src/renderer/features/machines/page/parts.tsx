/**
 * Small parts the host list and host page share: the state dot, the Connection State pill,
 * the host's colour square and the ⋯ glyph (Paper HS-D, HS-D2).
 */
import type { CelestialBody } from "@polaris/protocol";
import { cn, PixelAlertIcon } from "@polaris/ui";
import type { ConnectionLine } from "../model.ts";
import type { Pill } from "./state.ts";

/** Filled, hollow, dashed, or the pixel alert: never colour alone (rule/no-colour-alone). */
export const StateDot = ({ state }: { readonly state: ConnectionLine["state"] }) => {
  if (state === "needs-attention")
    return <PixelAlertIcon size={10} aria-hidden className="text-text-default shrink-0" />;

  return (
    <span
      aria-hidden
      data-mark={state}
      className={cn(
        "size-[7px] shrink-0 rounded-full",
        state === "connected" && "bg-text-subtle",
        state === "reconnecting" && "border-text-subtle border",
        (state === "offline" || state === "off") && "border-text-subtle border border-dashed"
      )}
    />
  );
};

/** The header's pill: "Connected · 47 ms" on a faint fill. */
export const ConnectionPill = ({ pill }: { readonly pill: Pill }) => (
  <span
    data-testid="connection-pill"
    data-state={pill.state}
    className="border-hairline text-caption text-text-default tabular flex h-7 shrink-0 items-center gap-1.5 rounded-full border bg-[light-dark(#00000005,#ffffff0a)] px-3 whitespace-nowrap"
  >
    <StateDot state={pill.state} />
    {pill.label}
  </span>
);

const SQUARE = {
  8: "size-2 rounded-[2px]",
  10: "size-2.5 rounded-[3px]",
  14: "size-3.5 rounded-[4px]",
} as const;

/** A host's colour; a host without one gets a neutral fill, never an outline (a checkbox look). */
export const ColourSquare = ({
  colour,
  size,
}: {
  readonly colour: string | null;
  readonly size: 8 | 10 | 14;
}) => (
  <span
    aria-hidden
    className={cn("shrink-0", SQUARE[size], colour === null && "bg-text-faint")}
    style={colour === null ? undefined : { background: colour }}
  />
);

export const DotsGlyph = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="text-text-default">
    <circle cx="3.5" cy="8" r="1.2" fill="currentColor" />
    <circle cx="8" cy="8" r="1.2" fill="currentColor" />
    <circle cx="12.5" cy="8" r="1.2" fill="currentColor" />
  </svg>
);

export const ChevronGlyph = ({ back = false }: { readonly back?: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden className="text-text-subtle shrink-0">
    <path
      d={back ? "M10 4L6 8l4 4" : "M6 4l4 4-4 4"}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const BODIES = new Map<string, CelestialBody>([
  ["claude", "banded"],
  ["codex", "ringed"],
  ["opencode", "storm"],
]);

/** A Harness's Celestial where no session gives one (the Harnesses card, the confirm's well). */
export const harnessBody = (harness: string): CelestialBody => BODIES.get(harness) ?? "crescent";
