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

/** Drive the governor at a fixed frame time and advance a virtual clock. */
function run(
  g: Governor,
  opts: {
    dtMs: number;
    ms: number;
    start?: number;
    hidden?: boolean;
    onFrame?: (t: number) => void;
  },
): void {
  let t = opts.start ?? 0;
  const step = opts.dtMs;
  const frames = Math.max(0, Math.floor(opts.ms / step));
  for (let i = 0; i < frames; i++) {
    t += step;
    opts.onFrame?.(t);
    g.update(step, t, opts.hidden ?? false);
  }
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
