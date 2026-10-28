/** Small math helpers. Spec §13.2 (`util/math`). */

export const TAU = Math.PI * 2;
export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // spec §7.9

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Inverse lerp; returns 0 when the range is degenerate rather than NaN. */
export function invLerp(a: number, b: number, v: number): number {
  return b === a ? 0 : (v - a) / (b - a);
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1));
  return t * t * (3 - 2 * t);
}

export function easeOutCubic(t: number): number {
  const u = 1 - clamp01(t);
  return 1 - u * u * u;
}

export function easeInOutCubic(t: number): number {
  const u = clamp01(t);
  return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
}

/**
 * Sum of three uniforms centred on 0, scaled to ~unit standard deviation.
 * Spec §7.7 uses `gaussian(0, 0.8)` for pitch jitter; this is cheaper and
 * bounded compared to Box–Muller, and boundedness matters in a scheduler that
 * must never produce a wild pitch index.
 */
export function gaussianish(r: () => number): number {
  return (r() + r() + r() - 1.5) / 1.5;
}

/** Box–Muller, for callers that genuinely need tails. Allocates nothing hot-path-wise. */
export function gaussian(r: () => number): number {
  let u = 0;
  while (u === 0) u = r();
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
}

/**
 * Time-constant smoothing factor for exponential smoothing:
 * `a = 1 - exp(-dt / tau)` (spec §8.10, §9.1).
 * Guarded so dt = 0 yields 0 (no change) rather than NaN.
 */
export function smoothingCoefficient(dt: number, tau: number): number {
  if (tau <= 0) return 1;
  if (dt <= 0) return 0;
  return 1 - Math.exp(-dt / tau);
}

/** Frame-rate independent exponential approach: move `current` toward `target`. */
export function expApproach(current: number, target: number, dt: number, tau: number): number {
  if (tau <= 0) return target; // tau = 0 means "jump immediately"
  if (dt <= 0) return current;
  return target + (current - target) * Math.exp(-dt / tau);
}

/** Wrap `v` into [0, n) for non-negative n; returns 0 for n <= 0. */
export function wrap(v: number, n: number): number {
  if (n <= 0) return 0;
  const r = v % n;
  return r < 0 ? r + n : r;
}

/** Modulo difference into (-n/2, n/2]; used for phase wrapping. */
export function wrapDelta(v: number, n: number): number {
  if (n <= 0) return 0;
  return v - Math.round(v / n) * n;
}

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function freqToMidi(freq: number): number {
  return 69 + 12 * Math.log2(freq / 440);
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export function gainToDb(gain: number): number {
  return 20 * Math.log10(Math.max(gain, 1e-12));
}

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
