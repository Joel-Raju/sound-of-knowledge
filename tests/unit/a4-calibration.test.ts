/**
 * A4 calibration — the geometry, asserted without a browser or an audio device.
 *
 * The point of `engine/debug/a4-calibration.ts` is that a human can answer A4 by
 * comparing a direction printed on the screen with the direction a sound arrives from.
 * That is only worth anything if the plan's directions are real, so this asserts the
 * geometry directly against the same `SpatialMapper` the scheduler uses.
 */
import { describe, expect, it } from "vitest";
import {
  A4_DIRECTIONS,
  a4Basis,
  a4Target,
  planA4,
  type A4Basis,
  type A4Direction,
} from "../../engine/debug/a4-calibration";
import { SpatialMapper } from "../../engine/music/spatial-mapper";
import { CameraRig } from "../../engine/visual/camera-rig";

/** A rig pose pointing down -Z, which is three.js's default camera orientation. */
const basisFor = (forward: { x: number; y: number; z: number }): A4Basis => a4Basis(forward);

/**
 * Forward vectors the rig can actually produce.
 *
 * `forward = (0,1,0)` is deliberately absent: it is degenerate *by definition*, because
 * with the listener looking straight up, "in front of you" and "above you" are the same
 * direction, so FRONT and ABOVE coincide and BELOW and BEHIND coincide. That is a true
 * statement about geometry, not a bug — and `CAMERA.pitchClamp` is 1.2 rad, so the rig
 * can never reach that pose anyway. It is covered separately, for NaN-safety only.
 */
const FORWARDS = [
  { x: 0, y: 0, z: -1 },
  { x: 1, y: 0, z: 0 },
  { x: 0.577, y: 0.577, z: -0.577 },
  { x: -0.707, y: 0, z: 0.707 },
  { x: 0.2, y: -0.9, z: -0.38 },
];

const dot = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  a.x * b.x + a.y * b.y + a.z * b.z;

describe("A4 calibration — basis", () => {
  it("the six targets are six distinct unit vectors for any forward", () => {
    for (const f of FORWARDS) {
      const b = basisFor(f);
      const vecs = A4_DIRECTIONS.map((d) => a4Target(b, d));
      for (const v of vecs) expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(1, 6);
      // No two targets may coincide, or "LEFT" and "RIGHT" would be the same direction.
      for (let i = 0; i < vecs.length; i++) {
        for (let j = i + 1; j < vecs.length; j++) {
          expect(dot(vecs[i]!, vecs[j]!)).toBeLessThan(0.999);
        }
      }
    }
  });

  it("RIGHT is perpendicular to FORWARD and LEFT is its negation", () => {
    const b = basisFor({ x: 0, y: 0, z: -1 });
    expect(dot(b.right, b.forward)).toBeCloseTo(0, 6);
    const l = a4Target(b, "LEFT");
    const r = a4Target(b, "RIGHT");
    expect(dot(l, r)).toBeCloseTo(-1, 6);
  });

  it("survives a forward parallel to world-up without producing NaN", () => {
    // `cross(forward, worldUp)` degenerates to zero here; the guard falls back to +X.
    const b = basisFor({ x: 0, y: 1, z: 0 });
    expect(Number.isFinite(b.right.x)).toBe(true);
    expect(Math.hypot(b.right.x, b.right.y, b.right.z)).toBeCloseTo(1, 6);
  });
});

describe("A4 calibration — the plan", () => {
  it("produces one step per named direction, from any camera forward", () => {
    for (const f of FORWARDS) {
      const steps = planA4(basisFor(f));
      expect(steps.map((s) => s.label).sort()).toEqual([...A4_DIRECTIONS].sort());
    }
  });

  it("each step's edit ACTUALLY lands within 22 deg of the direction it is named for", () => {
    // This is the assertion that makes the human test mean anything. If `placeEdit`
    // disagreed with the label, the screen would state a direction the sound does not
    // come from, and a failure would be indistinguishable from a broken panner.
    for (const f of FORWARDS) {
      const basis = basisFor(f);
      for (const step of planA4(basis)) {
        expect(
          step.errorDeg,
          `${step.label} should land near ${step.label}, was ${step.errorDeg.toFixed(1)} deg off`,
        ).toBeLessThan(22);
      }
    }
  });

  it("the recorded dir is the one placeEdit returns for that exact triple", () => {
    // Guards against the plan reporting a direction it did not actually compute.
    const m = new SpatialMapper();
    const basis = basisFor({ x: 0, y: 0, z: -1 });
    const scratch = { x: 0, y: 0, z: 0 };
    for (const step of planA4(basis)) {
      m.placeEdit(step.wiki, step.title, step.id, scratch);
      // `planA4` hashes `wiki` as the title too; check against the triple it recorded.
      m.placeEdit(step.wiki, step.wiki, step.id, scratch);
      expect(scratch.x).toBeCloseTo(step.dir.x, 12);
      expect(scratch.y).toBeCloseTo(step.dir.y, 12);
      expect(scratch.z).toBeCloseTo(step.dir.z, 12);
    }
  });

  it("is deterministic — the same basis yields the same plan", () => {
    const b = basisFor({ x: 0.577, y: 0.577, z: -0.577 });
    expect(JSON.stringify(planA4(b))).toBe(JSON.stringify(planA4(b)));
  });

  it("never reuses one edit for two directions", () => {
    for (const f of FORWARDS) {
      const keys = planA4(basisFor(f)).map((s) => `${s.wiki}:${s.id}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("names the edit after the direction, so the screen states the expected answer", () => {
    for (const step of planA4(basisFor({ x: 0, y: 0, z: -1 }))) {
      expect(step.title).toBe(`A4 ${step.label}`);
    }
  });
});

describe("A4 calibration — the camera freeze", () => {
  it("auto-orbit advances yaw when enabled and holds it when disabled", () => {
    // Asserted on the orbit angle, not on `position`. A rig — frozen or not — is still
    // running its 2.5 s entrance dolly and §9.11's drift, so `position` is never constant
    // and asserting it would test the entrance rather than the freeze. An earlier
    // version asserted a still `position` and failed on 5.61 vs 9, which is the entrance
    // easing correctly.
    const SECS = 5;
    const FRAMES = SECS * 60;

    const on = new CameraRig();
    for (let i = 0; i < FRAMES; i++) on.update(1 / 60, 0);

    const off = new CameraRig();
    off.setAutoOrbit(false);
    for (let i = 0; i < FRAMES; i++) off.update(1 / 60, 0);

    // 0.03 rad/s for 5 s = 0.15 rad.
    expect(on.orbitYaw).toBeCloseTo(0.15, 6);
    expect(off.orbitYaw).toBe(0);

    // And it stays held, rather than merely lagging.
    for (let i = 0; i < FRAMES; i++) off.update(1 / 60, 0);
    expect(off.orbitYaw).toBe(0);
  });

  it("the orbit still moves the camera enough to matter over 5 s", () => {
    // Guards the assertion above from being satisfied by a rig that never orbits at all.
    const a = new CameraRig();
    for (let i = 0; i < 300; i++) a.update(1 / 60, 0);
    const b = new CameraRig();
    b.setAutoOrbit(false);
    for (let i = 0; i < 300; i++) b.update(1 / 60, 0);
    expect(Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z)).toBeGreaterThan(0.2);
  });

  it("defaults to orbiting — the freeze is opt-in and cannot be reached from Settings", () => {
    expect(new CameraRig().autoOrbitEnabled).toBe(true);
  });

  it("reduceMotion does NOT stop the orbit (§9.11 damps drift and shake, not parallax)", () => {
    // Asserted because it is surprising and it is why the freeze had to be added at all.
    const rig = new CameraRig();
    rig.setReduceMotion(true);
    const before = { ...rig.position };
    for (let i = 0; i < 300; i++) rig.update(1 / 60, 0);
    const moved = Math.hypot(
      rig.position.x - before.x,
      rig.position.y - before.y,
      rig.position.z - before.z,
    );
    expect(moved).toBeGreaterThan(0.5);
  });
});

describe("A4 calibration — direction coverage", () => {
  it("every direction is served by an edit whose alignment is better than a random guess", () => {
    // Guards against a silently-degraded search: if CANDIDATE_WIKIS shrank, the best
    // available alignment would drop and this would fail rather than silently return a
    // plan with a 60-degree error labelled "LEFT".
    const basis = basisFor({ x: 0, y: 0, z: -1 });
    for (const step of planA4(basis)) {
      const align = dot(step.dir, a4Target(basis, step.label as A4Direction));
      expect(align).toBeGreaterThan(0.9);
    }
  });
});
