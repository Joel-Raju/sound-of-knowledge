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

  /**
   * ms — ceiling for a *synchronised* sample, which is a different measurement.
   *
   * `spikeMs` is sized for rAF deltas, where anything past a quarter-second is a tab
   * switch or a GC pause. A synced sample is the real GPU cost of a frame, and a frame
   * that genuinely takes 550 ms is not an artefact — it is exactly the condition the
   * governor exists to notice. Reusing `spikeMs` here would discard the measurements
   * that matter most, which is how the blind spot would survive the fix for it.
   */
  syncedSpikeMs: 2000,

  /**
   * How many frames between synchronised samples.
   *
   * The sample forces completion with a 1×1 `readPixels`, which is a pipeline stall:
   * cheap as a rule, but not free, and taking it every frame would make the governor's
   * own measurement part of the load it is measuring. Every 30 frames is ~0.5 s at
   * 60 fps — inside §9.10's 1000 ms `slowHoldMs`, so a genuinely slow scene still
   * accumulates enough synced evidence to degrade, while a fast one pays 3 % overhead.
   */
  syncedStrideFrames: 30,
  /**
   * Seconds — the smoothing time constant the synced channel is normalised to.
   *
   * §9.10's `emaAlpha` of 0.05 is *per frame*, which at 60 fps is a ~0.33 s constant.
   * Reusing it per-sample would stretch the synced channel's constant 30-fold, since
   * it only receives a sample every `syncedStrideFrames` frames — recovery from a slow
   * GPU would then take ~20 s, long enough that the piece looks stuck. Deriving the
   * factor from the stride keeps both channels settling in the same wall-clock time.
   */
  emaTauSec: 1 / (0.05 * 60),
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
  /**
   * EMA of the *synchronised* samples — the real GPU cost of a frame.
   *
   * Kept separate from `ema` rather than folded in, for two reasons. The spike
   * ceilings differ (`spikeMs` 250 for rAF deltas, `syncedSpikeMs` 2000 for these),
   * because a 550 ms frame is an artefact when it is a GC pause and the whole point
   * when it is the GPU. And the channels are sampled at different rates — every frame
   * versus every `syncedStrideFrames` — so they cannot share a recurrence.
   */
  private emaSynced = 0;
  /** true once at least one synced sample has landed; gates the max() below. */
  private hasSynced = false;
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
   * @param dtMs frame delta in milliseconds, from rAF
   * @param now  clock in ms
   * @param hidden whether the document is hidden
   * @param syncedMs cost of the last synchronised frame in ms, or `null` on frames
   *   where no sample was taken. See `GOVERNOR.syncedStrideFrames`.
   *
   * **Two channels, acted on as their maximum.** rAF deltas report how fast the main
   * thread issues commands; under a GPU-bound load Chromium keeps rAF at the vsync
   * interval anyway, so that number stops moving while the real frame cost climbs. The
   * measurement in `DECISIONS.md` shows the consequence at high tier: rAF reads 86 ms
   * while a synchronised frame costs 550 ms — and because vsync pins rAF, the figure
   * the governor sees *improves* as the scene gets worse, 86 ms at high tier against
   * 47 ms at low. Taking the max of the two removes the blind spot in the only
   * direction that matters: a sample can only ever make the governor more cautious.
   */
  update(dtMs: number, now: number, hidden = false, syncedMs: number | null = null): GovernorFrame {
    if (!this.started) {
      this.started = true;
      this.startedAt = now;
    }

    // Ignored frames: tab switches, GC pauses, and the first frames after a
    // resize. Each of these is a measurement artefact, not a frame budget.
    const ignoreThisFrame = dtMs > GOVERNOR.spikeMs || hidden || this.settle > 0;
    if (ignoreThisFrame) {
      if (this.settle > 0) this.settle--;
      return this.frame(false);
    }

    this.ema += GOVERNOR.emaAlpha * (dtMs - this.ema);

    // The synced channel is gated independently: its own (much higher) spike
    // ceiling, and it does not consume a settle frame when it is dropped, because
    // a spike-sized rAF delta says nothing about whether the synced sample is sound.
    if (
      syncedMs !== null &&
      Number.isFinite(syncedMs) &&
      syncedMs <= GOVERNOR.syncedSpikeMs &&
      !hidden &&
      !ignoreThisFrame
    ) {
      // Seed on the first sample rather than easing up from 0. An EMA seeded at 0
      // needs ~20 samples to reach its true value, which at a 30-frame stride is
      // 10 seconds — longer than the governor's own cooldowns, so the first real
      // signal would arrive after it had already been ignored.
      //
      // The factor is scaled by the stride rather than reused from `emaAlpha`:
      // that one is per-frame, and applying it per-sample would make this channel
      // 30× slower to settle than the rAF channel it is compared against.
      const alpha = 1 - Math.exp(-(GOVERNOR.syncedStrideFrames / 60) / GOVERNOR.emaTauSec);
      this.emaSynced = this.hasSynced
        ? this.emaSynced + alpha * (syncedMs - this.emaSynced)
        : syncedMs;
      this.hasSynced = true;
    }

    const ema = this.effectiveEma();

    if (now - this.startedAt < GOVERNOR.warmupMs) return this.frame(false);

    let changed = false;
    if (ema > GOVERNOR.slowMs) {
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
    } else if (ema < GOVERNOR.fastMs) {
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

  /**
   * The frame time the governor actually acts on: the worse of the two channels.
   *
   * Before any synced sample has landed this is just the rAF EMA, so behaviour with
   * `syncedMs` never passed is exactly what §9.10 specifies — the channel is additive,
   * not a replacement.
   */
  private effectiveEma(): number {
    return this.hasSynced ? Math.max(this.ema, this.emaSynced) : this.ema;
  }

  private frame(changed: boolean): GovernorFrame {
    return { ema: this.effectiveEma(), scale: this.scale, level: this.level, changed };
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
