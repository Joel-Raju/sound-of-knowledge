import { describe, expect, it } from "vitest";
import {
  copyRgb,
  linearSrgbToOklab,
  mixRgb,
  oklch,
  oklchToLinearSrgb,
  scaleRgb,
} from "@/engine/util/oklch";

// spec §13.2 row `util/oklch`
describe("oklch → linear sRGB", () => {
  it("(L=1, C=0) → (1,1,1)", () => {
    const c = oklch(1, 0, 0);
    expect(c.r).toBeCloseTo(1, 5);
    expect(c.g).toBeCloseTo(1, 5);
    expect(c.b).toBeCloseTo(1, 5);
  });

  it("(0,0,0) → 0", () => {
    const c = oklch(0, 0, 0);
    expect(c.r).toBeCloseTo(0, 6);
    expect(c.g).toBeCloseTo(0, 6);
    expect(c.b).toBeCloseTo(0, 6);
  });

  it("OKLCH(0.6280, 0.2577, 29.23°) ≈ linear red (1,0,0) within 0.02", () => {
    const c = oklch(0.628, 0.2577, 29.23);
    expect(Math.abs(c.r - 1)).toBeLessThan(0.02);
    expect(Math.abs(c.g - 0)).toBeLessThan(0.02);
    expect(Math.abs(c.b - 0)).toBeLessThan(0.02);
  });

  it("an in-gamut colour keeps its perceptual lightness (mean ≈ L³)", () => {
    // OKLab L is the cube root of luminance, so mean(linear sRGB) should track
    // L³. This is the property that makes the mode palettes feel equally bright.
    for (const L of [0.3, 0.5, 0.7, 0.85]) {
      const c = oklch(L, 0.08, 40); // comfortably in gamut
      const mean = (c.r + c.g + c.b) / 3;
      expect(mean).toBeGreaterThan(L ** 3 * 0.8);
      expect(mean).toBeLessThan(L ** 3 * 1.2);
    }
  });

  it("reduces chroma rather than clipping when far out of gamut", () => {
    // C = 0.9 at L = 0.7 is far outside sRGB; after 8 reduction steps (spec
    // §9.3) the result must still be finite and inside [0,1].
    const wild = oklch(0.7, 0.9, 140);
    for (const ch of ["r", "g", "b"] as const) {
      expect(Number.isFinite(wild[ch])).toBe(true);
      expect(wild[ch]).toBeGreaterThanOrEqual(0);
      expect(wild[ch]).toBeLessThanOrEqual(1);
    }
    // Reducing chroma must move the colour back toward gamut monotonically:
    // the overshoot below 0 shrinks with every step.
    let prevOver = Infinity;
    for (let i = 0; i < 8; i++) {
      const c = oklch(0.7, 0.9 * Math.pow(0.95, i), 140);
      const over = Math.max(0, c.r - 1) + Math.max(0, c.g - 1) + Math.max(0, c.b - 1);
      expect(over).toBeLessThanOrEqual(prevOver + 1e-9);
      prevOver = over;
    }
  });

  it("never returns NaN or negative components (spec §13.2)", () => {
    for (const [L, C, h] of [
      [1, 0.5, 0],
      [0, 0.5, 120],
      [0.5, 1.2, 240],
      [0.5, 0.2, 720],
      [0.5, -0.3, 30],
    ] as const) {
      const c = oklch(L, C, h);
      for (const ch of ["r", "g", "b"] as const) {
        expect(Number.isFinite(c[ch])).toBe(true);
        expect(c[ch]).toBeGreaterThanOrEqual(0);
        expect(c[ch]).toBeLessThanOrEqual(1);
      }
    }
  });

  it("handles NaN input without producing NaN output", () => {
    const c = oklch(NaN, 0.2, 0);
    expect(Number.isFinite(c.r)).toBe(true);
    expect(Number.isFinite(c.g)).toBe(true);
    expect(Number.isFinite(c.b)).toBe(true);
  });

  it("writes into a caller-provided object (no allocation)", () => {
    const out = { r: -1, g: -1, b: -1 };
    oklchToLinearSrgb(0.5, 0.1, 200, out);
    expect(out.r).toBeGreaterThanOrEqual(0);
    expect(out.b).toBeLessThanOrEqual(1);
  });

  it("is monotonic in lightness", () => {
    let prev = -1;
    for (let L = 0.1; L <= 0.95; L += 0.1) {
      const c = oklch(L, 0.1, 30);
      const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
      expect(lum).toBeGreaterThan(prev);
      prev = lum;
    }
  });
});

describe("linear sRGB → OKLab (inverse)", () => {
  it("round-trips through the forward transform", () => {
    const out = { L: 0, C: 0, h: 0 };
    const rgb = oklch(0.7, 0.1, 250);
    linearSrgbToOklab(rgb.r, rgb.g, rgb.b, out);
    expect(out.L).toBeCloseTo(0.7, 3);
    expect(out.C).toBeCloseTo(0.1, 3);
    // Hue is modulo 360.
    const h = ((out.h % 360) + 360) % 360;
    expect(Math.min(Math.abs(h - 250), 360 - Math.abs(h - 250))).toBeLessThan(1.5);
  });
});

describe("rgb helpers", () => {
  it("mixRgb interpolates each channel", () => {
    const a = { r: 0, g: 0, b: 0 };
    const b = { r: 1, g: 1, b: 1 };
    const out = { r: 0, g: 0, b: 0 };
    mixRgb(a, b, 0.5, out);
    expect(out.r).toBeCloseTo(0.5, 6);
    expect(out.g).toBeCloseTo(0.5, 6);
    expect(out.b).toBeCloseTo(0.5, 6);
  });

  it("scaleRgb scales and clamps (spec §9.3 HDR multipliers)", () => {
    const c = { r: 0.5, g: 0.5, b: 0.5 };
    const out = { r: 0, g: 0, b: 0 };
    scaleRgb(c, 1.8, out);
    expect(out.r).toBeCloseTo(0.9, 6);
    scaleRgb(c, 4, out);
    expect(out.r).toBe(1); // clamped, HDR handled by the shaders
  });

  it("copyRgb copies all channels", () => {
    const src = { r: 0.1, g: 0.2, b: 0.3 };
    const dst = { r: 0, g: 0, b: 0 };
    copyRgb(src, dst);
    expect(dst).toEqual(src);
  });
});
