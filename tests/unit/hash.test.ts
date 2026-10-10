import { describe, expect, it } from "vitest";
import {
  fnv1a,
  fnv1aInt,
  hash01,
  hashGaussianish,
  hashIndex,
  hashUniforms,
} from "@/engine/util/hash";

// spec §13.2 row `util/hash`
describe("fnv1a", () => {
  it("matches the spec test vectors", () => {
    expect(fnv1a("")).toBe(0x811c9dc5);
    expect(fnv1a("a")).toBe(0xe40c292c);
  });

  it("is stable across calls and produces uint32", () => {
    const a = fnv1a("Albert Einstein");
    const b = fnv1a("Albert Einstein");
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(0xffffffff);
  });

  it("signed view agrees with unsigned for the same input", () => {
    expect(fnv1aInt("a")).toBe(0xe40c292c | 0);
  });

  it("distinguishes similar strings (avalanche check)", () => {
    expect(fnv1a("abc")).not.toBe(fnv1a("abd"));
    expect(fnv1a("Albert Einstein")).not.toBe(fnv1a("Albert Einstei"));
  });

  it("hash01 stays in [0, 1)", () => {
    for (const s of ["", "a", "en.wikipedia.org", "Talk:Berlin", "~2025-1-abcd"]) {
      const v = hash01(s);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("hashUniforms fills the requested count in [0,1) with distinct values", () => {
    const out = new Float64Array(3);
    hashUniforms("Berlin:12345", out, 3);
    for (let i = 0; i < 3; i++) {
      expect(out[i]).toBeGreaterThanOrEqual(0);
      expect(out[i]).toBeLessThan(1);
    }
    expect(out[0]).not.toBe(out[1]);
    expect(out[1]).not.toBe(out[2]);
  });

  it("hashUniforms respects the buffer length", () => {
    const out = new Float64Array(3);
    hashUniforms("x", out, 99); // count > length must not overflow
    expect(out.length).toBe(3);
  });

  it("hashIndex is in range and guards n <= 0", () => {
    for (let i = 0; i < 200; i++) {
      const idx = hashIndex(`wiki-${i}`, 64);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(64);
    }
    expect(hashIndex("x", 0)).toBe(0);
    expect(hashIndex("x", -5)).toBe(0);
  });

  it("hashGaussianish is centred near zero", () => {
    let sum = 0;
    const n = 10000;
    for (let i = 0; i < n; i++) {
      sum += hashGaussianish(hash01(`a${i}`), hash01(`b${i}`), hash01(`c${i}`));
    }
    expect(Math.abs(sum / n)).toBeLessThan(0.05);
  });
});
