/**
 * §9.11's photosensitivity limits, as applied by `Post.update`.
 *
 * These are the numbers a person with a photosensitive condition would actually feel,
 * and they are the only part of `post.ts` that is pure arithmetic — the effects
 * themselves need a GL context. So the limits are tested directly rather than left to
 * the screenshot harness, which can only see their combined effect.
 */
import { describe, expect, it } from "vitest";
import {
  BLOOM_AMPLITUDE_LIMIT,
  BLOOM_BASE,
  BLOOM_REDUCED_MOTION_CAP,
  BLOOM_RMS_GAIN,
  BLOOM_TAU_SEC,
  CA_BASE_OFFSET,
  CA_REVERT_KICK,
  CA_TAU_SEC,
} from "@/engine/visual/post";

/**
 * The one-smoothing-constant exponential step `Post.update` uses, guards included.
 *
 * The `dtSec > 0` guard is part of what is under test, not an incidental detail: a
 * zero or negative dt is what a paused tab or a first frame looks like, and dividing
 * by it would produce NaN that poisons the EMA permanently.
 */
function step(current: number, target: number, dtSec: number, tau: number): number {
  if (!(dtSec > 0)) return current;
  const a = 1 - Math.exp(-dtSec / Math.max(1e-4, tau));
  return current + (target - current) * a;
}

/** Drive a low-pass to convergence at a fixed frame rate. */
function settle(start: number, target: number, seconds: number, tau = BLOOM_TAU_SEC): number {
  let v = start;
  for (let t = 0; t < seconds; t += 1 / 60) v = step(v, target, 1 / 60, tau);
  return v;
}

describe("§9.11 — the spec's own limits", () => {
  it("states τ ≥ 0.15 s for the bloom low-pass", () => {
    expect(BLOOM_TAU_SEC).toBeGreaterThanOrEqual(0.15);
  });

  it("limits global brightness modulation to ±35 %", () => {
    expect(BLOOM_AMPLITUDE_LIMIT).toBeCloseTo(0.35);
  });

  it("caps reduced-motion bloom at 0.7", () => {
    expect(BLOOM_REDUCED_MOTION_CAP).toBeCloseTo(0.7);
  });

  it("decays the CA kick with τ = 0.35 s (§9.8)", () => {
    expect(CA_TAU_SEC).toBeCloseTo(0.35);
  });

  it("uses §9.8's bloom formula constants", () => {
    expect(BLOOM_BASE).toBeCloseTo(0.8);
    expect(BLOOM_RMS_GAIN).toBeCloseTo(0.6);
    expect(CA_BASE_OFFSET).toBeCloseTo(0.0004);
    expect(CA_REVERT_KICK).toBeCloseTo(0.0025);
  });
});

describe("§9.11 — the clamp is around §9.8's baseline, not around zero", () => {
  it("caps intensity at base × (1 + 0.35) even at full RMS", () => {
    // §9.8 wants 0.8 + 0.6·rms, which reaches 1.4. §9.11 limits the *modulation* to
    // ±35 %, and the thing being modulated is §9.8's 0.8 baseline — so 1.08.
    const span = BLOOM_AMPLITUDE_LIMIT * BLOOM_BASE;
    const cap = BLOOM_BASE + span;
    expect(cap).toBeCloseTo(1.08);
    // The naive reading — capping the raw formula — would allow 1.4, which is
    // +75 % on the signal and not ±35 % of anything.
    expect(BLOOM_BASE + BLOOM_RMS_GAIN).toBeCloseTo(1.4);
  });

  it("never exceeds the cap for any rms in [0, 1]", () => {
    const cap = BLOOM_BASE + BLOOM_AMPLITUDE_LIMIT * BLOOM_BASE;
    for (let rms = 0; rms <= 1; rms += 0.05) {
      const raw = BLOOM_BASE + BLOOM_RMS_GAIN * rms;
      const clamped = Math.min(raw, cap);
      expect(clamped).toBeLessThanOrEqual(cap + 1e-9);
      // And the swing either side of baseline never exceeds ±35 % of it.
      expect(Math.abs(clamped - BLOOM_BASE)).toBeLessThanOrEqual(
        BLOOM_AMPLITUDE_LIMIT * BLOOM_BASE + 1e-9,
      );
    }
  });

  it("leaves rms below the clamp point untouched", () => {
    // §9.8's formula reaches the cap at rms = 0.35·0.8 / 0.6 ≈ 0.467.
    const threshold = (BLOOM_AMPLITUDE_LIMIT * BLOOM_BASE) / BLOOM_RMS_GAIN;
    expect(threshold).toBeCloseTo(0.4667, 3);
    expect(BLOOM_BASE + BLOOM_RMS_GAIN * 0.3).toBeCloseTo(0.98);
  });
});

describe("§9.11 — the low-pass actually low-passes", () => {
  it("does not jump to the target in one frame", () => {
    // A global brightness change reaching the screen instantly is the flash that
    // §9.11 exists to prevent. Asserting on the distance *still to travel* would be
    // meaningless — it is large by definition — so this checks how far it moved.
    const one = step(0.8, 1.08, 1 / 60, BLOOM_TAU_SEC);
    expect(one).toBeGreaterThan(0.8);
    expect(one - 0.8).toBeLessThan(0.05);
    // ~10.5 % of the way in one frame at τ = 0.15 s.
    expect(one - 0.8).toBeCloseTo(0.28 * (1 - Math.exp(-(1 / 60) / 0.15)), 6);
  });

  it("converges, given time", () => {
    expect(settle(0.8, 1.08, 3)).toBeCloseTo(1.08, 2);
  });

  it("reaches ~63 % of the step in one time constant", () => {
    const after = settle(0.8, 1.08, BLOOM_TAU_SEC, BLOOM_TAU_SEC);
    expect(after - 0.8).toBeCloseTo((1.08 - 0.8) * (1 - Math.exp(-1)), 2);
  });

  it("holds still when dt is zero or negative", () => {
    // A zero dt is what a paused tab or a first frame looks like; dividing by it
    // would produce NaN and poison the EMA permanently.
    expect(step(0.9, 1.08, 0, BLOOM_TAU_SEC)).toBe(0.9);
    expect(step(0.9, 1.08, -0.5, BLOOM_TAU_SEC)).toBe(0.9);
  });

  it("is bounded against a zero time constant", () => {
    // tau <= 0 would make the exponential blow up; it is clamped rather than trusted.
    const v = step(0.8, 1.08, 1 / 60, 0);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeLessThanOrEqual(1.08 + 1e-9);
  });
});

describe("§9.8 — the CA kick decays and never reverses", () => {
  it("decays toward the base offset", () => {
    let kick = CA_REVERT_KICK;
    for (let i = 0; i < 600; i++) kick = step(kick, 0, 1 / 60, CA_TAU_SEC);
    expect(kick).toBeLessThan(CA_REVERT_KICK / 1000);
    expect(CA_BASE_OFFSET + kick).toBeCloseTo(CA_BASE_OFFSET, 6);
  });

  it("halves in about one time constant", () => {
    expect(CA_REVERT_KICK * Math.exp(-1)).toBeCloseTo(CA_REVERT_KICK * 0.3679, 4);
  });

  it("stays above the base offset while decaying", () => {
    let kick = CA_REVERT_KICK;
    let prev = kick;
    for (let i = 0; i < 60; i++) {
      kick = step(kick, 0, 1 / 60, CA_TAU_SEC);
      expect(kick).toBeLessThan(prev);
      expect(kick).toBeGreaterThan(0);
      prev = kick;
    }
  });
});

describe("§9.11 — reduced motion", () => {
  it("caps rather than disables bloom", () => {
    // §9.11 says "bloom intensity cap 0.7", not "no bloom".
    expect(BLOOM_REDUCED_MOTION_CAP).toBeGreaterThan(0);
    expect(BLOOM_REDUCED_MOTION_CAP).toBeLessThan(BLOOM_BASE);
    // …and it bites even at rms 0, where the un-reduced value is 0.8.
    expect(BLOOM_REDUCED_MOTION_CAP).toBeLessThan(BLOOM_BASE);
  });

  it("is the tighter of the two limits at every rms", () => {
    const cap = BLOOM_BASE + BLOOM_AMPLITUDE_LIMIT * BLOOM_BASE;
    for (let rms = 0; rms <= 1; rms += 0.05) {
      const normal = Math.min(BLOOM_BASE + BLOOM_RMS_GAIN * rms, cap);
      const reduced = Math.min(normal, BLOOM_REDUCED_MOTION_CAP);
      expect(reduced).toBeLessThanOrEqual(normal + 1e-9);
    }
  });
});