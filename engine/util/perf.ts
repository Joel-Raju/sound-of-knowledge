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

/**
 * Largest delta `tick()` will accept, ms.
 *
 * Spec §9.10 ignores anything above 250 ms as a tab switch or GC pause. Clamping
 * at the same threshold keeps the EMA honest: without it, one long stall would
 * drag the average for minutes afterwards.
 */
export const MAX_FRAME_DT_MS = 250;

/** EMA weight for frame time. Spec §9.10: `ema += 0.05 * (dt - ema)`. */
export const FRAME_EMA_ALPHA = 0.05;

export class FrameStats {
  readonly frames: NumericRing;
  private emaMs = 16.7;
  private lastNow = 0;
  private started = false;

  /** Frames rendered since the last reset. */
  frameCount = 0;

  /** Rolling 1-second average, used for the HUD's fps readout (§11.3). */
  private fpsAccum = 0;
  private fpsCount = 0;
  private fpsWindowAt = 0;
  private fpsValue = 0;

  constructor(window = FRAME_WINDOW) {
    this.frames = new NumericRing(window);
  }

  /**
   * Feed one frame from rAF timestamps. Returns the frame delta in ms.
   *
   * Callers that already compute and clamp their own delta — the visual renderer
   * does, because the camera, the palette and the governor all share that clamp
   * — should call `push` instead, so every consumer sees the same number.
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
    if (dt > MAX_FRAME_DT_MS) dt = MAX_FRAME_DT_MS;

    this.push(dt, nowMs);
    return dt;
  }

  /**
   * Record an already-computed frame delta, in ms.
   *
   * @param dtMs  frame delta; non-finite and non-positive values are dropped
   * @param nowMs optional clock, used only for the 1 s fps average. Omitting it
   *              leaves `fpsWindowed` untouched, which is what a synthetic
   *              caller replaying a fixed dt wants.
   * @returns the recorded delta, after the sanity filter
   */
  push(dtMs: number, nowMs?: number): number {
    if (!Number.isFinite(dtMs) || dtMs <= 0) return 0;

    this.emaMs += FRAME_EMA_ALPHA * (dtMs - this.emaMs); // spec §9.10
    this.frames.push(dtMs);
    this.frameCount++;

    if (nowMs !== undefined && Number.isFinite(nowMs)) {
      if (this.fpsWindowAt === 0) this.fpsWindowAt = nowMs;
      this.fpsAccum += dtMs;
      this.fpsCount++;
      if (nowMs - this.fpsWindowAt >= 1000) {
        const mean = this.fpsAccum / Math.max(1, this.fpsCount);
        this.fpsValue = mean > 0 ? 1000 / mean : 0;
        this.fpsAccum = 0;
        this.fpsCount = 0;
        this.fpsWindowAt = nowMs;
      }
    }
    return dtMs;
  }

  get frameMsEma(): number {
    return this.emaMs;
  }

  get frameMsP95(): number {
    return this.frames.percentile(95);
  }

  /** Median frame time — see `NumericRing.median` for why it pairs with p95. */
  get frameMsMedian(): number {
    return this.frames.median();
  }

  get frameMsMean(): number {
    return this.frames.mean;
  }

  /** Samples retained, saturating at the window size. */
  get sampleCount(): number {
    return this.frames.length;
  }

  /**
   * fps derived from the smoothed frame time — available from the first frame.
   *
   * `fpsWindowed` is the measured 1 s average, which is steadier but reads 0
   * until a full second has elapsed. The HUD shows the latter once it has one.
   */
  get fps(): number {
    return this.emaMs > 0 ? 1000 / this.emaMs : 0;
  }

  /** Measured 1 s average; 0 until the first full window completes. */
  get fpsWindowed(): number {
    return this.fpsValue;
  }

  reset(): void {
    this.frames.clear();
    this.started = false;
    this.emaMs = 16.7;
    this.frameCount = 0;
    this.fpsAccum = 0;
    this.fpsCount = 0;
    this.fpsWindowAt = 0;
    this.fpsValue = 0;
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
