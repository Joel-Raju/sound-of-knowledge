import { describe, expect, it } from "vitest";
import { IdDedupeRing, NumericRing, RingBuffer } from "@/engine/util/ring-buffer";
import { Ema, FrameStats, energyToRate, rateToEnergy } from "@/engine/util/perf";
import { EPS_REF } from "@/engine/config";

describe("RingBuffer", () => {
  it("rejects a non-positive capacity", () => {
    expect(() => new RingBuffer<number>(0)).toThrow(RangeError);
    expect(() => new RingBuffer<number>(-1)).toThrow(RangeError);
  });

  it("push/pop in FIFO order", () => {
    const r = new RingBuffer<number>(4);
    r.push(1);
    r.push(2);
    r.push(3);
    expect(r.length).toBe(3);
    expect(r.pop()).toBe(1);
    expect(r.pop()).toBe(2);
    expect(r.pop()).toBe(3);
    expect(r.pop()).toBeUndefined();
    expect(r.length).toBe(0);
  });

  it("overwrites the oldest element when full", () => {
    const r = new RingBuffer<number>(3);
    for (let i = 1; i <= 5; i++) r.push(i);
    expect(r.length).toBe(3);
    expect(r.oldest).toBe(3);
    expect(r.last).toBe(5);
    expect(r.at(0)).toBe(3);
    expect(r.at(1)).toBe(4);
    expect(r.at(2)).toBe(5);
  });

  it("at() is bounds-safe", () => {
    const r = new RingBuffer<number>(2);
    r.push(9);
    expect(r.at(-1)).toBeUndefined();
    expect(r.at(5)).toBeUndefined();
    expect(r.last).toBe(9);
    expect(r.oldest).toBe(9);
  });

  it("clear empties without changing capacity", () => {
    const r = new RingBuffer<number>(4);
    r.push(1);
    r.push(2);
    r.clear();
    expect(r.length).toBe(0);
    expect(r.capacity).toBe(4);
    expect(r.pop()).toBeUndefined();
    r.push(3); // still usable afterwards
    expect(r.pop()).toBe(3);
  });

  it("forEach iterates oldest → newest", () => {
    const r = new RingBuffer<number>(3);
    for (let i = 1; i <= 4; i++) r.push(i); // window = [2,3,4]
    const seen: number[] = [];
    r.forEach((v) => seen.push(v));
    expect(seen).toEqual([2, 3, 4]);
  });
});

describe("IdDedupeRing", () => {
  it("reports duplicates and new ids", () => {
    const d = new IdDedupeRing(4);
    expect(d.seenOrAdd(1)).toBe(false);
    expect(d.seenOrAdd(1)).toBe(true);
    expect(d.seenOrAdd(2)).toBe(false);
    expect(d.size).toBe(2);
  });

  it("evicts in FIFO order once full (spec §6.3)", () => {
    const d = new IdDedupeRing(3);
    d.seenOrAdd(1);
    d.seenOrAdd(2);
    d.seenOrAdd(3);
    expect(d.seenOrAdd(1)).toBe(true); // still in window
    d.seenOrAdd(4); // evicts 1
    expect(d.seenOrAdd(1)).toBe(false); // 1 is gone, re-admitted
    expect(d.size).toBe(3);
  });

  it("never exceeds capacity", () => {
    const d = new IdDedupeRing(64);
    for (let i = 0; i < 10_000; i++) d.seenOrAdd(i);
    expect(d.size).toBeLessThanOrEqual(64);
    expect(d.size).toBe(64);
  });

  it("clear resets", () => {
    const d = new IdDedupeRing(8);
    d.seenOrAdd(42);
    d.clear();
    expect(d.size).toBe(0);
    expect(d.seenOrAdd(42)).toBe(false);
  });
});

describe("NumericRing", () => {
  it("percentile over a known distribution", () => {
    const r = new NumericRing(100);
    for (let i = 1; i <= 100; i++) r.push(i);
    expect(r.percentile(50)).toBeGreaterThan(45);
    expect(r.percentile(50)).toBeLessThan(55);
    expect(r.percentile(95)).toBeGreaterThan(90);
    expect(r.percentile(0)).toBe(1);
    expect(r.percentile(100)).toBe(100);
  });

  it("retains only the most recent window", () => {
    const r = new NumericRing(4);
    for (let i = 0; i < 10; i++) r.push(i);
    expect(r.length).toBe(4);
    expect(r.percentile(100)).toBe(9);
  });

  it("empty ring reports 0", () => {
    const r = new NumericRing(4);
    expect(r.percentile(95)).toBe(0);
    expect(r.mean).toBe(0);
  });

  it("mean is correct", () => {
    const r = new NumericRing(4);
    r.push(1);
    r.push(2);
    r.push(3);
    expect(r.mean).toBeCloseTo(2, 6);
  });
});

describe("FrameStats", () => {
  it("tracks EMA and clamps absurd deltas", () => {
    const f = new FrameStats(60);
    f.tick(0); // first call primes, no sample
    for (let i = 1; i <= 60; i++) f.tick(i * 16.7);
    expect(f.frameMsEma).toBeGreaterThan(10);
    expect(f.frameMsEma).toBeLessThan(25);
    expect(f.fps).toBeGreaterThan(40);

    f.tick(999_999); // 10-minute stall must clamp to 250 ms
    expect(f.frameMsEma).toBeLessThan(250);
  });

  it("ignores a negative clock jump", () => {
    const f = new FrameStats(60);
    f.tick(1000);
    const dt = f.tick(500);
    expect(dt).toBe(0);
  });

  it("reset clears state", () => {
    const f = new FrameStats(10);
    f.tick(0);
    f.tick(16);
    f.reset();
    expect(f.frameCount).toBe(0);
    expect(f.frameMsEma).toBeCloseTo(16.7, 6);
  });

  // --- push(): the renderer's path, sharing one clamp with the camera ------

  it("accepts an externally computed delta", () => {
    const f = new FrameStats(60);
    // 200 frames of 16 ms: the EMA starts at the 16.7 ms seed and converges as
    // 16.7 + (16 - 16.7) * 0.95^n, so a handful of frames would not do.
    for (let i = 0; i < 200; i++) f.push(16);
    expect(f.frameCount).toBe(200);
    expect(f.frameMsEma).toBeCloseTo(16, 4);
    expect(f.frameMsP95).toBeCloseTo(16, 6);
  });

  it("drops a non-finite or non-positive delta rather than recording it", () => {
    const f = new FrameStats(60);
    for (const bad of [0, -5, NaN, Infinity, -Infinity]) expect(f.push(bad)).toBe(0);
    expect(f.frameCount).toBe(0);
    expect(f.frameMsEma).toBe(16.7); // untouched
  });

  it("records exactly what tick would have recorded for the same deltas", () => {
    // The renderer clamps to `THREE_MAX_DT_MS` (100) before pushing, while
    // `tick` clamps at 250. Below that threshold the two must agree, or the HUD
    // and the camera would be describing different sessions. `b.tick(0)` primes
    // the way a real rAF callback's first frame does, recording no sample.
    const a = new FrameStats(240);
    const b = new FrameStats(240);
    let t = 0;
    b.tick(0);
    for (let i = 0; i < 200; i++) {
      const dt = 8 + (i % 7);
      a.push(dt, t);
      t += dt;
      b.tick(t);
    }
    expect(a.frameCount).toBe(b.frameCount);
    expect(a.frameMsEma).toBeCloseTo(b.frameMsEma, 9);
    expect(a.frameMsP95).toBeCloseTo(b.frameMsP95, 9);
  });

  it("keeps the ring bounded, so a long session does not grow the heap", () => {
    // §12.1's "JS heap growth < 10 MB over a 10-minute soak". An unbounded frame
    // history would be a slow leak of exactly the kind that budget exists for.
    const f = new FrameStats(240);
    for (let i = 0; i < 200_000; i++) f.push(16, i * 16);
    expect(f.sampleCount).toBe(240);
    expect(f.frames.capacity).toBe(240);
  });

  // --- percentile / median / mean -----------------------------------------

  it("reports p95 above the median when the tail is heavy", () => {
    const f = new FrameStats(240);
    // 10 hitches in 100 frames: above the 5 % that p95 measures, so it must land
    // in the tail. A 5 % tail would leave p95 in the body by construction.
    for (let i = 0; i < 90; i++) f.push(16);
    for (let i = 0; i < 10; i++) f.push(200);
    expect(f.frameMsP95).toBe(200);
    expect(f.frameMsMedian).toBeCloseTo(16, 9);
    expect(f.frameMsMean).toBeGreaterThan(f.frameMsMedian);
  });

  it("leaves p95 in the body when the tail is under 5 %", () => {
    // The other half of the same property, and the reason p95 is not just "the
    // worst frame": a uniform machine with rare stutter should not read as slow.
    const f = new FrameStats(240);
    for (let i = 0; i < 100; i++) f.push(16);
    for (let i = 0; i < 4; i++) f.push(200);
    expect(f.frameMsP95).toBeCloseTo(16, 9);
    expect(f.frameMsMean).toBeGreaterThan(f.frameMsMedian);
  });

  it("reports p95 within the sample range and never below the median", () => {
    const f = new FrameStats(240);
    let max = 0;
    for (let i = 0; i < 240; i++) {
      const v = 10 + (i % 30);
      max = Math.max(max, v);
      f.push(v);
    }
    expect(f.frameMsP95).toBeLessThanOrEqual(max);
    expect(f.frameMsP95).toBeGreaterThanOrEqual(f.frameMsMedian);
  });

  it("reports zeros before any sample", () => {
    const f = new FrameStats(60);
    expect(f.frameMsP95).toBe(0);
    expect(f.frameMsMedian).toBe(0);
    expect(f.frameMsMean).toBe(0);
    expect(f.sampleCount).toBe(0);
  });

  // --- fps ------------------------------------------------------------------

  it("leaves the windowed fps at 0 until a full second has elapsed", () => {
    const f = new FrameStats(240);
    let t = 0;
    for (let i = 0; i < 30; i++) {
      f.push(16, t);
      t += 16;
    }
    // 30 frames × 16 ms ≈ 480 ms — not yet a window.
    expect(f.fpsWindowed).toBe(0);
    // The EMA-derived figure is available immediately, so the HUD is never blank.
    expect(f.fps).toBeGreaterThan(0);
  });

  it("measures ~60 fps over a window of 16 ms frames", () => {
    const f = new FrameStats(240);
    let t = 1000; // start the window partway in, as a real session would
    for (let i = 0; i < 70; i++) {
      f.push(16, t);
      t += 16;
    }
    expect(f.fpsWindowed).toBeGreaterThan(55);
    expect(f.fpsWindowed).toBeLessThan(65);
  });

  it("ignores a bogus clock for the fps window", () => {
    const f = new FrameStats(240);
    for (let i = 0; i < 100; i++) f.push(16, NaN);
    expect(f.fpsWindowed).toBe(0);
    expect(f.frameCount).toBe(100); // the samples still counted
  });

  it("reset clears the fps window", () => {
    const f = new FrameStats(240);
    let t = 0;
    for (let i = 0; i < 100; i++) {
      f.push(16, t);
      t += 16;
    }
    expect(f.fpsWindowed).toBeGreaterThan(0);
    f.reset();
    expect(f.fpsWindowed).toBe(0);
  });
});

describe("Ema", () => {
  it("converges toward the input rate", () => {
    const e = new Ema(1);
    for (let i = 0; i < 2000; i++) e.push(50, 0.5);
    expect(e.current).toBeCloseTo(50, 0);
  });

  it("reset seeds the value", () => {
    const e = new Ema(6);
    e.reset(12);
    expect(e.current).toBe(12);
  });
});

// spec §7.3 energy curve
describe("rateToEnergy", () => {
  it("is 0 at zero throughput and 1 at the reference rate", () => {
    expect(rateToEnergy(0, EPS_REF)).toBe(0);
    expect(rateToEnergy(EPS_REF, EPS_REF)).toBeCloseTo(1, 6);
  });

  it("is monotonic in eps", () => {
    let prev = -1;
    for (let eps = 0; eps <= EPS_REF * 2; eps += 2) {
      const e = rateToEnergy(eps, EPS_REF);
      expect(e).toBeGreaterThanOrEqual(prev);
      prev = e;
    }
  });

  it("clamps to [0,1]", () => {
    expect(rateToEnergy(EPS_REF * 100, EPS_REF)).toBe(1);
    expect(rateToEnergy(-5, EPS_REF)).toBe(0);
  });

  it("guards a degenerate reference", () => {
    expect(rateToEnergy(10, 0)).toBe(0);
  });

  it("round-trips with energyToRate (spec §13.3 rateMul derivation)", () => {
    for (const e of [0.3, 0.6, 0.9]) {
      const eps = energyToRate(e, EPS_REF);
      expect(rateToEnergy(eps, EPS_REF)).toBeCloseTo(e, 6);
    }
  });
});
