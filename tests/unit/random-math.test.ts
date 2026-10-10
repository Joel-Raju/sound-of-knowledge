import { describe, expect, it } from "vitest";
import {
  logNormal,
  makeValueNoise2D,
  mulberry32,
  normal,
  pick,
  randInt,
  weighted,
  xorshift32,
} from "@/engine/util/random";
import {
  clamp,
  clamp01,
  dbToGain,
  easeInOutCubic,
  easeOutCubic,
  expApproach,
  freqToMidi,
  gainToDb,
  invLerp,
  isFiniteNumber,
  lerp,
  midiToFreq,
  smoothingCoefficient,
  smoothstep,
  wrap,
  wrapDelta,
} from "@/engine/util/math";

// spec §13.2 row `util/random`
describe("mulberry32", () => {
  it("is deterministic for a seed", () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    for (let i = 0; i < 1000; i++) expect(a()).toBe(b());
  });

  it("produces different streams for different seeds", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    let same = 0;
    for (let i = 0; i < 100; i++) if (a() === b()) same++;
    expect(same).toBeLessThan(2);
  });

  it("has mean ≈ 0.5 over 100k draws", () => {
    const r = mulberry32(0xc0ffee);
    let sum = 0;
    const n = 100000;
    for (let i = 0; i < n; i++) sum += r();
    expect(sum / n).toBeCloseTo(0.5, 2);
  });

  it("stays within [0, 1)", () => {
    const r = mulberry32(7);
    for (let i = 0; i < 100000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("random helpers", () => {
  it("randInt stays in [0, n) and guards n <= 0", () => {
    const r = mulberry32(3);
    for (let i = 0; i < 5000; i++) {
      const v = randInt(r, 7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
    }
    expect(randInt(r, 0)).toBe(0);
    expect(randInt(r, -3)).toBe(0);
  });

  it("pick returns undefined for an empty array", () => {
    expect(pick(mulberry32(1), [])).toBeUndefined();
    expect(pick(mulberry32(1), ["only"])).toBe("only");
  });

  it("weighted respects the distribution (spec §7.4 key walk)", () => {
    const r = mulberry32(99);
    const values = [7, 5, 2, -3];
    const weights = [0.4, 0.4, 0.1, 0.1];
    const counts = new Map<number, number>();
    const n = 40000;
    for (let i = 0; i < n; i++) {
      const v = weighted(r, values, weights)!;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    expect(counts.get(7)! / n).toBeCloseTo(0.4, 1);
    expect(counts.get(5)! / n).toBeCloseTo(0.4, 1);
    expect(counts.get(2)! / n).toBeCloseTo(0.1, 1);
    expect(counts.get(-3)! / n).toBeCloseTo(0.1, 1);
  });

  it("weighted handles empty and zero-total inputs", () => {
    const r = mulberry32(1);
    expect(weighted(r, [], [])).toBeUndefined();
    expect(weighted(r, ["a", "b"], [0, 0])).toBe("a");
  });

  it("logNormal and normal stay clamped and finite", () => {
    const r = mulberry32(5);
    for (let i = 0; i < 5000; i++) {
      const ln = logNormal(r, Math.log(80), 1.6, 1, 60000);
      expect(Number.isFinite(ln)).toBe(true);
      expect(ln).toBeGreaterThanOrEqual(1);
      expect(ln).toBeLessThanOrEqual(60000);

      const nm = normal(r, 0, 0.3, -1, 1);
      expect(nm).toBeGreaterThanOrEqual(-1);
      expect(nm).toBeLessThanOrEqual(1);
    }
  });

  it("value noise is deterministic, bounded, and continuous", () => {
    const a = makeValueNoise2D(42);
    const b = makeValueNoise2D(42);
    const samples: readonly (readonly [number, number])[] = [
      [0.3, 0.7],
      [5.1, -2.4],
      [100, 100],
    ];
    for (const [x, y] of samples) {
      expect(a(x, y)).toBe(b(x, y));
    }
    for (let i = 0; i < 500; i++) {
      const v = a(i * 0.37, i * 0.11);
      expect(v).toBeGreaterThanOrEqual(-1.0001);
      expect(v).toBeLessThanOrEqual(1.0001);
    }
    // Continuity: small input steps produce small output changes.
    const n = makeValueNoise2D(1);
    const here = n(1.0, 1.0);
    const nudged = n(1.001, 1.0);
    expect(here).toBeDefined();
    expect(nudged).toBeDefined();
    expect(Math.abs(here! - nudged!)).toBeLessThan(0.05);
  });

  it("xorshift32 is deterministic and stays in [0,1)", () => {
    const a = xorshift32(12345);
    const b = xorshift32(12345);
    for (let i = 0; i < 1000; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("xorshift32 survives a zero seed", () => {
    const r = xorshift32(0);
    expect(Number.isFinite(r())).toBe(true);
  });
});

// spec §13.2 row `util/math`
describe("math", () => {
  it("clamp / clamp01", () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(-2)).toBe(0);
  });

  it("lerp / invLerp round-trip, with degenerate guard", () => {
    expect(lerp(0, 10, 0.25)).toBe(2.5);
    expect(invLerp(0, 10, 2.5)).toBe(0.25);
    expect(invLerp(3, 3, 9)).toBe(0);
  });

  it("smoothstep clamps and hits its endpoints", () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 5);
    expect(smoothstep(0, 0, 0)).toBe(0); // degenerate edge guard
  });

  it("easeOutCubic and easeInOutCubic", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 5);
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 5);
  });

  it("midiToFreq / freqToMidi round-trip (spec §7.6)", () => {
    expect(midiToFreq(69)).toBeCloseTo(440, 6);
    expect(midiToFreq(48)).toBeCloseTo(130.8128, 3); // C3
    expect(freqToMidi(440)).toBeCloseTo(69, 6);
    for (const m of [21, 36, 60, 88, 108]) {
      expect(freqToMidi(midiToFreq(m))).toBeCloseTo(m, 6);
    }
  });

  it("dbToGain / gainToDb round-trip", () => {
    expect(dbToGain(0)).toBeCloseTo(1, 6);
    expect(dbToGain(-6)).toBeCloseTo(0.5012, 3);
    expect(gainToDb(1)).toBeCloseTo(0, 6);
    expect(gainToDb(0)).toBe(-240); // clamped by the 1e-12 floor
  });

  it("smoothingCoefficient handles dt=0 and tau=0 without NaN (spec §8.10)", () => {
    expect(smoothingCoefficient(0, 0.05)).toBe(0);
    expect(smoothingCoefficient(0.016, 0)).toBe(1);
    const a = smoothingCoefficient(0.016, 0.05);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1);
  });

  it("expApproach moves toward the target and is frame-rate independent", () => {
    let v = 0;
    for (let i = 0; i < 200; i++) v = expApproach(v, 10, 1 / 60, 0.3);
    expect(v).toBeGreaterThan(9.9);
    expect(expApproach(0, 5, 0.016, 0)).toBe(5); // tau guard
  });

  it("wrap / wrapDelta", () => {
    expect(wrap(5, 3)).toBe(2);
    expect(wrap(-1, 3)).toBe(2);
    expect(wrap(1, 0)).toBe(0);
    expect(wrapDelta(0.9, 1)).toBeCloseTo(-0.1, 6);
    expect(wrapDelta(-0.9, 1)).toBeCloseTo(0.1, 6);
    expect(wrapDelta(0.5, 0)).toBe(0);
  });

  it("isFiniteNumber rejects NaN/Infinity/non-numbers", () => {
    expect(isFiniteNumber(1)).toBe(true);
    expect(isFiniteNumber(NaN)).toBe(false);
    expect(isFiniteNumber(Infinity)).toBe(false);
    expect(isFiniteNumber("1")).toBe(false);
    expect(isFiniteNumber(null)).toBe(false);
  });
});
