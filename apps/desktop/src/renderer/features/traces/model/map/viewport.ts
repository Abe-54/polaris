/**
 * The service map's pan and zoom: a translation and scale from map coordinates to the canvas,
 * fitted to the canvas less its margins, and zoomed about a point that stays put.
 */

export interface Viewport {
  readonly x: number;
  readonly y: number;
  readonly k: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export const MIN_ZOOM = 0.2;

export const MAX_ZOOM = 2.5;

/** Room kept clear around the map: the legend and hints sit in the foot. */
export const MARGIN = { side: 24, top: 24, foot: 52 } as const;

const clamp = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

/** The whole map centred in the canvas, never enlarged past its own size. */
export const fitView = (canvas: Size, map: Size): Viewport => {
  const room = {
    width: Math.max(1, canvas.width - 2 * MARGIN.side),
    height: Math.max(1, canvas.height - MARGIN.top - MARGIN.foot),
  };

  const k = clamp(Math.min(1, room.width / map.width, room.height / map.height));

  return {
    x: (canvas.width - map.width * k) / 2,
    y: MARGIN.top + (room.height - map.height * k) / 2,
    k,
  };
};

/** The smallest zoom the map opens at: below it the labels stop being readable. */
export const OPEN_ZOOM = 0.8;

/**
 * Fitted when that stays readable or when only height limits it, so no row opens under the foot;
 * otherwise, too wide to read whole, at OPEN_ZOOM, centred across, from the top.
 */
export const openView = (canvas: Size, map: Size): Viewport => {
  const fitted = fitView(canvas, map);
  const across = (canvas.width - 2 * MARGIN.side) / map.width;

  if (fitted.k >= OPEN_ZOOM || across >= OPEN_ZOOM) return fitted;

  return { x: (canvas.width - map.width * OPEN_ZOOM) / 2, y: MARGIN.top, k: OPEN_ZOOM };
};

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const shift = (start: number, size: number, from: number, to: number) => {
  if (size > to - from || start < from) return from - start;

  return start + size > to ? to - (start + size) : 0;
};

/** Panned just enough that `box` (in map coordinates) sits inside the margins, above the foot. */
export const revealView = (view: Viewport, canvas: Size, box: Box): Viewport => {
  const left = view.x + box.x * view.k;
  const top = view.y + box.y * view.k;
  const dx = shift(left, box.width * view.k, MARGIN.side, canvas.width - MARGIN.side);
  const dy = shift(top, box.height * view.k, MARGIN.top, canvas.height - MARGIN.foot);

  return { ...view, x: view.x + dx, y: view.y + dy };
};

/** Scaled by `factor` (within the limits) about `at`, a point on the canvas. */
export const zoomAt = (view: Viewport, factor: number, at: { x: number; y: number }): Viewport => {
  const k = clamp(view.k * factor);
  const ratio = k / view.k;

  return { x: at.x - (at.x - view.x) * ratio, y: at.y - (at.y - view.y) * ratio, k };
};

/** A wheel's vertical delta as a zoom factor: up zooms in, smoothly for trackpads. */
export const wheelFactor = (deltaY: number) => Math.exp(-deltaY * 0.0015);

export const transformOf = (view: Viewport) =>
  `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
