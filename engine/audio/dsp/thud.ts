/**
 * Thud — the bot voice. Spec §8.6.
 *
 *   `f(t) = 48 + 90·e^(−t/0.03)`   (phase integrates f(t))
 *   `y = sin φ · e^(−t/0.11) + 0.25·lp(noise)·e^(−t/0.004)`,  lp one-pole a = 0.2
 *   `dur = 0.45`
 *
 * Because bots really are mechanical, this is what gives the piece a pulse.
 * The pitch envelope (48 Hz → 138 Hz in 30 ms) is what makes it read as a
 * *thud* rather than a click; without it the transient is too short to carry
 * any body at all.
 */
import { Voice, TAU } from "./voice";
import { VOICE_GAIN } from "../../config";
import {
  THUD_DECAY_TAU,
  THUD_F0,
  THUD_LP_A,
  THUD_NOISE_MIX,
  THUD_PITCH_JUMP,
  THUD_PITCH_TAU,
  THUD_TRANSIENT_TAU,
} from "../../config";

export class Thud extends Voice {
  private ph = 0;
  private lp = 0;
  private noiseState = 0x9e3779b9;

  override onStart(_freq: number, vel: number, dur: number, _p: Float64Array, seed: number): void {
    this.vel = vel * VOICE_GAIN.thud;
    this.dur = dur;
    this.ph = 0;
    this.lp = 0;
    this.noiseState = seed >>> 0 || 0x9e3779b9;
    this.active = true;
  }

  protected override next(t: number, dt: number): number {
    // Integrate the pitch envelope each sample (spec §8.6).
    const f = THUD_F0 + THUD_PITCH_JUMP * Math.exp(-t / THUD_PITCH_TAU);
    let p = this.ph + TAU * f * dt;
    if (p > TAU) p -= TAU;
    this.ph = p;

    // One-pole low-passed noise for the beater click.
    let s = this.noiseState;
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    this.noiseState = s;
    const x = s / 2147483648 - 1;
    this.lp += THUD_LP_A * (x - this.lp);

    return (
      Math.sin(p) * Math.exp(-t / THUD_DECAY_TAU) +
      THUD_NOISE_MIX * this.lp * Math.exp(-t / THUD_TRANSIENT_TAU)
    );
  }
}
