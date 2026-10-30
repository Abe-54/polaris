/** Seeded value noise for the live field: smooth, aperiodic, so its motion never loops. */
function hash(seed: number, x: number, y: number, z: number): number {
  let h = seed ^ Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(z, 0x1b873593);

  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);

  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t: number) => t * t * (3 - 2 * t);

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Noise in [-1, 1] along `t`, eased between random values at whole `t`. */
export function noise1(seed: number, t: number): number {
  const i = Math.floor(t);

  return lerp(hash(seed, i, 0, 0), hash(seed, i + 1, 0, 0), fade(t - i)) * 2 - 1;
}

/** Noise in [-1, 1] over (x, y, z), trilinear between random values on the whole lattice. */
export function noise3(seed: number, x: number, y: number, z: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const fx = fade(x - x0);
  const fy = fade(y - y0);
  const fz = fade(z - z0);

  const plane = (z: number) =>
    lerp(
      lerp(hash(seed, x0, y0, z), hash(seed, x0 + 1, y0, z), fx),
      lerp(hash(seed, x0, y0 + 1, z), hash(seed, x0 + 1, y0 + 1, z), fx),
      fy
    );

  return lerp(plane(z0), plane(z0 + 1), fz) * 2 - 1;
}

/** A fresh seed for a field, so two strips never shimmer in step. */
export const randomSeed = (): number => Math.floor(Math.random() * 4294967296) >>> 0;
