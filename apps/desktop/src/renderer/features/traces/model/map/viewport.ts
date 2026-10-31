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

/** Fitted when that stays readable; otherwise at OPEN_ZOOM, centred across, from the top. */
export const openView = (canvas: Size, map: Size): Viewport => {
  const fitted = fitView(canvas, map);

  if (fitted.k >= OPEN_ZOOM) return fitted;

  return { x: (canvas.width - map.width * OPEN_ZOOM) / 2, y: MARGIN.top, k: OPEN_ZOOM };
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
