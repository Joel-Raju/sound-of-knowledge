/**
 * Energy tracking and note budgeting. Spec §7.3.
 *
 * `E` is the single number that ties data density to everything musical and
 * visual: it picks the mode and palette, opens the pad filter, scales the
 * sub-bass and air noise, and sets the target note rate. It is derived from the
 * **accepted** (post-filter) event rate, so it reflects what the audience is
 * actually hearing rather than raw upstream volume.
 */
import {
  BOT_REF,
  DENSITY_MUL,
  ENERGY_TAU_SEC,
  EPS_REF,
  NOTES_PER_SEC_MAX,
  NOTES_PER_SEC_MIN,
} from "../config";
import { Ema, rateToEnergy } from "../util/perf";
import { clamp, lerp } from "../util/math";
import type { Settings } from "../types";

export class EnergyTracker {
  private readonly epsEma: Ema;
  private readonly botEma: Ema;
  private dtSec = 0;

  constructor() {
    this.epsEma = new Ema(ENERGY_TAU_SEC);
    this.botEma = new Ema(ENERGY_TAU_SEC);
  }

  /** Feed one worker stats message (spec §6.5, every 500 ms). */
  update(stats: { accepted: number; botAccepted: number; windowMs: number }): void {
    const windowSec = Math.max(stats.windowMs, 1) / 1000;
    this.dtSec = windowSec;
    this.epsEma.push(stats.accepted / windowSec, windowSec);
    this.botEma.push(stats.botAccepted / windowSec, windowSec);
  }

  /** Accepted events per second (EMA, τ = 6 s). */
  get eps(): number {
    return this.epsEma.current;
  }

  /** Bot edits per second (EMA, τ = 6 s). */
  get botPerSec(): number {
    return this.botEma.current;
  }

  /** Bot activity normalised against `BOT_REF`, clamped to [0,1]. */
  get botNorm(): number {
    return clamp(this.botPerSec / BOT_REF, 0, 1);
  }

  /**
   * Global energy `E` in [0,1]. §7.3:
   *   `clamp(log10(1 + eps) / log10(1 + EPS_REF), 0, 1)`
   */
  get E(): number {
    return rateToEnergy(this.eps, EPS_REF);
  }

  /**
   * Target melodic notes per second. §7.3:
   *   `lerp(1.2, 6.0, E) * densityMul`, where densityMul is 0.6/1.0/1.5.
   */
  targetNotesPerSec(density: Settings["density"]): number {
    const mul = DENSITY_MUL[density] ?? 1;
    return lerp(NOTES_PER_SEC_MIN, NOTES_PER_SEC_MAX, this.E) * mul;
  }
}
