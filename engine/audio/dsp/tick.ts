/**
 * Tick — the quieter bot voice. Spec §8.6.
 *
 *   `lp += 0.5·(x − lp);  y = (x − lp)·e^(−t/0.022)`
 *   `dur = 0.12`
 *
 * `x − lp` is the high-passed residual of the one-pole state, so this is a
 * high-passed noise burst with no pitch at all — a click, not a note. It is the
 * only voice the scheduler marks `visual: false` (§10.2): it carries rhythm,
 * not an event, so it gets no comet.
 */
import { Voice } from "./voice";
import { VOICE_GAIN } from "../../config";
import { TICK_DECAY_TAU, TICK_HP_A } from "../../config";

export class Tick extends Voice {
  private lp = 0;
  private noiseState = 0x9e3779b9;

  override onStart(_freq: number, vel: number, dur: number, _p: Float64Array, seed: number): void {
    this.vel = vel * VOICE_GAIN.tick;
    this.dur = dur;
    this.lp = 0;
    this.noiseState = seed >>> 0 || 0x9e3779b9;
    this.active = true;
  }

  protected override next(t: number, _dt: number): number {
    let s = this.noiseState;
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    this.noiseState = s;
    const x = s / 2147483648 - 1;

    this.lp += TICK_HP_A * (x - this.lp);
    return (x - this.lp) * Math.exp(-t / TICK_DECAY_TAU);
  }
}
