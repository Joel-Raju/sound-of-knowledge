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
  /** Whether a previous cumulative total has been seen — see `update`. */
  private havePrevious = false;
  private lastAccepted = 0;
  private lastBotAccepted = 0;

  constructor() {
    this.epsEma = new Ema(ENERGY_TAU_SEC);
    this.botEma = new Ema(ENERGY_TAU_SEC);
  }

  /**
   * Feed one worker stats message (spec §6.5, every 500 ms).
   *
   * **The counters are CUMULATIVE.** `IngestCore.counters.accepted` is incremented per
   * event and never reset — it is a lifetime total, not a per-window count. So the
   * instantaneous rate is the *difference* between this message and the last one,
   * divided by the elapsed time.
   *
   * The first version divided the cumulative total by the window, which produced a
   * number that grew without bound: at 20 s the total was ~300 and the window 0.5 s,
   * so the "rate" was 600/s. `rateToEnergy` clamps to 1, so `E` was pinned at **1.000**
   * within seconds — which pinned the mode at lydian, the note density at its maximum,
   * and the pad's cutoff at its brightest.
   *
   * The bug was invisible until the tracker was *fed at all* (it never was — see
   * `Engine.onIngestStats`), and then it showed up as a saturated energy rather than as
   * an obviously wrong number.
   */
  update(stats: { accepted: number; botAccepted: number; windowMs: number }): void {
    const windowSec = Math.max(stats.windowMs, 1) / 1000;
    this.dtSec = windowSec;

    // First message: there is no previous total, so the rate is unknown. Seed the
    // EMAs with zero rather than dividing a lifetime total by a window.
    if (!this.havePrevious) {
      this.havePrevious = true;
      this.lastAccepted = stats.accepted;
      this.lastBotAccepted = stats.botAccepted;
      this.epsEma.push(0, windowSec);
      this.botEma.push(0, windowSec);
      return;
    }

    const dAccepted = Math.max(0, stats.accepted - this.lastAccepted);
    const dBot = Math.max(0, stats.botAccepted - this.lastBotAccepted);
    this.lastAccepted = stats.accepted;
    this.lastBotAccepted = stats.botAccepted;

    this.epsEma.push(dAccepted / windowSec, windowSec);
    this.botEma.push(dBot / windowSec, windowSec);
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
