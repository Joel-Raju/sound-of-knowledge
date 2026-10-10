/**
 * Frame-time and rate tracking. Spec §12.1 (p95 frame time, per-frame JS
 * budget), §11.9 (debug overlay at 4 Hz), §9.10 (governor input).
 *
 * All of these are updated once per frame from the rAF callback, so they must
 * not allocate. `NumericRing` owns the only storage.
 */

import { NumericRing } from "./ring-buffer";
import { smoothingCoefficient } from "./math";

/** Spec §12.1 — p95 frame time over a ~2 s window at 60 fps. */
export const FRAME_WINDOW = 240;

export class FrameStats {
  readonly frames: NumericRing;
  private emaMs = 16.7;
  private lastNow = 0;
  private started = false;

  /** Frames rendered since the last reset. */
  frameCount = 0;

  constructor(window = FRAME_WINDOW) {
    this.frames = new NumericRing(window);
  }

  /**
   * Feed one frame. Returns the frame delta in ms, clamped so a tab-switch or
   * GC pause does not poison the governor (spec §9.10 ignores > 250 ms spikes,
   * but clamping here keeps the EMA honest too).
   */
  tick(nowMs: number): number {
    if (!this.started) {
      this.started = true;
      this.lastNow = nowMs;
      return 0;
    }
    let dt = nowMs - this.lastNow;
    this.lastNow = nowMs;
    // A negative or absurd delta means the clock jumped (tab visibility, clock
    // adjustment). Report 0 rather than a nonsense value.
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    if (dt > 250) dt = 250;

    this.emaMs += 0.05 * (dt - this.emaMs); // spec §9.10: ema += 0.05 * (dt - ema)
    this.frames.push(dt);
    this.frameCount++;
    return dt;
  }

  get frameMsEma(): number {
    return this.emaMs;
  }

  get frameMsP95(): number {
    return this.frames.percentile(95);
  }

  get fps(): number {
    return this.emaMs > 0 ? 1000 / this.emaMs : 0;
  }

  reset(): void {
    this.frames.clear();
    this.started = false;
    this.emaMs = 16.7;
    this.frameCount = 0;
  }
}

/**
 * Spec §7.3 — exponential moving average of a per-second rate with a
 * time constant. Used for `accepted/sec` (τ = 6 s) and bot edits/sec.
 *
 * Not the same as `FrameStats`: this is driven by the 500 ms stats message,
 * not per frame.
 */
export class Ema {
  private value = 0;
  private readonly tau: number;

  constructor(tauSeconds: number, initial = 0) {
    this.tau = tauSeconds;
    this.value = initial;
  }

  /** Feed an instantaneous rate sample. `dtSec` is time since the last feed. */
  push(rate: number, dtSec: number): number {
    const a = smoothingCoefficient(dtSec, this.tau);
    this.value += (rate - this.value) * a;
    return this.value;
  }

  /** Jump straight to a value — used when seeding from a known initial state. */
  reset(v: number): void {
    this.value = v;
  }

  get current(): number {
    return this.value;
  }
}

/**
 * Spec §7.3 — convert a per-second rate to global energy E ∈ [0, 1]:
 *   `E = clamp(log10(1 + eps) / log10(1 + EPS_REF), 0, 1)`
 * with `epsRef` the calibrated reference rate (config.EPS_REF).
 *
 * E = 0 at zero throughput and E = 1 exactly at the reference rate, which is
 * what makes it comparable across sessions with wildly different traffic.
 */
export function rateToEnergy(eps: number, epsRef: number): number {
  if (eps <= 0) return 0;
  const denom = Math.log10(1 + epsRef);
  if (denom <= 0) return 0;
  const e = Math.log10(1 + eps) / denom;
  return e < 0 ? 0 : e > 1 ? 1 : e;
}

/**
 * Inverse of `rateToEnergy` — used by the offline render harness to pick a
 * synthetic `rateMul` that produces a target energy (§13.3).
 */
export function energyToRate(energy: number, epsRef: number): number {
  const e = energy < 0 ? 0 : energy > 1 ? 1 : energy;
  return Math.pow(10, e * Math.log10(1 + epsRef)) - 1;
}
