/**
 * §9.7 dust: the position distribution and the governor's draw range.
 *
 * The distribution is the part worth testing. It is generated once with a seeded
 * PRNG and never touched, so a bug there is baked into every capture and every
 * session — and it is invisible in a unit test unless the shell is checked directly.
 */
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  DUST,
  DUST_BASE_ALPHA,
  Dust,
  DUST_DRIFT,
  DUST_SHELL,
  DUST_SIZE,
} from "@/engine/visual/dust";

const TIERS = ["low", "medium", "high"] as const;

function radii(d: Dust): number[] {
  const p = d.geometry.getAttribute("position").array as Float32Array;
  const out: number[] = [];
  for (let i = 0; i < p.length; i += 3) {
    out.push(Math.hypot(p[i] ?? 0, p[i + 1] ?? 0, p[i + 2] ?? 0));
  }
  return out;
}

describe("Dust — §9.7 capacity", () => {
  it("uses the per-tier point counts", () => {
    expect(new Dust({ tier: "high" }).count).toBe(30000);
    expect(new Dust({ tier: "medium" }).count).toBe(15000);
    expect(new Dust({ tier: "low" }).count).toBe(6000);
  });

  it("draws every point by default", () => {
    for (const tier of TIERS) {
      const d = new Dust({ tier });
      expect(d.drawn).toBe(d.count);
      expect(d.geometry.drawRange.count).toBe(d.count);
      d.dispose();
    }
  });
});

describe("Dust — shell", () => {
  it("keeps every point inside the 3–40 shell", () => {
    const d = new Dust({ tier: "high", seed: 7 });
    for (const r of radii(d)) {
      expect(r).toBeGreaterThanOrEqual(DUST_SHELL.inner - 1e-3);
      expect(r).toBeLessThanOrEqual(DUST_SHELL.outer + 1e-3);
    }
    d.dispose();
  });

  it("is uniform in VOLUME, not uniform in radius", () => {
    // The bug this guards: sampling `r` linearly in [3, 40] crowds a third of the
    // points inside r < 13, against the inner boundary — where the camera sits
    // (§9.1 puts it at 5.5). Near-camera motes render as a starfield.
    const d = new Dust({ tier: "high", seed: 11 });
    const rs = radii(d);
    const inner = rs.filter((r) => r < 13).length / rs.length;
    // Uniform-in-volume puts (13³ − 3³) / (40³ − 3³) ≈ 2.8 % inside r < 13.
    // Uniform-in-radius would put 28 %. The midpoint is ~6 %.
    expect(inner).toBeLessThan(0.06);
    d.dispose();
  });

  it("spreads through the shell's volume, sparse inside and dense outside", () => {
    // Uniform-in-volume is asymmetric by construction: the outer radii hold most of
    // the volume. Both halves are asserted because either one alone is satisfiable
    // by a wrong distribution — a uniform-in-radius shell has a fat inner band, and a
    // ball centred on the origin has neither.
    const d = new Dust({ tier: "high", seed: 13 });
    const rs = radii(d);
    const frac = (lo: number, hi: number) => rs.filter((r) => r >= lo && r < hi).length / rs.length;
    // Below the midpoint of the radius range: (13.25³ − 3³) / (40³ − 3³) ≈ 3.6 %.
    expect(frac(3, 13.25)).toBeLessThan(0.06);
    // Above it: the complement, ≈ 96 %.
    expect(frac(13.25, 40)).toBeGreaterThan(0.9);
    d.dispose();
  });

  it("is reproducible from its seed", () => {
    // §13.4 asks for captures a human can compare; dust that reshuffles every run
    // makes two captures incomparable.
    const a = new Dust({ tier: "medium", seed: 99 });
    const b = new Dust({ tier: "medium", seed: 99 });
    const c = new Dust({ tier: "medium", seed: 100 });
    const pa = a.geometry.getAttribute("position").array;
    const pb = b.geometry.getAttribute("position").array;
    const pc = c.geometry.getAttribute("position").array;
    expect(Array.from(pa)).toEqual(Array.from(pb));
    expect(Array.from(pa)).not.toEqual(Array.from(pc));
    a.dispose();
    b.dispose();
    c.dispose();
  });

  it("gives every point a seed in [0, 1)", () => {
    const d = new Dust({ tier: "low", seed: 3 });
    const s = d.geometry.getAttribute("aSeed").array as Float32Array;
    expect(s.length).toBe(6000);
    for (const v of s) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    d.dispose();
  });

  it("distributes seeds — a constant seed would make all dust pulse in unison", () => {
    const d = new Dust({ tier: "low", seed: 5 });
    const s = Array.from(d.geometry.getAttribute("aSeed").array as Float32Array);
    const buckets = new Array(10).fill(0);
    for (const v of s) buckets[Math.floor(v * 10)] = (buckets[Math.floor(v * 10)] ?? 0) + 1;
    for (const n of buckets) expect(n).toBeGreaterThan(0);
    d.dispose();
  });
});

describe("Dust — governor", () => {
  it("halves the visible count at L4 (§9.7)", () => {
    const d = new Dust({ tier: "high" });
    for (const lvl of [0, 1, 2, 3]) {
      d.setGovernorLevel(lvl);
      expect(d.drawn).toBe(d.count);
    }
    d.setGovernorLevel(4);
    expect(d.drawn).toBe(Math.floor(d.count / 2));
    expect(d.geometry.drawRange.count).toBe(Math.floor(d.count / 2));
    d.setGovernorLevel(6);
    expect(d.drawn).toBe(Math.floor(d.count / 2));
    d.dispose();
  });

  it("regenerates at the new count when the tier changes", () => {
    const d = new Dust({ tier: "high" });
    d.setTier("low");
    expect(d.count).toBe(6000);
    expect(d.drawn).toBe(6000);
    expect(d.geometry.getAttribute("position").count).toBe(6000);
    d.dispose();
  });

  it("keeps the seeded positions when the draw range changes", () => {
    // Which half is dropped must not depend on when the level moved, or the same
    // seed would show different dust at L3 and L4.
    const d = new Dust({ tier: "high", seed: 21 });
    const before = Array.from(d.geometry.getAttribute("position").array as Float32Array);
    d.setGovernorLevel(4);
    const after = Array.from(d.geometry.getAttribute("position").array as Float32Array);
    expect(after).toEqual(before);
    d.dispose();
  });
});

describe("Dust — uniforms and §9.11", () => {
  it("clamps point size to §9.7's [1, 6] px", () => {
    // Exported so the clamp is asserted rather than trusted; the shader is where it
    // is applied, but a uniform drifting outside the range means the clamp is not
    // doing what the spec says.
    expect(DUST_SIZE.min).toBe(1);
    expect(DUST_SIZE.max).toBe(6);
    const d = new Dust({ tier: "high" });
    expect(d.material.uniforms.uSizeMin!.value).toBe(1);
    expect(d.material.uniforms.uSizeMax!.value).toBe(6);
    d.dispose();
  });

  it("uses §9.7's 0.4 drift amplitude", () => {
    expect(DUST_DRIFT).toBe(0.4);
  });

  it("feeds time, pixel ratio, high band and colour", () => {
    const d = new Dust({ tier: "high" });
    d.update(3.5, 1.5, 0.8, { r: 0.1, g: 0.2, b: 0.3 });
    expect(d.material.uniforms.uTime!.value).toBe(3.5);
    expect(d.material.uniforms.uPixelRatio!.value).toBe(1.5);
    expect(d.material.uniforms.uHigh!.value).toBe(0.8);
    const c = d.material.uniforms.uColor!.value as THREE.Color;
    expect(c.r).toBeCloseTo(0.1, 5);
    expect(c.g).toBeCloseTo(0.2, 5);
    expect(c.b).toBeCloseTo(0.3, 5);
    d.dispose();
  });

  it("scales the twinkle under §9.11 reduced motion", () => {
    const d = new Dust({ tier: "high" });
    expect(d.material.uniforms.uTwinkle!.value).toBe(1);
    d.setTwinkleScale(0);
    expect(d.material.uniforms.uTwinkle!.value).toBe(0);
    d.dispose();
  });

  it("culls nothing — the shell is always partly in frustum", () => {
    const d = new Dust({ tier: "high" });
    expect(d.points.frustumCulled).toBe(false);
    // §9.2's order: dust draws first, behind everything.
    expect(d.points.renderOrder).toBe(0);
    d.dispose();
  });
});

describe("Dust constants", () => {
  it("exports the spec's shell", () => {
    expect(DUST_SHELL.inner).toBe(3);
    expect(DUST_SHELL.outer).toBe(40);
  });

  it("exports a namespace object for the harness", () => {
    expect(DUST.shell).toEqual({ inner: 3, outer: 40 });
  });
});

describe("Dust — the C11b base opacity", () => {
  it("defaults to the value chosen by eye, not the spec's implicit 1.0", () => {
    // §9.7 never says what the twinkle multiplies. At 1.0 the motes render at full
    // strength and 30 000 of them additive on dark read as a starfield rather than
    // as dust around the orb. 0.35 is the sweep's chosen value.
    expect(DUST_BASE_ALPHA).toBeCloseTo(0.35);
    const d = new Dust({ tier: "high" });
    expect(d.material.uniforms.uBaseAlpha!.value).toBeCloseTo(DUST_BASE_ALPHA);
    d.dispose();
  });

  it("stays in the band where dust reads as depth rather than as subject", () => {
    // The sweep measured corner-patch std-dev: 1.0 → 6.12 (a starfield, and over
    // T4.4's ceiling of 6), 0.35 → 2.16, 0.15 → 0.56 (barely present at all). The
    // useful band is between "competing subject" and "invisible".
    expect(DUST_BASE_ALPHA).toBeGreaterThan(0.15);
    expect(DUST_BASE_ALPHA).toBeLessThan(0.6);
  });

  it("is overridable, so the choice can be revisited without a code change", () => {
    const d = new Dust({ tier: "high" });
    d.setBaseAlpha(1);
    expect(d.material.uniforms.uBaseAlpha!.value).toBe(1);
    d.setBaseAlpha(0);
    expect(d.material.uniforms.uBaseAlpha!.value).toBe(0);
    d.dispose();
  });

  it("scales the density independently of the opacity", () => {
    // The sweep found density is the wrong lever — 35 % of the count scores
    // identically to no dust at all. The knob stays so that finding stays testable.
    const d = new Dust({ tier: "high" });
    d.setDensity(0.35);
    expect(d.drawn).toBe(Math.round(30000 * 0.35));
    expect(d.material.uniforms.uBaseAlpha!.value).toBeCloseTo(DUST_BASE_ALPHA);
    d.setDensity(1);
    expect(d.drawn).toBe(30000);
    d.dispose();
  });
});