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
