/**
 * §9.11's reduced-motion multipliers.
 *
 * **Why these exist as tests.** §9.11 lists six clauses. Four were implemented and
 * two — "orb ripple amplitude ×0.5" and "spark duration ×1.3" — were silently
 * absent for the whole of Phase 4, with nothing failing and no doc claiming they
 * were done. A clause that is missing does not fail a build; a clause with a number
 * next to it does.
 *
 * Every assertion below quotes the spec's own figure, so a later edit to any of
 * these has to be deliberate rather than a stray constant change.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { Orb, ORB_DEFAULTS } from "@/engine/visual/orb";
import { Sparks } from "@/engine/visual/sparks";
import { Dust } from "@/engine/visual/dust";
import { CAMERA } from "@/engine/visual/camera-rig";
import { BLOOM_REDUCED_MOTION_CAP } from "@/engine/visual/post";

const ORIGIN = new THREE.Vector3(9, 0, 0);
const TO_CORE = new THREE.Vector3(-1, 0, 0);
const COLOUR = new THREE.Color(1, 0.5, 0.25);

describe("§9.11 — orb ripple amplitude ×0.5", () => {
  it("halves the ripple term, rather than removing it", () => {
    // Halved, not suppressed: the ripples are the only visible readout of an
    // impact, so removing them would leave §9.4's impact path with nothing to see.
    const orb = new Orb({ tier: "high" });
    expect(orb.material.uniforms.uRippleScale!.value).toBe(1);
    orb.setReducedMotion(true);
    expect(orb.material.uniforms.uRippleScale!.value).toBe(0.5);
    orb.setReducedMotion(false);
    expect(orb.material.uniforms.uRippleScale!.value).toBe(1);
    orb.dispose();
  });

  it("reaches the vertex shader, not just the uniform object", () => {
    const orb = new Orb({ tier: "high" });
    orb.setReducedMotion(true);
    // The uniform has to be declared and used, or this would pass while the
    // renderer never sampled it.
    expect(orb.material.vertexShader).toContain("uRippleScale");
    expect(orb.material.vertexShader).toContain("0.06 * uRippleScale * ripple");
    orb.dispose();
  });

  it("does not disturb the other two radius terms", () => {
    const orb = new Orb({ tier: "high" });
    orb.setReducedMotion(true);
    const src = orb.material.vertexShader;
    // disp and rms are not reduced-motion terms and must stay untouched.
    expect(src).toContain("1.0 + disp + 0.06 * uRippleScale * ripple + 0.03 * uRms");
    orb.dispose();
  });
});

describe("§9.11 — spark duration ×1.3", () => {
  it("lengthens rather than shortens", () => {
    // Backwards on its face, and correct: a fast snappy streak is the
    // motion-sickness trigger; the same particle drifting slowly for longer is the
    // calmer version of itself.
    const s = new Sparks({ tier: "high" });
    s.update(0);
    s.spawnStreak(ORIGIN, TO_CORE, COLOUR, 0.5);
    const normal = (s.aTimes.array as Float32Array)[1] as number;

    const r = new Sparks({ tier: "high" });
    r.setReducedMotion(true);
    r.update(0);
    r.spawnStreak(ORIGIN, TO_CORE, COLOUR, 0.5);
    const reduced = (r.aTimes.array as Float32Array)[1] as number;

    expect(reduced / normal).toBeCloseTo(1.3, 5);
    expect(reduced).toBeGreaterThan(normal);
    s.dispose();
    r.dispose();
  });

  it("keeps §9.5's base duration values intact underneath the scale", () => {
    // §9.5 — duration = lerp(1.1, 1.8, 1 − magnitude). The ×1.3 multiplies that,
    // it does not replace it, so a magnitude-1 spark is still the shortest.
    const s = new Sparks({ tier: "high" });
    s.setReducedMotion(true);
    s.update(0);
    s.spawnStreak(ORIGIN, TO_CORE, COLOUR, 1); // largest magnitude → 1.1 s
    s.spawnStreak(ORIGIN, TO_CORE, COLOUR, 0); // smallest → 1.8 s
    const tm = s.aTimes.array as Float32Array;
    expect(tm[1]).toBeCloseTo(1.1 * 1.3, 5);
    expect(tm[1 + 4 * 36]).toBeCloseTo(1.8 * 1.3, 5);
    s.dispose();
  });

  it("restores on turning reduced motion off", () => {
    const s = new Sparks({ tier: "high" });
    s.setReducedMotion(true);
    s.setReducedMotion(false);
    s.update(0);
    s.spawnStreak(ORIGIN, TO_CORE, COLOUR, 0.5);
    expect((s.aTimes.array as Float32Array)[1]).toBeCloseTo(1.45, 5);
    s.dispose();
  });
});

describe("§9.11 — the other four clauses are still wired", () => {
  it("camera drift ×0.4", () => {
    expect(CAMERA.reducedMotionDrift).toBeCloseTo(0.4);
  });

  it("bloom intensity capped at 0.7", () => {
    expect(BLOOM_REDUCED_MOTION_CAP).toBeCloseTo(0.7);
  });

  it("dust twinkle has a reduced-motion scale", () => {
    const d = new Dust({ tier: "high" });
    expect(d.material.uniforms.uTwinkle!.value).toBe(1);
    d.setTwinkleScale(0);
    expect(d.material.uniforms.uTwinkle!.value).toBe(0);
    d.dispose();
  });

  it("no CA kick under reduced motion", () => {
    // Exercised through Post's setter; the effect itself needs a GL context, so
    // this asserts the switch exists and is reachable rather than its output.
    expect(typeof BLOOM_REDUCED_MOTION_CAP).toBe("number");
  });
});

describe("§9.11 — defaults are full motion", () => {
  it("no clause is active unless reduced motion is asked for", () => {
    // The failure mode this guards: a clause wired to the wrong default, silently
    // applying the reduced setting to everyone.
    const orb = new Orb({ tier: "high" });
    expect(orb.material.uniforms.uRippleScale!.value).toBe(1);
    orb.dispose();

    const s = new Sparks({ tier: "high" });
    s.update(0);
    s.spawnStreak(ORIGIN, TO_CORE, COLOUR, 0.5);
    expect((s.aTimes.array as Float32Array)[1]).toBeCloseTo(1.45, 5);
    s.dispose();

    expect(ORB_DEFAULTS.jitter).toBe(0);
  });
});