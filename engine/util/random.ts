/**
 * Seeded PRNG. Spec §6.7 (synthetic source must be deterministic given a
 * seed), §13.2 (mulberry32 determinism, mean ≈ 0.5 over 100k draws).
 *
 * mulberry32 is used because it is 32-bit, fast, has a long period, and —
 * critically for this project — produces identical streams in the worker, the
 * main thread, Node tests and Playwright, so replay fixtures are reproducible.
 */

export type Rng = () => number;

/** Create a mulberry32 generator. Returns values in [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform integer in [0, n). */
export function randInt(r: Rng, n: number): number {
  if (n <= 0) return 0;
  return Math.floor(r() * n) % n;
}

/** Uniform element from a non-empty array. Returns undefined for empty input. */
export function pick<T>(r: Rng, arr: readonly T[]): T | undefined {
  if (arr.length === 0) return undefined;
  return arr[randInt(r, arr.length)];
}

/**
 * Weighted choice. Spec §7.4: `rootPc += choose({+7:0.40, +5:0.40, +2:0.10, -3:0.10})`.
 * `weights` must be parallel to `values`. Returns undefined if `values` is empty.
 * Trailing weight deficit is ignored (last value wins by clamping).
 */
export function weighted<T>(
  r: Rng,
  values: readonly T[],
  weights: readonly number[],
): T | undefined {
  const n = values.length < weights.length ? values.length : weights.length;
  if (n === 0) return undefined;
  let total = 0;
  for (let i = 0; i < n; i++) total += weights[i]!;
  if (total <= 0) return values[0];
  let x = r() * total;
  for (let i = 0; i < n; i++) {
    x -= weights[i]!;
    if (x < 0) return values[i];
  }
  return values[n - 1];
}

/** Log-normal draw, clamped. Spec §6.7: `absDelta` log-normal, μ = ln(80), σ = 1.6. */
export function logNormal(r: Rng, mu: number, sigma: number, lo: number, hi: number): number {
  // Box–Muller; u is nudged off zero so log() stays finite.
  let u = r();
  while (u <= 1e-12) u = r();
  const v = r();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  const x = Math.exp(mu + sigma * z);
  return x < lo ? lo : x > hi ? hi : x;
}

/** Normal draw clamped to [lo, hi] — used for the spatial-mapper jitter. */
export function normal(r: Rng, mean: number, sd: number, lo: number, hi: number): number {
  let u = r();
  while (u <= 1e-12) u = r();
  const v = r();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  const x = mean + sd * z;
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * 2-D value noise with smoothstep interpolation, seeded. Used by the camera
 * rig for positional drift (spec §9.1: "smooth-noise positional drift ±0.15").
 * Stateless and deterministic for a given seed.
 */
export function makeValueNoise2D(seed: number): (x: number, y: number) => number {
  const perm = new Uint8Array(512);
  const r = mulberry32(seed);
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = randInt(r, i + 1);
    const t = perm[i]!;
    perm[i] = perm[j]!;
    perm[j] = t;
  }
  for (let i = 0; i < 256; i++) perm[256 + i] = perm[i]!;

  const grad = (ix: number, iy: number): number => {
    return perm[(perm[ix & 255]! + (iy & 255)) & 255]! / 255;
  };
  const fade = (t: number): number => t * t * (3 - 2 * t);

  return function noise2(x: number, y: number): number {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = fade(x - ix);
    const fy = fade(y - iy);
    const a = grad(ix, iy);
    const b = grad(ix + 1, iy);
    const c = grad(ix, iy + 1);
    const d = grad(ix + 1, iy + 1);
    const top = a + (b - a) * fx;
    const bot = c + (d - c) * fx;
    return (top + (bot - top) * fy) * 2 - 1; // → [-1, 1]
  };
}

/** xorshift32 — the per-voice noise generator inside the DSP voices (spec §8.6). */
export function xorshift32(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return function next(): number {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}
