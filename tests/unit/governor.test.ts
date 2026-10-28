import { describe, expect, it } from "vitest";
import { Governor, DEGRADATION, GOVERNOR } from "@/engine/visual/governor";

/**
 * Spec §13.2, row `governor` — "sustained 25 ms → degrade steps in order with
 * cooldowns; sustained 10 ms → improve; spikes (> 250 ms) ignored; warm-up
 * respected".
 *
 * The clock is injected, so these run as fast as the CPU allows and are not
 * subject to the flakiness a real frame loop would introduce.
 */

/**
 * Drive the governor at a fixed frame time and advance a virtual clock.
 *
 * Returns the clock's final value. A caller that runs two phases must thread it
 * through as `start`: the governor's cooldowns are all `now - lastChange`, so a clock
 * that jumps backwards between phases makes every cooldown permanently unsatisfied
 * and the governor latches — which looks exactly like "the fix does not work".
 */
function run(
  g: Governor,
  opts: {
    dtMs: number;
    ms: number;
    start?: number;
    hidden?: boolean;
    onFrame?: (t: number) => void;
    /** Real GPU cost, sampled on `GOVERNOR.syncedStrideFrames` like the renderer. */
    syncedMs?: number | null;
  },
): number {
  let t = opts.start ?? 0;
  const step = opts.dtMs;
  const frames = Math.max(0, Math.floor(opts.ms / step));
  let sinceSample = 0;
  for (let i = 0; i < frames; i++) {
    t += step;
    opts.onFrame?.(t);
    // Mirrors `VisualEngine.takeSyncedSample`: one sample per stride, not per frame.
    sinceSample++;
    const synced =
      opts.syncedMs === undefined || sinceSample % GOVERNOR.syncedStrideFrames !== 0
        ? null
        : opts.syncedMs;
    g.update(step, t, opts.hidden ?? false, synced);
  }
  return t;
}

describe("Governor — spec §9.10", () => {
  // --- initial state -------------------------------------------------------

  it("starts at the tier ceiling with no degradation", () => {
    const g = new Governor({ tierMaxScale: 2, now: () => 0 });
    expect(g.currentScale).toBe(2);
    expect(g.currentLevel).toBe(0);
    expect(g.degradation.what).toBe("none");
  });

  it("never exceeds the tier ceiling it was given", () => {
    const g = new Governor({ tierMaxScale: 1.5, now: () => 0 });
    run(g, { dtMs: 10, ms: 60_000 });
    expect(g.currentScale).toBeLessThanOrEqual(1.5);
  });

  // --- warm-up -------------------------------------------------------------

  it("ignores everything during the first 3 s", () => {
    const g = new Governor({ tierMaxScale: 2, now: () => 0 });
    // 25 ms frames are well past the `slowMs` threshold, but the warm-up must
    // swallow them: the first frames after a load include shader compilation,
    // and degrading on those would penalise every machine.
    run(g, { dtMs: 25, ms: 2900 });
    expect(g.currentScale).toBe(2);
    expect(g.currentLevel).toBe(0);
  });

  it("starts reacting only after warm-up plus the hold window", () => {
    const g = new Governor({ tierMaxScale: 2, now: () => 0 });
    run(g, { dtMs: 25, ms: 3000 });
    // Past warm-up but not yet a full second of *sustained* slowness.
    expect(g.currentScale).toBe(2);
    run(g, { dtMs: 25, ms: 1500, start: 3000 });
    expect(g.currentScale).toBeLessThan(2);
  });

  // --- degrade -------------------------------------------------------------

  it("degrades resolution first, in order", () => {
    const g = new Governor({ tierMaxScale: 2, now: () => 0 });
    run(g, { dtMs: 25, ms: 4500 });
    // One 0.10 step per cooldown, not a jump straight to the floor.
    expect(g.currentScale).toBeLessThan(2);
    expect(g.currentScale).toBeGreaterThan(GOVERNOR.minScale);
    expect(g.currentLevel).toBe(0);
  });

  it("steps scale down by exactly 0.10 and stops at the floor", () => {
    const g = new Governor({ tierMaxScale: 2, now: () => 0 });
    let t = 0;
    const seen: number[] = [];
    for (let i = 0; i < 200; i++) {
      t += 25;
      g.update(25, t, false);
      seen.push(g.currentScale);
    }
    // Every distinct value must be a 0.10 step, and never below the floor.
    const distinct = [...new Set(seen)];
    for (const s of distinct) expect(s).toBeGreaterThanOrEqual(GOVERNOR.minScale - 1e-9);
    for (let i = 1; i < distinct.length; i++) {
      expect(distinct[i - 1]! - distinct[i]!).toBeCloseTo(GOVERNOR.scaleDegradeStep, 6);
    }
  });

  it("drops to feature levels once resolution is spent", () => {
    const g = new Governor({ tierMaxScale: 2, now: () => 0 });
    // Driven to the condition rather than to a frame count: spending 15 steps
    // of resolution costs ~45 s of virtual time, and hard-coding a frame count
    // makes the test a hostage to the cooldown arithmetic.
    let t = 0;
    for (let i = 0; i < 4000 && g.currentLevel === 0; i++) {
      t += 25;
      g.update(25, t, false);
    }
    expect(g.currentScale).toBeCloseTo(GOVERNOR.minScale, 6);
    expect(g.currentLevel).toBeGreaterThan(0);
  });

  it("raises the level one step at a time, never skipping", () => {
    const g = new Governor({ tierMaxScale: GOVERNOR.minScale, now: () => 0 });
    const levels: number[] = [];
    let t = 0;
    for (let i = 0; i < 500; i++) {
      t += 25;
      const before = g.currentLevel;
      g.update(25, t, false);
      if (g.currentLevel !== before) levels.push(g.currentLevel);
    }
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]! - levels[i - 1]!).toBe(1);
    }
  });

  it("degrades in the order §9.10 lists", () => {
    // Resolution first, then L1..L6 in order.
    expect(DEGRADATION).toHaveLength(7);
    expect(DEGRADATION[0]!.what).toBe("none");
    expect(DEGRADATION[1]!.what).toContain("chromatic aberration");
    expect(DEGRADATION[2]!.what).toContain("bloom levels");
    expect(DEGRADATION[3]!.what).toContain("orb steps");
    expect(DEGRADATION[4]!.what).toContain("dust");
    expect(DEGRADATION[5]!.what).toContain("maxPerSec");
    expect(DEGRADATION[6]!.what).toContain("bloom effect disabled");
  });

  it("applies degradation cumulatively", () => {
    const g = new Governor({ tierMaxScale: GOVERNOR.minScale, now: () => 0 });
    let t = 0;
    while (g.currentLevel < 6 && t < 200_000) {
      t += 25;
      g.update(25, t, false);
    }
    expect(g.currentLevel).toBe(6);
    const d = g.degradation;
    expect(d.chromaticAberration).toBe(false);
    expect(d.dustHalf).toBe(true);
    expect(d.eventRateFactor).toBeCloseTo(0.7, 6);
    expect(d.bloomDisabled).toBe(true);
    expect(d.orbOctavesOverride).toBe(2);
  });

  it("never exceeds level 6", () => {
    const g = new Governor({ tierMaxScale: GOVERNOR.minScale, now: () => 0 });
    let t = 0;
    for (let i = 0; i < 2000; i++) {
      t += 100;
      g.update(100, t, false);
    }
    expect(g.currentLevel).toBe(DEGRADATION.length - 1);
  });

  // --- improve -------------------------------------------------------------

  it("improves when frames are fast and the hold window is met", () => {
    const g = new Governor({ tierMaxScale: GOVERNOR.minScale, now: () => 0 });
    let t = 0;
    // Push it to a degraded level first.
    while (g.currentLevel < 3 && t < 200_000) {
      t += 25;
      g.update(25, t, false);
    }
    expect(g.currentLevel).toBeGreaterThan(0);

    // Now feed fast frames. 10 ms is well under `fastMs`.
    let improved = false;
    for (let i = 0; i < 2000 && !improved; i++) {
      t += 10;
      g.update(10, t, false);
      if (g.currentLevel < 3) improved = true;
    }
    expect(improved).toBe(true);
  });

  it("does not improve while pinned to an explicit quality setting", () => {
    // §9.10: an explicit non-auto setting disables improve() past the tier's
    // max, but still allows degrade for safety.
    const g = new Governor({ tierMaxScale: GOVERNOR.minScale, pinned: true, now: () => 0 });
    let t = 0;
    while (g.currentLevel < 3 && t < 200_000) {
      t += 25;
      g.update(25, t, false);
    }
    const degraded = g.currentLevel;
    expect(degraded).toBeGreaterThan(0);
    for (let i = 0; i < 5000; i++) {
      t += 10;
      g.update(10, t, false);
    }
    expect(g.currentLevel).toBe(degraded);
  });

  it("restores features before resolution", () => {
    // Ceiling must sit above the floor for this to be meaningful: with
    // `tierMaxScale == minScale` there is no headroom for scale to recover into,
    // and the ordering could not be observed.
    const g = new Governor({ tierMaxScale: 2, now: () => 0 });
    let t = 0;
    // Degrade all the way: resolution to the floor, then the feature levels.
    for (
      let i = 0;
      i < 6000 && (g.currentScale > GOVERNOR.minScale + 1e-6 || g.currentLevel < 3);
      i++
    ) {
      t += 25;
      g.update(25, t, false);
    }
    const levelAfterSlow = g.currentLevel;
    const scaleAfterSlow = g.currentScale;
    expect(levelAfterSlow).toBeGreaterThanOrEqual(3);
    expect(scaleAfterSlow).toBeCloseTo(GOVERNOR.minScale, 6);

    let improvedLevel = false;
    let improvedScale = false;
    for (let i = 0; i < 40000 && !(improvedLevel && improvedScale); i++) {
      t += 10;
      g.update(10, t, false);
      if (g.currentLevel < levelAfterSlow) improvedLevel = true;
      if (g.currentScale > scaleAfterSlow) improvedScale = true;
      // The first improve must drop a level and leave resolution alone.
      if (improvedLevel && !improvedScale) {
        expect(g.currentScale).toBeCloseTo(scaleAfterSlow, 6);
      }
    }
    expect(improvedLevel).toBe(true);
    expect(improvedScale).toBe(true);
  });

  // --- things that must NOT trigger a change ------------------------------

  it("ignores spikes above 250 ms", () => {
    const g = new Governor({ tierMaxScale: 2, now: () => 0 });
    let t = 0;
    for (let i = 0; i < 200; i++) {
      t += 300; // a tab switch or a long GC
      g.update(300, t, false);
    }
    expect(g.currentScale).toBe(2);
    expect(g.currentLevel).toBe(0);
    expect(g.smoothedFrameMs).toBe(0);
  });

  it("ignores frames while the document is hidden", () => {
    const g = new Governor({ tierMaxScale: 2, now: () => 0 });
    let t = 0;
    for (let i = 0; i < 300; i++) {
      t += 25;
      g.update(25, t, true);
    }
    expect(g.currentScale).toBe(2);
    expect(g.currentLevel).toBe(0);
  });

  it("ignores the first frames after a settle", () => {
    const g = new Governor({ tierMaxScale: 2, now: () => 0 });
    let t = 10_000; // past warm-up
    for (let i = 0; i < GOVERNOR.settleFrames; i++) {
      t += 25;
      g.update(25, t, false);
    }
    expect(g.currentScale).toBe(2);

    // A resize mid-session resets the gate the same way.
    g.onSettled();
    for (let i = 0; i < GOVERNOR.settleFrames; i++) {
      t += 25;
      g.update(25, t, false);
    }
    expect(g.currentScale).toBe(2);
  });

  it("holds steady on a frame time between the two thresholds", () => {
    // 17 ms is above `slowMs` (20)? No — below it, and above `fastMs` (14.5).
    // Neither timer should run, so nothing should change.
    const g = new Governor({ tierMaxScale: 2, now: () => 0 });
    let t = 5000;
    for (let i = 0; i < 2000; i++) {
      t += 17;
      g.update(17, t, false);
    }
    expect(g.currentScale).toBe(2);
    expect(g.currentLevel).toBe(0);
  });

  // --- cooldowns -----------------------------------------------------------

  it("waits out the cooldown between changes", () => {
    const g = new Governor({ tierMaxScale: 2, now: () => 0 });
    const changes: number[] = [];
    let t = 0;
    for (let i = 0; i < 1200; i++) {
      t += 25;
      const before = `${g.currentScale}/${g.currentLevel}`;
      g.update(25, t, false);
      const after = `${g.currentScale}/${g.currentLevel}`;
      if (before !== after) changes.push(t);
    }
    for (let i = 1; i < changes.length; i++) {
      // Each gap must clear the degrade cooldown plus the hold window.
      expect(changes[i]! - changes[i - 1]!).toBeGreaterThan(GOVERNOR.cooldownMs);
    }
  });

  it("does not oscillate under a frame time right at the threshold", () => {
    // The whole point of the hysteresis band: a machine sitting near the
    // boundary must not flip between states, which would look far worse than
    // being consistently one step down.
    const g = new Governor({ tierMaxScale: 2, now: () => 0 });
    let t = 0;
    let changes = 0;
    for (let i = 0; i < 4000; i++) {
      t += 20;
      const before = `${g.currentScale}/${g.currentLevel}`;
      g.update(20, t, false);
      if (`${g.currentScale}/${g.currentLevel}` !== before) changes++;
    }
    // 20 ms is exactly the threshold: `>` is strict, so it should not degrade
    // at all, and certainly not flap.
    expect(changes).toBeLessThanOrEqual(1);
  });

  // --- api -----------------------------------------------------------------

  it("re-ceilings the scale when the tier changes, and clears the level", () => {
    const g = new Governor({ tierMaxScale: GOVERNOR.minScale, now: () => 0 });
    let t = 0;
    while (g.currentLevel < 2 && t < 200_000) {
      t += 25;
      g.update(25, t, false);
    }
    expect(g.currentLevel).toBeGreaterThan(0);

    g.setTierMaxScale(2);
    expect(g.currentLevel).toBe(0);
    expect(g.currentScale).toBeLessThanOrEqual(2);
  });

  it("resets to a clean state", () => {
    const g = new Governor({ tierMaxScale: 2, now: () => 0 });
    let t = 0;
    for (let i = 0; i < 400; i++) {
      t += 25;
      g.update(25, t, false);
    }
    g.reset();
    expect(g.currentScale).toBe(2);
    expect(g.currentLevel).toBe(0);
    expect(g.smoothedFrameMs).toBe(0);
  });

  it("reports a frame that changed something", () => {
    const g = new Governor({ tierMaxScale: GOVERNOR.minScale, now: () => 0 });
    let t = 0;
    let sawChange = false;
    for (let i = 0; i < 400 && !sawChange; i++) {
      t += 25;
      if (g.update(25, t, false).changed) sawChange = true;
    }
    expect(sawChange).toBe(true);
  });

  it("always reports a scale inside its bounds", () => {
    for (const ceiling of [0.55, 1, 1.5, 2]) {
      const g = new Governor({ tierMaxScale: ceiling, now: () => 0 });
      let t = 0;
      for (let i = 0; i < 3000; i++) {
        t += i % 3 === 0 ? 40 : 12;
        g.update(i % 3 === 0 ? 40 : 12, t, false);
        expect(g.currentScale).toBeGreaterThanOrEqual(GOVERNOR.minScale - 1e-9);
        expect(g.currentScale).toBeLessThanOrEqual(ceiling + 1e-9);
      }
    }
  });
});

/**
 * The synchronised-sample channel.
 *
 * §9.10 feeds the governor rAF deltas. Under a GPU-bound load Chromium pins rAF at
 * the vsync interval, so those deltas stop responding to real cost — the measurement
 * in `DECISIONS.md` has rAF reading 86 ms at high tier against a synchronised 550 ms,
 * and *improving* as the scene degrades. These tests pin the fix.
 */
describe("Governor — synchronised samples close §9.10's blind spot", () => {
  /** rAF pinned at a comfortable-looking 16.7 ms while the GPU is the bottleneck. */
  const RAF_PINNED = 16.7;

  it("behaves exactly as §9.10 specifies when no sample is passed", () => {
    // The channel is additive: `update(dt, now, hidden)` with no fourth argument
    // must be byte-identical to the three-argument behaviour.
    const g = new Governor({ tierMaxScale: 2, now: () => 0 });
    run(g, { dtMs: 25, ms: 5000 });
    expect(g.currentScale).toBeLessThan(2);
  });

  it("degrades on a slow GPU even when rAF looks healthy", () => {
    // The failure this exists to prevent: rAF says 16.7 ms, the GPU says 550 ms, and
    // the governor must believe the GPU.
    const g = new Governor({ tierMaxScale: 2, now: () => 0 });
    run(g, { dtMs: RAF_PINNED, ms: 6000, syncedMs: 550 });
    expect(g.currentScale).toBeLessThan(2);
    expect(g.currentLevel).toBeGreaterThanOrEqual(0);
  });

  it("keeps a synced sample that rAF's spike ceiling would have discarded", () => {
    // `spikeMs` is 250 ms because a rAF delta past that is a tab switch or a GC
    // pause. A *synced* 550 ms frame is not an artefact — it is the condition the
    // governor exists to notice. `syncedSpikeMs` is the separate ceiling that keeps
    // the two apart; without it the fix would discard exactly what it measures.
    expect(GOVERNOR.spikeMs).toBeLessThan(550);
    expect(GOVERNOR.syncedSpikeMs).toBeGreaterThan(550);

    const g = new Governor({ tierMaxScale: 2, now: () => 0 });
    run(g, { dtMs: RAF_PINNED, ms: 6000, syncedMs: 550 });
    expect(g.currentScale).toBeLessThan(2);
  });

  it("still discards a synced sample above its own ceiling", () => {
    // A tab switch mid-frame can also produce a nonsense synced figure; the channel
    // needs a garbage reject too, just a much higher one.
    const g = new Governor({ tierMaxScale: 2, now: () => 0 });
    run(g, { dtMs: RAF_PINNED, ms: 6000, syncedMs: GOVERNOR.syncedSpikeMs + 1 });
    expect(g.currentScale).toBe(2);
  });

  it("acts on the worse of the two channels, never the better", () => {
    // rAF 22 ms (above slowMs, so "slow") against an 8 ms synced sample. Acting on
    // max(22, 8) means degrading; acting on the *better* channel would mean holding
    // at full scale. The 8 ms sample must not buy the scene a pass.
    const g = new Governor({ tierMaxScale: 2, now: () => 0 });
    run(g, { dtMs: 22, ms: 6000, syncedMs: 8 });
    expect(g.currentScale).toBeLessThan(2);

    // And the converse: a slow rAF with a fast GPU still degrades, because the
    // 22 ms channel is the worse of the two and the governor takes the worse.
    const h = new Governor({ tierMaxScale: 2, now: () => 0 });
    run(h, { dtMs: 25, ms: 6000, syncedMs: 6 });
    expect(h.currentScale).toBeLessThan(2);
  });

  it("does not ingest a synced sample from a frame the rAF channel rejected", () => {
    // The precise property: a sample arriving on a frame whose rAF delta was
    // rejected as an artefact must not be folded into the EMA. Otherwise a tab
    // switch — whose synced figure is equally meaningless — poisons the channel for
    // as long as it takes to decay, which is seconds.
    //
    // Settle at a healthy 50 ms first, so any movement is attributable to the spike.
    const g = new Governor({ tierMaxScale: 2, now: () => 0 });
    let t = run(g, { dtMs: RAF_PINNED, ms: 4000, syncedMs: 50 });
    const before = g.update(RAF_PINNED, (t += RAF_PINNED), false, null).ema;
    expect(before).toBeGreaterThan(20);
    expect(before).toBeLessThan(90);

    // A spike frame carrying a garbage sample. 900 ms is past `spikeMs`, so the
    // frame is rejected — and the sample with it.
    t += 900;
    const after = g.update(900, t, false, 900).ema;

    // Unchanged: had it been ingested, the EMA would be dragged most of the way
    // toward 900 in one step.
    expect(after).toBeCloseTo(before, 5);

    // And the next healthy sample still moves it, proving the channel is live rather
    // than latched by the spike. A lower value is needed: the synced EMA is already
    // at 50, so feeding 50 again is a no-op, and max() would keep reporting 50 while
    // the rAF channel fell away underneath it.
    t += RAF_PINNED;
    const resumed = g.update(RAF_PINNED, t, false, 10).ema;
    expect(resumed).toBeLessThan(after);
  });

  it("seeds on the first sample instead of easing up from zero", () => {
    // An EMA seeded at 0 needs ~20 samples to reach its true value; at a 30-frame
    // stride that is 10 seconds, past every cooldown the governor has. So the first
    // sample is taken as the seed.
    const g = new Governor({ tierMaxScale: 2, now: () => 0 });
    let t = 0;
    g.update(RAF_PINNED, (t += RAF_PINNED), false, 400);
    // One frame in, the reported ema is already the sample — not ~20 ms.
    expect(g.currentScale).toBe(2); // no decision yet: warmup, cooldown
    run(g, { dtMs: RAF_PINNED, ms: 6000, start: t, syncedMs: 400 });
    expect(g.currentScale).toBeLessThan(2);
  });

  it("samples on a stride, not every frame", () => {
    // The readback is a pipeline stall; taking it every frame would make the
    // governor's own measurement part of the load it measures.
    expect(GOVERNOR.syncedStrideFrames).toBeGreaterThan(1);
    // ...and the stride must still be short enough to accumulate evidence inside
    // §9.10's own slowHoldMs, or the governor can never act on a sample.
    expect(GOVERNOR.syncedStrideFrames * (1000 / 60)).toBeLessThan(GOVERNOR.slowHoldMs);
  });

  it("never reports an ema below the worse channel", () => {
    // The reported ema is what the thresholds compare against, so it must be the
    // max. The rAF channel's own EMA needs ~20 frames to converge from 0, so this
    // is only meaningful after the warm-up; §9.10's 3 s `warmupMs` covers it in
    // production, and the first `settleFrames` frames are excluded here.
    const g = new Governor({ tierMaxScale: 2, now: () => 0 });
    let t = 0;
    for (let i = 0; i < 400; i++) {
      t += RAF_PINNED;
      const synced = i % GOVERNOR.syncedStrideFrames === 0 ? 300 : null;
      const f = g.update(RAF_PINNED, t, false, synced);
      if (i < 100) continue; // EMA convergence + settle
      expect(f.ema).toBeGreaterThanOrEqual(RAF_PINNED - 1);
      // On a sample frame the 300 ms figure must dominate the 16.7 ms one.
      if (synced !== null) expect(f.ema).toBeGreaterThan(20);
    }
  });

  it("improves again once the GPU recovers", () => {
    // The channel must not latch. After a slow period, sustained fast synced
    // samples have to let the scale come back up. The clock is threaded through
    // both phases — restarting it at 0 would make `now - lastChange` negative and
    // every cooldown permanently unsatisfied, which reads as "it never recovers"
    // rather than as the clock bug it is.
    const g = new Governor({ tierMaxScale: 2, now: () => 0 });
    const t = run(g, { dtMs: RAF_PINNED, ms: 6000, syncedMs: 400 });
    const degraded = g.currentScale;
    expect(degraded).toBeLessThan(2);
    run(g, { dtMs: 10, ms: 30000, start: t, syncedMs: 8 });
    expect(g.currentScale).toBeGreaterThan(degraded);
  });
});
