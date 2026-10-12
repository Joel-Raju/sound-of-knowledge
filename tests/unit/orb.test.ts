import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  Orb,
  IMPACT_LIFETIME_SEC,
  IMPACT_MIN_STRENGTH,
  IMPACT_MAX_STRENGTH,
} from "@/engine/visual/orb";
import { IMPACT_SLOTS, MAX_OCTAVES, MAX_STEPS } from "@/engine/visual/shaders/orb.vert";
import { Palette } from "@/engine/visual/palette";
import { TIER_PARAMS } from "@/engine/config";
import { createAudioFeatures } from "@/engine/types";

/**
 * Spec §9.4 — the orb's CPU side. The shaders cannot be unit-tested here; what
 * can be, and what silently breaks, is the impact ring buffer and the tier
 * parameter mapping.
 */

const features = () => {
  const f = createAudioFeatures();
  f.rms = 0.3;
  f.bass = 0.4;
  f.mid = 0.5;
  f.high = 0.2;
  f.flux = 0.1;
  return f;
};

const dir = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

describe("Orb — geometry and tier parameters (§9.4, §12.3)", () => {
  it("uses an icosphere of radius 1.2 at the tier's detail", () => {
    // §9.4: `IcosahedronGeometry(1.2, detail)`, detail 5 / 4 / 3 by tier.
    for (const tier of ["low", "medium", "high"] as const) {
      const orb = new Orb({ tier });
      // three.js subdivides each of the 20 base faces into (detail+1)^2, so
      // detail 3/4/5 is 320/500/720 triangles — not 20*4^detail.
      const expected = 20 * (TIER_PARAMS[tier].orbDetail + 1) ** 2;
      expect(orb.geometry.index, `${tier} should be non-indexed`).toBeNull();
      expect(orb.geometry.attributes.position!.count / 3, tier).toBe(expected);
      orb.dispose();
    }
  });

  it("has every vertex on the sphere of radius 1.2", () => {
    const orb = new Orb({ tier: "low" });
    const pos = orb.geometry.attributes.position!;
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i));
      expect(r, `vertex ${i}`).toBeCloseTo(1.2, 5);
    }
    orb.dispose();
  });

  it("gives every vertex a unit normal", () => {
    // An un-normalised or zero normal makes `normalize(vNormalW)` NaN in the
    // fragment stage, and a NaN colour renders as nothing.
    const orb = new Orb({ tier: "low" });
    const nrm = orb.geometry.attributes.normal!;
    for (let i = 0; i < nrm.count; i++) {
      const l = Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
      expect(l, `normal ${i}`).toBeCloseTo(1, 5);
    }
    orb.dispose();
  });

  it("maps the tier's steps and octaves into the uniforms", () => {
    for (const tier of ["low", "medium", "high"] as const) {
      const orb = new Orb({ tier });
      const u = orb.material.uniforms;
      expect(u.uSteps!.value, tier).toBe(TIER_PARAMS[tier].orbSteps);
      expect(u.uOctaves!.value, tier).toBe(TIER_PARAMS[tier].orbOctaves);
      orb.dispose();
    }
  });

  it("never exceeds the shader's constant loop bounds", () => {
    // MAX_STEPS / MAX_OCTAVES are loop bounds baked into the GLSL. A uniform
    // above them is silently ignored, which would look like the governor doing
    // nothing rather than like an error.
    for (const tier of ["low", "medium", "high"] as const) {
      const orb = new Orb({ tier });
      expect(orb.material.uniforms.uSteps!.value).toBeLessThanOrEqual(MAX_STEPS);
      expect(orb.material.uniforms.uOctaves!.value).toBeLessThanOrEqual(MAX_OCTAVES);
      orb.dispose();
    }
  });

  it("blends additively and does not write depth, per §9.2", () => {
    const orb = new Orb();
    expect(orb.material.blending).toBe(THREE.AdditiveBlending);
    // The orb is one convex volume with nothing behind it; depth writes cost
    // fill rate and can only occlude things they should not.
    expect(orb.material.depthWrite).toBe(false);
    orb.dispose();
  });

  it("declares GLSL3, so three.js does not prepend a second fragment output", () => {
    // Without this, three.js assumes GLSL1 and injects its own
    // `layout(location = 0) out vec4 pc_fragColor`, which collides with the
    // shader's `out vec4 outColor` and fails to link.
    expect(new Orb().material.glslVersion).toBe(THREE.GLSL3);
  });
});

describe("Orb — impact ring buffer (§9.4)", () => {
  it("starts with every slot empty", () => {
    const orb = new Orb();
    expect(orb.impactA).toHaveLength(IMPACT_SLOTS);
    expect(orb.impactCount).toBe(0);
    orb.dispose();
  });

  it("records a push impact at kind 0 and a dent at kind 1", () => {
    const orb = new Orb();
    orb.addImpact(dir(0, 1, 0), 1, "push", 0);
    expect(orb.impactB[0]!.y).toBe(0);
    orb.addImpact(dir(0, 1, 0), 1, "dent", 0);
    expect(orb.impactB[1]!.y).toBe(1);
    orb.dispose();
  });

  it("maps magnitude to `lerp(0.25, 1.0, magnitude)`", () => {
    const orb = new Orb();
    orb.addImpact(dir(0, 1, 0), 0, "push", 0);
    expect(orb.impactA[0]!.w).toBeCloseTo(IMPACT_MIN_STRENGTH, 9);
    orb.addImpact(dir(0, 1, 0), 1, "push", 0);
    expect(orb.impactA[1]!.w).toBeCloseTo(IMPACT_MAX_STRENGTH, 9);
    orb.addImpact(dir(0, 1, 0), 0.5, "push", 0);
    expect(orb.impactA[2]!.w).toBeCloseTo(0.625, 9);
    orb.dispose();
  });

  it("clamps magnitude out of range", () => {
    const orb = new Orb();
    orb.addImpact(dir(0, 1, 0), -5, "push", 0);
    expect(orb.impactA[0]!.w).toBeCloseTo(IMPACT_MIN_STRENGTH, 9);
    orb.addImpact(dir(0, 1, 0), 5, "push", 0);
    expect(orb.impactA[1]!.w).toBeCloseTo(IMPACT_MAX_STRENGTH, 9);
    orb.dispose();
  });

  it("never writes a zero strength, even at magnitude 0", () => {
    // §9.4's floor exists so a small edit is still visibly *something*. A zero
    // would make the shader's `if (s <= 0.0) continue` skip it entirely.
    const orb = new Orb();
    orb.addImpact(dir(0, 1, 0), 0, "push", 0);
    expect(orb.impactA[0]!.w).toBeGreaterThan(0);
    orb.dispose();
  });

  it("normalises the direction", () => {
    // The shader computes `acos(dot(dir, impactDir))`, which is only an angle
    // if both are unit length.
    const orb = new Orb();
    orb.addImpact(dir(0, 17, 0), 1, "push", 0);
    expect(orb.impactA[0]!.y).toBeCloseTo(1, 9);
    expect(orb.impactA[0]!.x).toBeCloseTo(0, 9);
    orb.dispose();
  });

  it("substitutes a unit direction for a zero-length one", () => {
    // acos(dot(dir, vec3(0))) is acos(0), which is fine, but a zero vector fed
    // to `normalize` is NaN and would blank the whole fragment.
    const orb = new Orb();
    orb.addImpact(dir(0, 0, 0), 1, "push", 0);
    const a = orb.impactA[0]!;
    expect(Math.hypot(a.x, a.y, a.z)).toBeCloseTo(1, 9);
    orb.dispose();
  });

  it("overwrites the oldest slot once full, per §9.4", () => {
    const orb = new Orb();
    for (let i = 0; i < IMPACT_SLOTS; i++) {
      orb.addImpact(dir(0, 1, 0), 1, "push", i);
      expect(orb.cursorIndex).toBe((i + 1) % IMPACT_SLOTS);
    }
    expect(orb.impactCount).toBe(IMPACT_SLOTS);

    // The next impact lands in slot 0 — the one written first.
    orb.addImpact(dir(1, 0, 0), 0.5, "dent", 100);
    expect(orb.impactA[0]!.x).toBeCloseTo(1, 9);
    expect(orb.impactB[0]!.x).toBe(100);
    expect(orb.impactCount).toBe(IMPACT_SLOTS);
    orb.dispose();
  });

  it("never exceeds the ring size, however many arrive", () => {
    const orb = new Orb();
    for (let i = 0; i < IMPACT_SLOTS * 7; i++) {
      orb.addImpact(dir(0, 1, 0), 1, "push", i);
    }
    expect(orb.impactA).toHaveLength(IMPACT_SLOTS);
    expect(orb.impactCount).toBe(IMPACT_SLOTS);
    orb.dispose();
  });

  it("expires impacts older than 2.5 s, per §9.4", () => {
    const orb = new Orb();
    const palette = new Palette("lydian", 0);
    orb.addImpact(dir(0, 1, 0), 1, "push", 0);
    orb.update(IMPACT_LIFETIME_SEC - 0.01, features(), palette);
    expect(orb.impactCount).toBe(1);

    orb.update(IMPACT_LIFETIME_SEC + 0.01, features(), palette);
    expect(orb.impactCount).toBe(0);
    orb.dispose();
  });

  it("expires an impact dated in the future", () => {
    // `age < 0` is the shader's other guard; a clock that went backwards must
    // not leave a slot live indefinitely.
    const orb = new Orb();
    const palette = new Palette("lydian", 0);
    orb.addImpact(dir(0, 1, 0), 1, "push", 100);
    orb.update(0, features(), palette);
    expect(orb.impactCount).toBe(0);
    orb.dispose();
  });

  it("expires impacts with no update calls at all in between", () => {
    // A quiet session must still stop showing ripples; nothing else drives this.
    const orb = new Orb();
    const palette = new Palette("lydian", 0);
    orb.addImpact(dir(0, 1, 0), 1, "push", 0);
    orb.update(10, features(), palette);
    expect(orb.impactCount).toBe(0);
    orb.dispose();
  });
});

describe("Orb — governor levels (§9.10)", () => {
  it("leaves the tier's own steps and octaves alone below L3", () => {
    for (const level of [0, 1, 2]) {
      const orb = new Orb({ tier: "medium" });
      orb.applyGovernor(level);
      expect(orb.material.uniforms.uSteps!.value, `L${level}`).toBe(TIER_PARAMS.medium.orbSteps);
      expect(orb.material.uniforms.uOctaves!.value, `L${level}`).toBe(
        TIER_PARAMS.medium.orbOctaves,
      );
      orb.dispose();
    }
  });

  it("applies L3's steps −2 (min 3) and octaves 2", () => {
    const orb = new Orb({ tier: "high" });
    orb.applyGovernor(3);
    expect(orb.material.uniforms.uSteps!.value).toBe(TIER_PARAMS.high.orbSteps - 2);
    expect(orb.material.uniforms.uOctaves!.value).toBe(2);
    orb.dispose();
  });

  it("never takes the low tier below 3 steps", () => {
    // §9.10 floors steps at 3, and the low tier's own count is already 3.
    const orb = new Orb({ tier: "low" });
    for (const level of [3, 4, 5, 6]) {
      orb.applyGovernor(level);
      expect(orb.material.uniforms.uSteps!.value, `L${level}`).toBeGreaterThanOrEqual(3);
    }
    orb.dispose();
  });

  it("holds at L3 and above — nothing further degrades the orb", () => {
    // L4–L6 are dust, event rate and bloom; the orb is already at its floor.
    const orb = new Orb({ tier: "high" });
    const at3 = ((): { s: number; o: number } => {
      orb.applyGovernor(3);
      return {
        s: orb.material.uniforms.uSteps!.value as number,
        o: orb.material.uniforms.uOctaves!.value as number,
      };
    })();
    for (const level of [4, 5, 6]) {
      orb.applyGovernor(level);
      expect(orb.material.uniforms.uSteps!.value, `L${level}`).toBe(at3.s);
      expect(orb.material.uniforms.uOctaves!.value, `L${level}`).toBe(at3.o);
    }
    orb.dispose();
  });
});

describe("Orb — per-frame update", () => {
  it("writes the features into the uniforms", () => {
    const orb = new Orb();
    const palette = new Palette("lydian", 0);
    const f = features();
    f.rms = 0.7;
    f.bass = 0.8;
    f.mid = 0.6;
    f.high = 0.4;
    f.flux = 0.9;
    orb.update(1.5, f, palette);
    const u = orb.material.uniforms;
    expect(u.uRms!.value).toBeCloseTo(0.7, 9);
    expect(u.uBass!.value).toBeCloseTo(0.8, 9);
    expect(u.uMid!.value).toBeCloseTo(0.6, 9);
    expect(u.uHigh!.value).toBeCloseTo(0.4, 9);
    expect(u.uFlux!.value).toBeCloseTo(0.9, 9);
    expect(u.uTime!.value).toBeCloseTo(1.5, 9);
    orb.dispose();
  });

  it("clamps features out of range", () => {
    const orb = new Orb();
    const palette = new Palette("lydian", 0);
    const f = features();
    f.rms = 5;
    f.bass = -3;
    orb.update(0, f, palette);
    expect(orb.material.uniforms.uRms!.value).toBe(1);
    expect(orb.material.uniforms.uBass!.value).toBe(0);
    orb.dispose();
  });

  it("advances uFrame every frame so the dither does not freeze", () => {
    const orb = new Orb();
    const palette = new Palette("lydian", 0);
    const seen = new Set<number>();
    for (let i = 0; i < 20; i++) {
      orb.update(i / 60, features(), palette);
      seen.add(orb.material.uniforms.uFrame!.value as number);
    }
    expect(seen.size).toBe(20);
    orb.dispose();
  });

  it("keeps uFrame bounded so it cannot drift into float error", () => {
    const orb = new Orb();
    const palette = new Palette("lydian", 0);
    let t = 0;
    for (let i = 0; i < 3000; i++) {
      orb.update((t += 1 / 60), features(), palette);
    }
    expect(orb.material.uniforms.uFrame!.value as number).toBeLessThanOrEqual(4096);
    orb.dispose();
  });

  it("uploads the palette's *current* colour, not its target", () => {
    // The orb must drift with the scene on a harmony change rather than snap
    // ahead of it.
    const orb = new Orb();
    const palette = new Palette("lydian", 0);
    palette.set("aeolian", 0, false);
    orb.update(0, features(), palette);
    const before = (orb.material.uniforms.uCoreColor!.value as THREE.Color).r;
    for (let i = 0; i < 600; i++) {
      palette.update(1 / 60);
      orb.update(i / 60, features(), palette);
    }
    const after = (orb.material.uniforms.uCoreColor!.value as THREE.Color).r;
    expect(after).not.toBeCloseTo(before, 6);
    orb.dispose();
  });

  it("stays finite across a long run with impacts firing throughout", () => {
    const orb = new Orb();
    const palette = new Palette("lydian", 0);
    const f = features();
    const d = new THREE.Vector3();
    for (let i = 0; i < 4000; i++) {
      if (i % 23 === 0) orb.addSyntheticImpacts(3, (i % 10) / 10, i % 2 ? "dent" : "push", i / 60);
      orb.update(i / 60, f, palette);
      const u = orb.material.uniforms;
      for (const key of ["uTime", "uFrame", "uRms", "uBass", "uMid", "uHigh", "uFlux"]) {
        expect(Number.isFinite(u[key]!.value as number), `${key} @${i}`).toBe(true);
      }
      for (let k = 0; k < IMPACT_SLOTS; k++) {
        for (const v of [
          orb.impactA[k]!.x,
          orb.impactA[k]!.y,
          orb.impactA[k]!.z,
          orb.impactA[k]!.w,
        ]) {
          expect(Number.isFinite(v), `impactA[${k}] @${i}`).toBe(true);
        }
      }
      void d;
    }
    orb.dispose();
  });
});

describe("Orb — synthetic impacts (screenshot harness)", () => {
  it("is deterministic for a given sequence", () => {
    // §13.4's captures must be comparable run to run.
    const a = new Orb();
    const b = new Orb();
    a.addSyntheticImpacts(6, 0.7, "push", 0);
    b.addSyntheticImpacts(6, 0.7, "push", 0);
    for (let i = 0; i < IMPACT_SLOTS; i++) {
      expect(a.impactA[i]!.x).toBe(b.impactA[i]!.x);
      expect(a.impactA[i]!.y).toBe(b.impactA[i]!.y);
      expect(a.impactA[i]!.z).toBe(b.impactA[i]!.z);
    }
    a.dispose();
    b.dispose();
  });

  it("spreads directions over the sphere rather than clustering", () => {
    const orb = new Orb();
    orb.addSyntheticImpacts(8, 1, "push", 0);
    for (let i = 0; i < 8; i++) {
      expect(Math.hypot(orb.impactA[i]!.x, orb.impactA[i]!.y, orb.impactA[i]!.z)).toBeCloseTo(1, 6);
    }
    // Eight points on a sphere: no two should be nearly coincident.
    for (let i = 0; i < 8; i++) {
      for (let j = i + 1; j < 8; j++) {
        const dot =
          orb.impactA[i]!.x * orb.impactA[j]!.x +
          orb.impactA[i]!.y * orb.impactA[j]!.y +
          orb.impactA[i]!.z * orb.impactA[j]!.z;
        expect(Math.abs(dot), `${i} vs ${j}`).toBeLessThan(0.999);
      }
    }
    orb.dispose();
  });

  it("does not change the sequence when impacts are batched differently", () => {
    // The screenshot harness fires 6 then 3; an e2e test might fire 9 at once.
    // The renders must be identical either way, or a capture is only comparable
    // to another capture that used the same batching.
    const batched = new Orb();
    batched.addSyntheticImpacts(9, 0.7, "push", 0);
    const split = new Orb();
    split.addSyntheticImpacts(6, 0.7, "push", 0);
    split.addSyntheticImpacts(3, 0.7, "push", 0);

    for (let i = 0; i < 9; i++) {
      expect(batched.impactA[i]!.x, `slot ${i} x`).toBe(split.impactA[i]!.x);
      expect(batched.impactA[i]!.y, `slot ${i} y`).toBe(split.impactA[i]!.y);
      expect(batched.impactA[i]!.z, `slot ${i} z`).toBe(split.impactA[i]!.z);
    }
    batched.dispose();
    split.dispose();
  });
});
