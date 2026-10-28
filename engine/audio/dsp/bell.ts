/**
 * Bell — 2-operator FM, the "removal" voice. Spec §8.6.
 *
 * Cool and glassy by design: removals should feel like something dissolving
 * rather than something being dropped.
 *
 *   `y = e^(−t/τA) · sin(φc + I0·e^(−t/τI)·sin(φm))`,  with φm at `f · ratio`
 *
 * `p = [ratio, I0, tauA, tauI]`
 */
import { Voice, TAU } from "./voice";
import { VOICE_GAIN } from "../../config";

export class Bell extends Voice {
  private ratio = 3.5;
  private i0 = 2;
  private tauA = 1;
  private tauI = 0.35;
  private phC = 0;
  private phM = 0;
  private inc = 0;
  private incM = 0;
  // Incremental exponential decay (perf: spec section 12.1). exp(-t/tau) at a
  // fixed dt is exactly pow(exp(-dt/tau), n), so one multiply per sample
  // replaces one exp() per sample. Accumulated float drift over a 9 s note is
  // far below audibility, and the floor check avoids denormal slowdowns.
  private envA = 0;
  private envI = 0;
  private decayA = 1;
  private decayI = 1;

  override onStart(freq: number, vel: number, dur: number, p: Float64Array): void {
    this.freq = freq;
    this.vel = vel * VOICE_GAIN.bell;
    this.dur = dur;
    this.ratio = p[0] ?? 3.5;
    this.i0 = p[1] ?? 2;
    this.tauA = p[2] ?? 1;
    this.tauI = p[3] ?? 0.35;
    this.phC = 0;
    this.phM = 0;
    this.inc = TAU * freq * this.dt;
    this.incM = TAU * freq * this.ratio * this.dt;
    this.decayA = Math.exp(-this.dt / this.tauA);
    this.decayI = Math.exp(-this.dt / this.tauI);
    this.envA = 1;
    this.envI = 1;
    this.active = true;
  }

  protected override next(_t: number, _dt: number): number {
    this.phC += this.inc;
    if (this.phC > TAU) this.phC -= TAU;
    this.phM += this.incM;
    if (this.phM > TAU) this.phM -= TAU;

    this.envA *= this.decayA;
    this.envI *= this.decayI;
    if (this.envA < 1e-7) this.envA = 0;
    if (this.envI < 1e-7) this.envI = 0;
    const mod = Math.sin(this.phM) * this.i0 * this.envI;
    return this.envA * Math.sin(this.phC + mod);
  }
}
