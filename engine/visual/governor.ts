/**
 * Performance governor. Spec §9.10.
 *
 * **Pure logic, injected clock** — `update(dtMs, now)` takes the timestamp, so
 * the whole state machine is unit-testable without a frame loop. `document.hidden`
 * arrives as a flag rather than being read, for the same reason.
 *
 * What it maintains:
 *   - `scale ∈ [0.55, tierMaxScale]` — dynamic resolution, applied to the
 *     renderer's pixel ratio;
 *   - `level ∈ [0..6]` — cumulative feature degradation, see `DEGRADATION`.
 *
 * The shape is a pair of hysteretic timers around a smoothed frame time, with
 * a cooldown on every change. Both timers are required to be *sustained*: a
 * single slow frame is not a trend, and reacting to one produces visible
 * oscillation, which is worse than being slow.
 */
import { clamp } from "../util/math";

/** Cumulative degradation steps, spec §9.10. Index === governor level. */
export interface DegradationStep {
  /** what this level disables or reduces */
  readonly what: string;
  /** chromatic aberration off (L1) */
  readonly chromaticAberration: boolean;
  /** bloom levels, -1 with a floor of 3 (L2) */
  readonly bloomLevelsDelta: number;
  /** orb ray-march steps, -2 with a floor of 3 (L3) */
  readonly orbStepsDelta: number;
  /** orb fbm octaves, forced to 2 from L3 */
  readonly orbOctavesOverride: number | null;
  /** dust draw range halved (L4) */
  readonly dustHalf: boolean;
  /** `maxPerSec` and particles-per-event ×0.7 (L5) */
  readonly eventRateFactor: number;
  /** bloom effect disabled entirely (L6) */
  readonly bloomDisabled: boolean;
}

function step(what: string, over: Partial<DegradationStep> = {}): DegradationStep {
  return {
    what,
    chromaticAberration: false,
    bloomLevelsDelta: 0,
    orbStepsDelta: 0,
    orbOctavesOverride: null,
    dustHalf: false,
    eventRateFactor: 1,
    bloomDisabled: false,
    ...over,
  };
}

/** Spec §9.10. Index 0 is "no degradation"; levels 1–6 are cumulative. */
export const DEGRADATION: readonly DegradationStep[] = [
  step("none"),
  step("L1 chromatic aberration off", { chromaticAberration: false }),
  step("L2 bloom levels -1 (min 3)", { bloomLevelsDelta: -1 }),
  step("L3 orb steps -2 (min 3), octaves 2", { orbStepsDelta: -2, orbOctavesOverride: 2 }),
  step("L4 dust draw range x0.5", { dustHalf: true }),
  step("L5 maxPerSec and particles x0.7", { eventRateFactor: 0.7 }),
  step("L6 bloom effect disabled", {
    bloomDisabled: true,
    chromaticAberration: false,
    bloomLevelsDelta: -1,
    orbStepsDelta: -2,
    orbOctavesOverride: 2,
    dustHalf: true,
    eventRateFactor: 0.7,
  }),
] as const;

/** Spec §9.10 constants. Named so tests can reference rather than restate. */
export const GOVERNOR = {
  /** EMA weight, spec §9.10 */
  emaAlpha: 0.05,
  /** frames ignored after a resize or visibility change */
  settleFrames: 3,
  /** ms — ignore anything above this, i.e. a tab switch or a GC pause */
  spikeMs: 250,
  /** ms — ignore the first this long after `start()` */
  warmupMs: 3000,
  /** smoothed frame time above this is "slow" */
  slowMs: 20,
  /** smoothed frame time below this is "fast". Hysteresis vs `slowMs`. */
  fastMs: 14.5,
  /** ms of sustained slowness before degrading */
  slowHoldMs: 1000,
  /** ms of sustained speed before improving */
  fastHoldMs: 4000,
  /** ms cooldown after any change */
  cooldownMs: 2000,
  /** cooldown specifically for improvements */
  improveCooldownMs: 4000,
  /** scale floor */
  minScale: 0.55,
  scaleDegradeStep: 0.1,
  scaleImproveStep: 0.05,
} as const;

export interface GovernorOptions {
  /** tier ceiling for `scale`, from `TIER_PARAMS[tier].maxRenderScale` */
  tierMaxScale: number;
  /** an explicit non-auto quality setting fixes the tier: no improving past it */
  pinned?: boolean;
  /** clock in ms; injected so tests do not need a frame loop */
  now?: () => number;
}

export interface GovernorFrame {
  /** smoothed frame time in ms */
  ema: number;
  scale: number;
  level: number;
  /** true when this frame changed something */
  changed: boolean;
}

export class Governor {
  private scale: number;
  private level = 0;

  private ema = 0;
  /** frames seen since the last resize/visibility change; used as a settle gate */
  private settle = GOVERNOR.settleFrames;
  private slowSince = 0;
  private fastSince = 0;
  private lastChange = 0;
  private startedAt = 0;
  private started = false;

  private tierMaxScale: number;
  private readonly pinned: boolean;
  private readonly clock: () => number;

  constructor(opts: GovernorOptions) {
    this.tierMaxScale = Math.max(GOVERNOR.minScale, opts.tierMaxScale);
    this.pinned = opts.pinned === true;
    this.clock = opts.now ?? (() => performance.now());
    this.scale = this.tierMaxScale;
    this.startedAt = this.clock();
  }

  get currentScale(): number {
    return this.scale;
  }

  get currentLevel(): number {
    return this.level;
  }

  get smoothedFrameMs(): number {
    return this.ema;
  }

  /** The degradation step in force. Cumulative — see `DEGRADATION`. */
  get degradation(): DegradationStep {
    return DEGRADATION[this.level] ?? DEGRADATION[0]!;
  }

  /**
   * Tell the governor the frame budget moved — a resize, a tab becoming
   * visible, a tier change. The next few frames are ignored, because the first
   * frame after a resize is always slow and would otherwise trigger a degrade.
   */
  onSettled(): void {
    this.settle = GOVERNOR.settleFrames;
  }

  /**
   * Feed one frame.
   *
   * @param dtMs frame delta in milliseconds
   * @param now  clock in ms
   * @param hidden whether the document is hidden
   */
  update(dtMs: number, now: number, hidden = false): GovernorFrame {
    if (!this.started) {
      this.started = true;
      this.startedAt = now;
    }

    // Ignored frames: tab switches, GC pauses, and the first frames after a
    // resize. Each of these is a measurement artefact, not a frame budget.
    if (dtMs > GOVERNOR.spikeMs || hidden || this.settle > 0) {
      if (this.settle > 0) this.settle--;
      return this.frame(false);
    }

    this.ema += GOVERNOR.emaAlpha * (dtMs - this.ema);

    if (now - this.startedAt < GOVERNOR.warmupMs) return this.frame(false);

    let changed = false;
    if (this.ema > GOVERNOR.slowMs) {
      this.fastSince = 0;
      if (this.slowSince === 0) this.slowSince = now;
      if (
        now - this.slowSince > GOVERNOR.slowHoldMs &&
        now - this.lastChange > GOVERNOR.cooldownMs
      ) {
        this.degrade();
        this.slowSince = 0;
        this.lastChange = now;
        changed = true;
      }
    } else if (this.ema < GOVERNOR.fastMs) {
      this.slowSince = 0;
      if (this.fastSince === 0) this.fastSince = now;
      if (
        now - this.fastSince > GOVERNOR.fastHoldMs &&
        now - this.lastChange > GOVERNOR.improveCooldownMs
      ) {
        this.improve();
        this.fastSince = 0;
        this.lastChange = now;
        changed = true;
      }
    } else {
      // Between the two thresholds: neither. Reset both, so the hold windows
      // measure sustained behaviour rather than the best run in a noisy stretch.
      this.slowSince = 0;
      this.fastSince = 0;
    }

    return this.frame(changed);
  }

  private frame(changed: boolean): GovernorFrame {
    return { ema: this.ema, scale: this.scale, level: this.level, changed };
  }

  /**
   * Spec §9.10 — resolution first, features only once resolution is spent.
   *
   * Dropping resolution is nearly invisible on a dark scene; dropping the orb's
   * ray-march steps is not. Doing them in this order means a device that is
   * slightly too slow loses sharpness rather than structure.
   */
  private degrade(): void {
    if (this.scale > GOVERNOR.minScale + 1e-6) {
      this.scale = Math.max(GOVERNOR.minScale, this.scale - GOVERNOR.scaleDegradeStep);
      return;
    }
    if (this.level < DEGRADATION.length - 1) this.level++;
  }

  /**
   * Spec §9.10 — features come back before resolution does, for the same
   * reason. A pinned quality setting refuses to improve past its tier's max.
   */
  private improve(): void {
    if (this.pinned) return;
    if (this.level > 0) {
      this.level--;
      return;
    }
    if (this.scale < this.tierMaxScale - 1e-6) {
      this.scale = Math.min(this.tierMaxScale, this.scale + GOVERNOR.scaleImproveStep);
    }
  }

  /**
   * Re-ceiling the scale when the tier changes (§8.12 allows a live tier
   * switch). Keeps the governor inside its new bounds immediately rather than
   * only on the next degrade.
   */
  setTierMaxScale(max: number): void {
    this.scale = clamp(max, GOVERNOR.minScale, Math.max(GOVERNOR.minScale, max));
    this.tierMaxScale = Math.max(GOVERNOR.minScale, max);
    this.level = 0;
  }

  /** Full reset, for `dispose()` and for the e2e harness. */
  reset(): void {
    this.scale = this.tierMaxScale;
    this.level = 0;
    this.ema = 0;
    this.settle = GOVERNOR.settleFrames;
    this.slowSince = 0;
    this.fastSince = 0;
    this.lastChange = 0;
    this.startedAt = this.clock();
    this.started = false;
  }
}
