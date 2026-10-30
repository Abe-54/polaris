/**
 * The Working strip's dither field, measured from Paper (02 · WORKING): 1px hue dots on a 2px
 * grid thinned by a Bayer threshold within ~140×40px of the top-left; and near the pointer, a
 * staggered lattice of `text-strong` dots with lighter hue dots trailing behind it. The tint
 * under it is CSS.
 */
import { noise1, noise3 } from "./noise";

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5] as const;

/** Dots are 1px on this pitch, in CSS px. */
export const DOT_PITCH = 2;

/** A corner dot's alpha (dark theme); every dot is the same weight, as in Paper. */
export const HUE_ALPHA = 0.29;

/** A trail dot's alpha, in the lighter hue. */
export const TRAIL_ALPHA = 0.55;

/** The corner's reach in px, and how much of the Bayer matrix its densest dot clears. */
export const CORNER = { rx: 140, ry: 40, gain: 0.95 } as const;

const SPARSE = { pitchX: 8, pitchY: 4, radius: 22, alpha: 0.6 } as const;

/** The trail is wide and flat, at most half its cells lit. */
const TRAIL = { sx: 16, sy: 4, decayMs: 420, strength: 0.5 } as const;

const BLOOM = { riseMs: 400, settleMs: 900, peak: 1.2 } as const;

/** How far the live threshold drifts, and the live edge's breath (±). */
const DRIFT = { amp: 0.09, cellX: 4, cellY: 2, steps: 8 } as const;

const BREATH = { depth: 0.07, steps: 30 } as const;

export const BLOOM_MS = BLOOM.riseMs + BLOOM.settleMs;

export interface Bloom {
  readonly gain: number;
  readonly spread: number;
}

export const RESTING: Bloom = { gain: CORNER.gain, spread: 1 };

const easeOut = (t: number) => 1 - (1 - t) ** 3;

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** The corner's gain and reach `ms` after a status change: it floods, then settles to rest. */
export function bloomAt(ms: number): Bloom {
  if (ms >= BLOOM_MS) return RESTING;

  if (ms < BLOOM.riseMs) {
    const t = easeOut(ms / BLOOM.riseMs);

    return { gain: mix(0, BLOOM.peak, t), spread: mix(0.5, 1.3, t) };
  }

  const t = easeOut((ms - BLOOM.riseMs) / BLOOM.settleMs);

  return { gain: mix(BLOOM.peak, CORNER.gain, t), spread: mix(1.3, 1, t) };
}

/** The corner texture's value (0–1) at a point, before the bloom's gain. */
export function cornerValue(x: number, y: number, spread: number): number {
  const dx = x / (CORNER.rx * spread);
  const dy = y / (CORNER.ry * spread);

  if (dx >= 1 || dy >= 1) return 0;
  const r = Math.sqrt(dx * dx + dy * dy);

  return r >= 1 ? 0 : 1 - r;
}

/** The lingering trail, one value per dot: stamped at the pointer, decaying everywhere. */
export class Trail {
  readonly values: Float32Array;
  private readonly previous: Float32Array;

  constructor(
    readonly columns: number,
    readonly rows: number
  ) {
    this.values = new Float32Array(columns * rows);
    this.previous = new Float32Array(columns * rows);
  }

  /** Decays by `dt` ms, then stamps the pointer; returns whether any dot visibly changed. */
  update(dt: number, x: number, y: number, strength: number): boolean {
    this.previous.set(this.values);
    this.decay(dt);
    this.stamp(x, y, strength);

    for (let at = 0; at < this.values.length; at++)
      if (Math.abs((this.values[at] ?? 0) - (this.previous[at] ?? 0)) > 1e-6) return true;

    return false;
  }

  decay(dt: number): void {
    const keep = Math.exp(-dt / TRAIL.decayMs);

    for (let at = 0; at < this.values.length; at++) {
      const v = (this.values[at] ?? 0) * keep;

      this.values[at] = v < 0.01 ? 0 : v;
    }
  }

  /** Raises the trail to a flat ellipse of `strength` around (x, y), in CSS px. */
  stamp(x: number, y: number, strength: number): void {
    if (strength <= 0) return;
    const i0 = Math.max(0, Math.floor((x - 3 * TRAIL.sx) / DOT_PITCH));
    const i1 = Math.min(this.columns - 1, Math.ceil((x + 3 * TRAIL.sx) / DOT_PITCH));
    const j0 = Math.max(0, Math.floor((y - 3 * TRAIL.sy) / DOT_PITCH));
    const j1 = Math.min(this.rows - 1, Math.ceil((y + 3 * TRAIL.sy) / DOT_PITCH));

    for (let j = j0; j <= j1; j++) {
      const dy = (j * DOT_PITCH - y) / TRAIL.sy;

      for (let i = i0; i <= i1; i++) {
        const dx = (i * DOT_PITCH - x) / TRAIL.sx;
        const v = TRAIL.strength * strength * Math.exp(-(dx * dx + dy * dy) / 2);
        const at = j * this.columns + i;

        if (v > (this.values[at] ?? 0)) this.values[at] = v;
      }
    }
  }
}

/** Whether a dot sits on the sparse lattice: rows 4px apart, every other row offset by 4px. */
export function onLattice(x: number, y: number): boolean {
  if (y % SPARSE.pitchY !== 0) return false;
  const offset = (y / SPARSE.pitchY) % 2 === 0 ? 0 : SPARSE.pitchX / 2;

  return (x - offset) % SPARSE.pitchX === 0;
}

/** A sparse dot's alpha around the pointer, dimming toward the patch's edge. */
export function sparseAlpha(x: number, y: number, frame: FieldFrame): number {
  if (frame.presence === 0 || !onLattice(x, y)) return 0;
  const d = Math.hypot(x - frame.pointer.x, y - frame.pointer.y) / SPARSE.radius;

  return d >= 1 ? 0 : frame.presence * SPARSE.alpha * (1 - 0.45 * d * d);
}

export interface FieldFrame {
  readonly bloom: Bloom;
  /** The live clock's step; 0 is the still frame (no drift). */
  readonly step: number;
  /** Seeds the drift, so two fields never move in step. */
  readonly seed: number;
  /** The corner's reach as it breathes, 1 at rest. */
  readonly breath: number;
  readonly trail: Trail | null;
  /** Where the sparse patch sits, in CSS px from the field's top-left. */
  readonly pointer: { readonly x: number; readonly y: number };
  /** 0 with no pointer, 1 fully hovered. */
  readonly presence: number;
}

export const STILL: FieldFrame = {
  bloom: RESTING,
  step: 0,
  seed: 0,
  breath: 1,
  trail: null,
  pointer: { x: 0, y: 0 },
  presence: 0,
};

/** Milliseconds per live step: the dither's 12 fps. */
export const LIVE_FRAME_MS = 83;

/** A live field's step and breath: the edge swells and eases on seeded noise, never in a loop. */
export function liveAt(step: number, seed: number): Pick<FieldFrame, "step" | "breath"> {
  if (step === 0) return { step, breath: 1 };

  return { step, breath: 1 + BREATH.depth * noise1(seed ^ 0x5bd1e995, step / BREATH.steps) };
}

const bayerAt = (i: number, j: number) => ((BAYER4[(j % 4) * 4 + (i % 4)] ?? 0) + 0.5) / 16;

/** The threshold dot (i, j) must clear: Bayer, nudged by seeded noise while live. */
export function threshold(i: number, j: number, frame: FieldFrame): number {
  const bayer = bayerAt(i, j);

  if (frame.step === 0) return bayer;

  const z = frame.step / DRIFT.steps;

  return bayer + DRIFT.amp * noise3(frame.seed, i / DRIFT.cellX, j / DRIFT.cellY, z);
}

/** Whether value `v` lights dot (i, j); only a value near its threshold needs the noise. */
export function clears(i: number, j: number, v: number, frame: FieldFrame): boolean {
  if (v <= 0) return false;
  const margin = v - bayerAt(i, j);

  if (frame.step === 0 || Math.abs(margin) > DRIFT.amp) return margin > 0;

  return threshold(i, j, frame) < v;
}

/** A corner dot's value (0–1) at dot (i, j), under the bloom and the breath. */
export function hueValue(i: number, j: number, frame: FieldFrame): number {
  const spread = frame.bloom.spread * frame.breath;

  return cornerValue(i * DOT_PITCH, j * DOT_PITCH, spread) * frame.bloom.gain;
}

/** A corner dot's alpha, or 0 where the threshold drops it. */
export function hueAlpha(i: number, j: number, frame: FieldFrame, alpha = HUE_ALPHA): number {
  const v = hueValue(i, j, frame);

  return clears(i, j, v, frame) ? alpha : 0;
}

/** The trail's value (0–1, at most its strength) at dot (i, j). */
export function trailValue(i: number, j: number, frame: FieldFrame): number {
  return frame.trail?.values[j * frame.trail.columns + i] ?? 0;
}

export type Rgb = readonly [number, number, number];

/** One RGBA pixel, packed for a little-endian Uint32Array over ImageData. */
export function packPixel(rgb: Rgb, alpha: number): number {
  return ((Math.round(alpha * 255) << 24) | (rgb[2] << 16) | (rgb[1] << 8) | rgb[0]) >>> 0;
}

export interface FieldColors {
  readonly hue: Rgb;
  /** The trail's lighter hue. */
  readonly trail: Rgb;
  readonly sparse: Rgb;
  readonly hueAlpha: number;
}

export interface FieldPixels {
  readonly pixels: Uint32Array;
  readonly width: number;
  readonly height: number;
}

interface Inks {
  readonly hue: number;
  readonly trail: number;
  readonly sparse: Rgb;
}

/** The pixel dot (i, j) paints, or 0: the pointer's lattice over the trail over the corner. */
function dotAt(i: number, j: number, frame: FieldFrame, inks: Inks) {
  const sparse = sparseAlpha(i * DOT_PITCH, j * DOT_PITCH, frame);

  if (sparse > 0) return packPixel(inks.sparse, sparse);

  if (clears(i, j, trailValue(i, j, frame), frame)) return inks.trail;

  return hueAlpha(i, j, frame) > 0 ? inks.hue : 0;
}

/** Paints a frame into `target`, one canvas pixel per CSS px: a 1px dot per 2px cell. */
export function paintFrame(target: FieldPixels, colors: FieldColors, frame: FieldFrame): void {
  const { pixels, width, height } = target;

  const inks = {
    hue: packPixel(colors.hue, colors.hueAlpha),
    trail: packPixel(colors.trail, TRAIL_ALPHA),
    sparse: colors.sparse,
  };

  pixels.fill(0);

  for (let y = 0; y < height; y += DOT_PITCH) {
    for (let x = 0; x < width; x += DOT_PITCH) {
      const dot = dotAt(x / DOT_PITCH, y / DOT_PITCH, frame, inks);

      if (dot !== 0) pixels[y * width + x] = dot;
    }
  }
}
