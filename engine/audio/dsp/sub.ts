/**
 * Sub — deep swell for very large edits. Spec §8.6.
 *
 *   `env = t < 0.06 ? sin²(π/2 · t/0.06) : e^(−(t−0.06)/1.1)`
 *   `f(t) = f · (1 + 0.012·e^(−t/0.4))`          (a short pitch drop)
 *   `y = env · tanh(1.4·(sin φ + 0.15·sin 2φ)) / tanh(1.4)`
 *   `dur = 4.0`
 *
 * The `tanh` stage is what stops a big rewrite from producing a *click* — the
 * raw sine would start and stop at full amplitude, and this voice fires on
 * some of the largest transients in the stream.
 */
import { Voice, TAU } from "./voice";
import {
  SUB_ATTACK_SEC,
  SUB_DECAY_TAU,
  SUB_DRIVE,
  SUB_HARMONIC_MIX,
  SUB_PITCH_BEND,
  SUB_PITCH_BEND_TAU,
  VOICE_GAIN,
} from "../../config";

/** 1 / tanh(DRIVE) — normalises output so peak ≈ 1 regardless of drive. */
const NORM = 1 / Math.tanh(SUB_DRIVE);

export class Sub extends Voice {
  private ph = 0;
  private inc = 0;
  // Incremental exponential decay (perf: spec section 12.1).
  private decayEnv = 1;
  private env = 0;
  private decayBend = 1;
  private bendEnv = 0;

  override onStart(freq: number, vel: number, dur: number): void {
    this.freq = freq;
    this.vel = vel * VOICE_GAIN.sub;
    this.dur = dur;
    this.ph = 0;
    this.inc = TAU * freq * this.dt;
    this.decayEnv = Math.exp(-this.dt / SUB_DECAY_TAU);
    this.decayBend = Math.exp(-this.dt / SUB_PITCH_BEND_TAU);
    // Both envelopes are 1 at t = 0 (and at the attack boundary for
    // `env`); they only ever shrink.
    this.env = 1;
    this.bendEnv = 1;
    this.active = true;
  }

  protected override next(t: number, _dt: number): number {
    // Envelope.
    let env: number;
    if (t < SUB_ATTACK_SEC) {
      const x = (t / SUB_ATTACK_SEC) * (Math.PI / 2);
      env = Math.sin(x) * Math.sin(x);
    } else {
      this.env *= this.decayEnv;
      env = this.env;
    }

    // Instantaneous frequency, with the decaying bend applied.
    this.bendEnv *= this.decayBend;
    const bend = SUB_PITCH_BEND * this.bendEnv;
    const inc = this.inc * (1 + bend);
    let p = this.ph + inc;
    if (p > TAU) p -= TAU;
    this.ph = p;

    const s = Math.sin(p) + SUB_HARMONIC_MIX * Math.sin(p * 2);
    return env * Math.tanh(SUB_DRIVE * s) * NORM;
  }
}
