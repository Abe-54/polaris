/**
 * The Hosts card's pixel line art (Paper X-F 05): isometric machines drawn about their
 * bottom vertex, in theme tokens so both themes hold.
 */
import type { ReactNode } from "react";
import type { HostArt } from "./model.ts";

export const LINE = "var(--color-text-subtle)";

export const INNER = "color-mix(in oklab, var(--color-text-strong) 14%, transparent)";

export const DETAIL = "color-mix(in oklab, var(--color-text-strong) 28%, transparent)";

const LIGHT = "var(--color-starlight)";

const face = (percent: number) =>
  `color-mix(in oklab, var(--color-text-strong) ${percent}%, var(--color-well))`;

/** Left, right and top faces, lightest on top. */
export const LEFT = face(4);

export const RIGHT = face(2);

export const TOP = face(8);

export interface At {
  readonly x: number;
  readonly y: number;
}

/** Moves Paper's coordinates (drawn about `origin`) to `at`. */
export const Placed = ({
  at,
  origin,
  children,
}: {
  readonly at: At;
  readonly origin: At;
  readonly children: ReactNode;
}) => <g transform={`translate(${at.x - origin.x} ${at.y - origin.y})`}>{children}</g>;

/** An isometric box: left and right sides and the top, from three point lists. */
export const Box = ({
  left,
  right,
  top,
  dashed = false,
}: {
  readonly left: string;
  readonly right: string;
  readonly top: string;
  readonly dashed?: boolean;
}) => {
  const stroke = { stroke: LINE, strokeDasharray: dashed ? "3 2" : undefined };

  return (
    <>
      <polygon points={left} style={{ fill: LEFT, ...stroke }} />
      <polygon points={right} style={{ fill: RIGHT, ...stroke }} />
      <polygon points={top} style={{ fill: TOP, ...stroke }} />
    </>
  );
};

/** A low square box with a lit status light: a Mac. */
const Mac = ({ lit }: { readonly lit: boolean }) => (
  <>
    <Box
      left="54,131 92,150 92,132 54,113"
      right="130,131 92,150 92,132 130,113"
      top="92,94 130,113 92,132 54,113"
    />
    <polygon points="92,98 122,113 92,128 62,113" style={{ fill: TOP, stroke: INNER }} />
    <path d="M60 123h2v2h-2zM64 125h2v2h-2zM68 127h2v2h-2z" style={{ fill: DETAIL }} />
    <rect x="84" y="136" width="2" height="2" style={{ fill: lit ? LIGHT : DETAIL }} />
  </>
);

const BAYS = "M223 126L249 138M223 116L249 128M223 106L249 118M223 96L249 108";

/** A rack server with its light in `light`; dashed when the machine is virtual (a WSL distro). */
const Server = ({ light, dashed }: { readonly light: string; readonly dashed: boolean }) => (
  <>
    <Box
      left="220,134 252,150 252,106 220,90"
      right="284,134 252,150 252,106 284,90"
      top="252,74 284,90 252,106 220,90"
      dashed={dashed}
    />
    <path d={BAYS} style={{ fill: "none", stroke: INNER }} />
    <path d="M245 141h2v2h-2zM245 131h2v2h-2zM245 121h2v2h-2z" style={{ fill: DETAIL }} />
    <rect x="245" y="111" width="2" height="2" style={{ fill: light }} />
  </>
);

/**
 * A rack server about its bottom vertex at `at`, its light in any colour (the service map lights
 * it in its service's hue); `light` null leaves it dark.
 */
export const ServerGlyph = ({
  at,
  light,
  dashed = false,
}: {
  readonly at: At;
  readonly light: string | null;
  readonly dashed?: boolean;
}) => (
  <Placed at={at} origin={{ x: 252, y: 150 }}>
    <Server light={light ?? DETAIL} dashed={dashed} />
  </Placed>
);

/** A flat board with a few chips on it: a single-board computer. */
const Board = () => (
  <>
    <Box
      left="369,124 421,150 421,147 369,121"
      right="455,133 421,150 421,147 455,130"
      top="403,104 455,130 421,147 369,121"
    />
    <Box
      left="395,123 407,129 407,127 395,121"
      right="419,123 407,129 407,127 419,121"
      top="407,115 419,121 407,127 395,121"
    />
    <Box
      left="433,130 444,136 444,126 433,121"
      right="453,131 444,136 444,126 453,122"
      top="442,116 453,122 444,126 433,121"
    />
    <Box
      left="422,136 433,141 433,132 422,126"
      right="442,136 433,141 433,132 442,128"
      top="431,122 442,128 433,132 422,126"
    />
    <path d="M405 106L439 123" style={{ fill: "none", stroke: DETAIL }} strokeDasharray="1 1" />
  </>
);

/** One Host's machine, its bottom vertex at `at`; the light is on while it's connected. */
export const HostGlyph = ({
  art,
  at,
  lit,
}: {
  readonly art: HostArt;
  readonly at: At;
  readonly lit: boolean;
}) => {
  if (art === "mac")
    return (
      <Placed at={at} origin={{ x: 92, y: 150 }}>
        <Mac lit={lit} />
      </Placed>
    );

  if (art === "board")
    return (
      <Placed at={at} origin={{ x: 412, y: 150 }}>
        <Board />
      </Placed>
    );

  return <ServerGlyph at={at} light={lit ? LIGHT : null} dashed={art === "virtual"} />;
};

/** The open laptop the card is seen from: this machine. Its hinge's top is at `at`. */
export const ThisMachine = ({ at }: { readonly at: At }) => (
  <Placed at={at} origin={{ x: 316, y: 279 }}>
    <Box
      left="280,324 324,346 324,343 280,321"
      right="352,332 324,346 324,343 352,329"
      top="308,307 352,329 324,343 280,321"
    />
    <polygon points="308,307 352,329 352,301 308,279" style={{ fill: LEFT, stroke: LINE }} />
    <polygon points="311,306 349,324 349,302 311,284" style={{ fill: RIGHT, stroke: INNER }} />
    <path
      d="M307 314L339 330M304 315L336 331M301 316L333 332M298 318L330 334M295 320L327 336"
      style={{ fill: "none", stroke: INNER }}
    />
  </Placed>
);

/** How tall the laptop is from its hinge's top to its lowest corner. */
export const THIS_MACHINE_HEIGHT = 67;
