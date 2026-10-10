/**
 * Voice base class. Spec §8.6.
 *
 * Pure DSP — no Web Audio globals, no DOM. That is what makes every voice
 * unit-testable offline in Node (§13.2) and what lets `scripts/bench.ts`
 * measure the real-time factor without a browser.
 *
 * **Allocation contract (spec §1.2):** `next()` runs inside the AudioWorklet's
 * `process()` loop and must not allocate. Every voice therefore keeps its
 * phase accumulators and noise state as instance fields, and `onStart()` (which
 * *is* allowed to allocate, because it runs in `port.onmessage`) prepares
 * whatever derived parameters the loop needs.
 */

/** Two pi. `ph` accumulators wrap against this (spec §8.6). */
export const TAU = Math.PI * 2;

/** Spec §8.6 — 3 ms fade-in and 30 ms fade-out, applied here for every voice. */
export const FADE_IN_SEC = 0.003;
export const FADE_OUT_SEC = 0.03;

export abstract class Voice {
  active = false;
  startFrame = 0;
  dur = 0;
  vel = 0;
  freq = 0;

  /** Sample rate, set once by the worklet. */
  sr = 48000;
  protected dt = 1 / 48000;

  /** Set by the worklet when the slot is configured (§8.5). */
  setSampleRate(sr: number): void {
    if (sr > 0) {
      this.sr = sr;
      this.dt = 1 / sr;
    }
  }

  /** One-time per trigger. Allocation permitted here, not in `next`. */
  abstract onStart(freq: number, vel: number, dur: number, p: Float64Array, seed: number): void;

  /** Raw voice sample at `t` seconds since start. No allocation. */
  protected abstract next(t: number, dt: number): number;

  /**
   * Envelope-wrapped sample. Deactivates the voice at `dur`, which is what
   * frees the slot in the worklet (§8.5).
   */
  sample(t: number, dt: number): number {
    if (t >= this.dur) {
      this.active = false;
      return 0;
    }
    const fin = Math.min(1, t / FADE_IN_SEC);
    const fout = Math.min(1, (this.dur - t) / FADE_OUT_SEC);
    return this.next(t, dt) * fin * fout * this.vel;
  }

  /** Reset to the idle state so a slot can be reused. */
  reset(): void {
    this.active = false;
    this.startFrame = 0;
    this.dur = 0;
    this.vel = 0;
    this.freq = 0;
  }
}

/**
 * Phase accumulator with wraparound. Inlined into voices rather than called so
 * `next()` stays branch-light, but kept here as the documented helper for tests
 * and for any voice that does not need the micro-optimisation.
 */
export function advancePhase(ph: number, freq: number, dt: number): number {
  let p = ph + TAU * freq * dt;
  if (p > TAU) p -= TAU;
  if (p < 0) p += TAU;
  return p;
}

/**
 * xorshift32 noise in [0,1), advanced one sample at a time.
 * Spec §8.6: "Noise uses a per-voice xorshift32 seeded from `seed`."
 */
export class Xorshift {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }

  /** Next value in [-1, 1). */
  next(): number {
    let s = this.s;
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    this.s = s;
    return s / 2147483648 - 1;
  }
}

/** Wrap a phase into [0, TAU) without a branch on the common path. */
export function wrapPhase(p: number): number {
  return p >= TAU || p < 0 ? p - Math.floor(p / TAU) * TAU : p;
}
