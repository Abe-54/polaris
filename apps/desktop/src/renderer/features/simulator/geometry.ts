/** Where the screen sits in its area, and a pointer's place on it as the hub takes it (0–1). */

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Rect extends Size {
  readonly left: number;
  readonly top: number;
}

/** A screen fraction: (0, 0) top left, (1, 1) bottom right. */
export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * The largest rect of the screen's aspect inside `area`, centred, in whole pixels. The aspect is
 * the frame's own: the iPhone Duo boots on its 466×678 outer panel, not the size its type names.
 */
export const fitRect = (area: Size, screen: Size): Rect => {
  if (area.width <= 0 || area.height <= 0 || screen.width <= 0 || screen.height <= 0)
    return { left: 0, top: 0, width: 0, height: 0 };
  const scale = Math.min(area.width / screen.width, area.height / screen.height);
  // The epsilon keeps 359.9999… (the side that fills) from flooring a pixel short.
  const width = Math.min(area.width, Math.floor(screen.width * scale + 1e-6));
  const height = Math.min(area.height, Math.floor(screen.height * scale + 1e-6));

  return {
    left: Math.floor((area.width - width) / 2),
    top: Math.floor((area.height - height) / 2),
    width,
    height,
  };
};

const clamp = (value: number) => Math.min(1, Math.max(0, value));

/** A pointer at client (x, y) as a screen fraction; null when it is off the screen. */
export const toScreenPoint = (
  client: { x: number; y: number },
  screen: Rect
): ScreenPoint | null => {
  if (screen.width <= 0 || screen.height <= 0) return null;
  const x = (client.x - screen.left) / screen.width;
  const y = (client.y - screen.top) / screen.height;

  return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y };
};

/** As `toScreenPoint`, but held to the screen's edge: a drag that leaves the screen keeps going. */
export const toScreenPointClamped = (
  client: { x: number; y: number },
  screen: Rect
): ScreenPoint =>
  screen.width <= 0 || screen.height <= 0
    ? { x: 0, y: 0 }
    : {
        x: clamp((client.x - screen.left) / screen.width),
        y: clamp((client.y - screen.top) / screen.height),
      };

/**
 * Quarter turns clockwise that show a frame upright. In landscape the hub still streams the
 * portrait framebuffer, with the UI turned inside it, so the view turns it back.
 */
export type QuarterTurns = 0 | 1 | 2 | 3;

export const turnsFor = (
  orientation: "portrait" | "portrait_upside_down" | "landscape_left" | "landscape_right" | null
): QuarterTurns => {
  switch (orientation) {
    case "landscape_left":
      return 1;
    case "portrait_upside_down":
      return 2;
    case "landscape_right":
      return 3;
    default:
      return 0;
  }
};

/** The frame's size as shown after `turns`. */
export const turnedSize = (frame: Size, turns: QuarterTurns): Size =>
  turns % 2 === 1 ? { width: frame.height, height: frame.width } : frame;

/** A point on the shown (turned) screen back in the frame's own fractions, which input takes. */
export const toFramePoint = (shown: ScreenPoint, turns: QuarterTurns): ScreenPoint => {
  switch (turns) {
    case 1:
      return { x: shown.y, y: 1 - shown.x };
    case 2:
      return { x: 1 - shown.x, y: 1 - shown.y };
    case 3:
      return { x: 1 - shown.y, y: shown.x };
    default:
      return shown;
  }
};
