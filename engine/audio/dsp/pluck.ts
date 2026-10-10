/**
 * Pluck — 3-partial additive, the "addition" voice. Spec §8.6.
 *
 * Warm and harp/kalimba-like. Additions are the most common event in the
 * stream, so this voice carries most of the perceived warmth of the piece.
 *
 *   `freq_k = f · k · √(1 + 0.0004k²)`,  `amp = [1.0, 0.45, 0.20]`,
 *   `tau_k = tau1 / k`
 *   `y = Σ amp_k · e^(−t/τk) · sin(φk)`
 *
 * The slight inharmonic stretch is what stops it sounding like an organ: a
 * perfectly harmonic 2nd/3rd partial would read as a stopped pipe.
 *
 * `p = [tau1]`
 */
import { Voice, TAU } from "./voice";
import { PLUCK_PARTIAL_AMPS, VOICE_GAIN } from "../../config";

const N = 3;

/**
 * The spec's partial amplitudes are *relative* — they sum to 1.65, not 1 — so an
 * un-normalised pluck peaks at 1.65 before gain, and `VOICE_GAIN.pluck` stops
 * being a peak-level control. That breaks the §13.2 bound (peak ≤ 1.0 × gain ×
 * vel × 1.1) and makes the §8.4 mix targets untunable, because pluck would be
 * ~2× louder than its gain implies.
 *
 * Normalising by the amplitude sum preserves the spec's partial *ratios*
 * (relative amplitudes are all §8.6 actually specifies) while making the
 * stated gain meaningful. Logged in DECISIONS.md at T3.1.
 */
const AMP_SUM = (() => {
  let s = 0;
  for (let i = 0; i < N; i++) s += PLUCK_PARTIAL_AMPS[i] ?? 1;
  return s > 0 ? s : 1;
})();
const NORM = 1 / AMP_SUM;

export class Pluck extends Voice {
  private tau1 = 0.6;
  private readonly ph = new Float64Array(N);
  private readonly inc = new Float64Array(N);
  private readonly tau = new Float64Array(N);
  private readonly amp = new Float64Array(N);
  // Incremental exponential decay (perf: spec section 12.1): exp(-t/tau) at a
  // fixed dt is exactly pow(exp(-dt/tau), n), so one multiply replaces one
  // exp() per partial per sample.
  private readonly env = new Float64Array(N);
  private readonly decay = new Float64Array(N);

  override onStart(freq: number, vel: number, dur: number, p: Float64Array): void {
    this.freq = freq;
    this.vel = vel * VOICE_GAIN.pluck;
    this.dur = dur;
    this.tau1 = p[0] ?? 0.6;

    for (let k = 0; k < N; k++) {
      const kk = k + 1;
      // Partial frequencies precomputed in `onStart` (allocation is fine here).
      const fk = freq * kk * Math.sqrt(1 + 0.0004 * kk * kk);
      this.ph[k] = 0;
      this.inc[k] = TAU * fk * this.dt;
      this.tau[k] = this.tau1 / kk;
      this.decay[k] = Math.exp(-this.dt / this.tau[k]!);
      this.env[k] = 1;
      this.amp[k] = (PLUCK_PARTIAL_AMPS[k] ?? 1) * NORM;
    }
    this.active = true;
  }

  protected override next(t: number, _dt: number): number {
    let y = 0;
    for (let k = 0; k < N; k++) {
      let p = this.ph[k]! + this.inc[k]!;
      if (p > TAU) p -= TAU;
      this.ph[k] = p;
      let e = this.env[k]! * this.decay[k]!;
      if (e < 1e-7) e = 0;
      this.env[k] = e;
      y += this.amp[k]! * e * Math.sin(p);
    }
    return y;
  }
}
