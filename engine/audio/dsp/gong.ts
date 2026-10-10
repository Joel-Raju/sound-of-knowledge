/**
 * Gong — 7-partial inharmonic additive, the "revert" voice. Spec §8.6.
 *
 *   `ratios = [1.00, 2.00, 2.76, 4.07, 5.40, 6.99, 8.93]`
 *   `amps   = [1.00, 0.60, 0.55, 0.35, 0.30, 0.20, 0.12]`
 *   `tau_k  = tau0 / (1 + 0.55k)`
 *   each partial = `0.5·(sin φk + sin φ'k)`,  φ'k at `f·ratio_k + shimmer·(1 + 0.13k)`
 *   `y = Σ amps_k·e^(−t/τk)·partial_k + 0.15·noise·e^(−t/0.012)`
 *   `dur = 9.0`
 *
 * The ratios are deliberately *not* harmonic — that is what makes it metallic
 * rather than pitched. The beating pair per partial plus a slow shimmer give it
 * the sense of being much larger than the 48–60 Hz root it is played at.
 *
 * `p = [tau0, shimmerHz]` = `[4.5, 0.7]`
 */
import { Voice, TAU } from "./voice";
import {
  GONG_AMPS,
  GONG_RATIOS,
  GONG_SHIMMER_HZ,
  GONG_TAU0,
  GONG_TAU_K_FALLOFF,
  GONG_TRANSIENT,
  GONG_TRANSIENT_TAU,
  VOICE_GAIN,
} from "../../config";

const N = 7;

/**
 * The gong's partial amplitudes are relative and sum to 3.12, so un-normalised
 * it peaks at 3.12 before gain — which would make `VOICE_GAIN.gong = 0.12` a
 * fiction and put the gong 2.7× above the §13.2 peak bound. Normalising by the
 * sum keeps the spec's partial *ratios* and the strike-transient mix intact
 * while making the stated gain the actual peak control. Same reasoning and
 * same log entry as `pluck.ts` (DECISIONS.md, T3.1).
 */
const AMP_SUM = (() => {
  let s = 0;
  for (let k = 0; k < N; k++) s += GONG_AMPS[k] ?? 1;
  return s > 0 ? s : 1;
})();
const NORM = 1 / AMP_SUM;
/** Keep the transient at the spec's absolute 0.15 relative to the normalised body. */
const TRANSIENT = GONG_TRANSIENT * NORM;

export class Gong extends Voice {
  private readonly ph = new Float64Array(N);
  private readonly phS = new Float64Array(N);
  private readonly inc = new Float64Array(N);
  private readonly incS = new Float64Array(N);
  private readonly tau = new Float64Array(N);
  private readonly amp = new Float64Array(N);
  // Incremental exponential decay (perf: spec section 12.1). The gong is the
  // most expensive voice -- 7 partials -- so replacing one exp() per partial
  // per sample with one multiply is the single biggest win in the worklet.
  private readonly env = new Float64Array(N);
  private readonly decay = new Float64Array(N);
  private envTransient = 0;
  private decayTransient = 1;
  private noiseState = 0x9e3779b9;

  override onStart(freq: number, vel: number, dur: number, p: Float64Array, seed: number): void {
    this.freq = freq;
    this.vel = vel * VOICE_GAIN.gong;
    this.dur = dur;
    const tau0 = p[0] ?? GONG_TAU0;
    const shimmer = p[1] ?? GONG_SHIMMER_HZ;

    for (let k = 0; k < N; k++) {
      const ratio = GONG_RATIOS[k] ?? 1;
      this.ph[k] = 0;
      this.phS[k] = 0;
      this.inc[k] = TAU * freq * ratio * this.dt;
      this.incS[k] = TAU * (freq * ratio + shimmer * (1 + 0.13 * k)) * this.dt;
      this.tau[k] = tau0 / (1 + GONG_TAU_K_FALLOFF * k);
      this.decay[k] = Math.exp(-this.dt / this.tau[k]!);
      this.env[k] = 1;
      this.amp[k] = (GONG_AMPS[k] ?? 1) * NORM;
    }
    this.decayTransient = Math.exp(-this.dt / GONG_TRANSIENT_TAU);
    this.envTransient = 1;
    this.noiseState = seed >>> 0 || 0x9e3779b9;
    this.active = true;
  }

  protected override next(t: number, _dt: number): number {
    let y = 0;
    for (let k = 0; k < N; k++) {
      let a = this.ph[k]! + this.inc[k]!;
      if (a > TAU) a -= TAU;
      this.ph[k] = a;
      let b = this.phS[k]! + this.incS[k]!;
      if (b > TAU) b -= TAU;
      this.phS[k] = b;
      let e = this.env[k]! * this.decay[k]!;
      if (e < 1e-7) e = 0;
      this.env[k] = e;
      y += this.amp[k]! * e * 0.5 * (Math.sin(a) + Math.sin(b));
    }

    // Strike transient.
    let s = this.noiseState;
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    this.noiseState = s;
    const n = s / 2147483648 - 1;
    this.envTransient *= this.decayTransient;
    return y + TRANSIENT * n * this.envTransient;
  }
}
