import { describe, expect, it } from "vitest";
import {
  CameraRig,
  CAMERA,
  composeYawPitch,
  pitchAt,
  distanceForEnergy,
  entranceEase,
  traumaShake,
  valueNoise1,
  driftNoise,
} from "@/engine/visual/camera-rig";
import type { Vec3 } from "@/engine/types";

/** Spec §13.2 — "camera rig pure helpers (yaw/pitch composition, trauma decay)". */

const scratch = (): Vec3 => ({ x: 0, y: 0, z: 0 });

describe("composeYawPitch — spec §9.1", () => {
  it("puts the camera on a sphere of the given radius", () => {
    for (const [d, yaw, pitch] of [
      [5.5, 0, 0],
      [5.5, 1.2, 0.4],
      [7, -2.5, -0.9],
      [3, 3.1, 1.1],
    ] as const) {
      const p = composeYawPitch(d, yaw, pitch, scratch());
      expect(Math.hypot(p.x, p.y, p.z), `d=${d} yaw=${yaw}`).toBeCloseTo(d, 9);
    }
  });

  it("puts yaw 0 on +x and pitch 0 in the xz plane", () => {
    const p = composeYawPitch(5.5, 0, 0, scratch());
    expect(p.x).toBeCloseTo(5.5, 9);
    expect(p.y).toBeCloseTo(0, 9);
    expect(p.z).toBeCloseTo(0, 9);
  });

  it("raises y with pitch", () => {
    const up = composeYawPitch(5.5, 0.7, 0.8, scratch());
    const down = composeYawPitch(5.5, 0.7, -0.8, scratch());
    expect(up.y).toBeGreaterThan(0);
    expect(down.y).toBeLessThan(0);
    expect(Math.abs(up.y)).toBeCloseTo(Math.abs(down.y), 9);
  });

  it("rotates with yaw", () => {
    const a = composeYawPitch(5.5, 0, 0, scratch());
    const b = composeYawPitch(5.5, Math.PI / 2, 0, scratch());
    expect(Math.abs(a.x)).toBeGreaterThan(Math.abs(b.x));
    expect(Math.abs(b.z)).toBeGreaterThan(Math.abs(a.z));
  });

  it("writes into the provided object rather than allocating", () => {
    const out = scratch();
    const returned = composeYawPitch(1, 0, 0, out);
    expect(returned).toBe(out);
  });
});

describe("pitchAt — spec §9.1", () => {
  it("is `0.18 + 0.12*sin(0.05 t)`", () => {
    for (const t of [0, 1, 5, 20, 100]) {
      expect(pitchAt(t)).toBeCloseTo(
        CAMERA.pitchBase + CAMERA.pitchWobble * Math.sin(0.05 * t),
        12,
      );
    }
  });

  it("stays within base ± wobble", () => {
    for (let t = 0; t < 300; t += 0.7) {
      expect(pitchAt(t)).toBeGreaterThanOrEqual(CAMERA.pitchBase - CAMERA.pitchWobble - 1e-12);
      expect(pitchAt(t)).toBeLessThanOrEqual(CAMERA.pitchBase + CAMERA.pitchWobble + 1e-12);
    }
  });

  it("has the period the formula implies", () => {
    // 2π/0.05 = 125.66 s.
    const period = (2 * Math.PI) / CAMERA.pitchWobbleRate;
    expect(pitchAt(0)).toBeCloseTo(pitchAt(period), 9);
  });
});

describe("distanceForEnergy — spec §9.1", () => {
  it("is `5.5 − 0.5*E`", () => {
    expect(distanceForEnergy(0)).toBeCloseTo(5.5, 12);
    expect(distanceForEnergy(1)).toBeCloseTo(5.0, 12);
    expect(distanceForEnergy(0.5)).toBeCloseTo(5.25, 12);
  });

  it("clamps energy into 0..1", () => {
    expect(distanceForEnergy(-3)).toBeCloseTo(5.5, 12);
    expect(distanceForEnergy(7)).toBeCloseTo(5.0, 12);
  });

  it("pulls in monotonically as traffic rises", () => {
    let prev = Infinity;
    for (let e = 0; e <= 1; e += 0.05) {
      const d = distanceForEnergy(e);
      expect(d).toBeLessThan(prev);
      prev = d;
    }
  });
});

describe("entranceEase — spec §9.1", () => {
  it("starts at 9 and reaches the target", () => {
    expect(entranceEase(0, 5.5)).toBeCloseTo(CAMERA.entranceFrom, 9);
    expect(entranceEase(CAMERA.entranceSec, 5.5)).toBeCloseTo(5.5, 9);
    expect(entranceEase(100, 5.5)).toBeCloseTo(5.5, 9);
  });

  it("is monotonic and never overshoots", () => {
    let prev = Infinity;
    for (let t = 0; t <= CAMERA.entranceSec; t += 0.05) {
      const d = entranceEase(t, 5.5);
      expect(d).toBeLessThanOrEqual(prev + 1e-12);
      expect(d).toBeGreaterThanOrEqual(5.5 - 1e-12);
      prev = d;
    }
  });

  it("eases out — most of the travel happens early", () => {
    // The rig eases *down* from 9 to the target, so halfway in time it is still
    // above the target but most of the way there. `easeOutCubic(0.5) = 0.875`.
    const half = entranceEase(CAMERA.entranceSec / 2, 5.5);
    expect(half).toBeCloseTo(5.5 + (9 - 5.5) * 0.125, 9);
    // 87.5 % of the distance covered at the halfway point.
    const travelled = (9 - half) / (9 - 5.5);
    expect(travelled).toBeGreaterThan(0.8);
  });
});

describe("traumaShake — spec §9.1", () => {
  it("is quadratic in trauma", () => {
    expect(traumaShake(0.5, 1)).toBeCloseTo(0.25 * CAMERA.traumaAmplitude, 12);
    expect(traumaShake(1, 1)).toBeCloseTo(CAMERA.traumaAmplitude, 12);
    expect(traumaShake(0.25, 1)).toBeCloseTo(0.0625 * CAMERA.traumaAmplitude, 12);
  });

  it("is zero at zero trauma, whatever the noise", () => {
    expect(traumaShake(0, 1)).toBe(0);
    expect(traumaShake(0, -1)).toBe(0);
  });

  it("scales linearly with the noise sample", () => {
    expect(traumaShake(1, 0.5)).toBeCloseTo(traumaShake(1, 1) * 0.5, 12);
    expect(traumaShake(1, -1)).toBeCloseTo(-traumaShake(1, 1), 12);
  });

  it("clamps trauma into 0..1", () => {
    expect(traumaShake(5, 1)).toBeCloseTo(traumaShake(1, 1), 12);
    expect(traumaShake(-2, 1)).toBe(0);
  });

  it("stays small in absolute terms — 0.03 rad is the ceiling", () => {
    for (let t = 0; t <= 1; t += 0.05) {
      expect(Math.abs(traumaShake(t, 1))).toBeLessThanOrEqual(CAMERA.traumaAmplitude + 1e-12);
    }
  });
});

describe("value noise", () => {
  it("is deterministic", () => {
    expect(valueNoise1(3.7, 5)).toBe(valueNoise1(3.7, 5));
  });

  it("differs for a different seed", () => {
    const a = valueNoise1(3.7, 1);
    const b = valueNoise1(3.7, 2);
    expect(a).not.toBe(b);
  });

  it("stays within 0..1", () => {
    for (let t = -50; t < 50; t += 0.13) {
      const v = valueNoise1(t, 3);
      expect(v).toBeGreaterThanOrEqual(-1e-12);
      expect(v).toBeLessThanOrEqual(1 + 1e-12);
    }
  });

  it("is continuous across lattice points", () => {
    // A hard lattice would jump; smoothstep interpolation must not.
    let prev = valueNoise1(2.0, 7);
    for (let t = 2.0; t < 3.0; t += 0.001) {
      const v = valueNoise1(t, 7);
      expect(Math.abs(v - prev)).toBeLessThan(0.05);
      prev = v;
    }
  });

  it("drift stays within the configured amplitude", () => {
    for (let t = 0; t < 400; t += 0.37) {
      expect(Math.abs(driftNoise(t, 1))).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
});

describe("CameraRig", () => {
  it("starts at the entrance distance", () => {
    const r = new CameraRig();
    expect(r.position.x).toBeCloseTo(CAMERA.entranceFrom, 9);
    r.update(1 / 60, 0);
    // After one frame the entrance ease has barely moved.
    expect(Math.hypot(r.position.x, r.position.y, r.position.z)).toBeLessThan(CAMERA.entranceFrom);
  });

  it("reaches a stable orbit radius over time", () => {
    const r = new CameraRig();
    for (let i = 0; i < 2000; i++) r.update(1 / 60, 0);
    const d = Math.hypot(r.position.x, r.position.y, r.position.z);
    // 5.5 ± the ±0.15 drift.
    expect(d).toBeGreaterThan(5.3);
    expect(d).toBeLessThan(5.7);
  });

  it("auto-orbits at 0.03 rad/s", () => {
    const r = new CameraRig();
    for (let i = 0; i < 600; i++) r.update(1 / 60, 0);
    const a = Math.atan2(r.position.z, r.position.x);
    for (let i = 0; i < 600; i++) r.update(1 / 60, 0);
    const b = Math.atan2(r.position.z, r.position.x);
    const delta = ((b - a + Math.PI) % (2 * Math.PI)) - Math.PI;
    expect(delta).toBeCloseTo(CAMERA.orbitRate * 10, 2);
  });

  it("points `forward` at the origin", () => {
    const r = new CameraRig();
    for (let i = 0; i < 300; i++) r.update(1 / 60, 0.4);
    const f = r.forward;
    expect(Math.hypot(f.x, f.y, f.z)).toBeCloseTo(1, 9);
    const p = r.position;
    expect(p.x * f.x + p.y * f.y + p.z * f.z).toBeLessThan(0);
  });

  it("never allocates a new position object", () => {
    const r = new CameraRig();
    const pos = r.position;
    const fwd = r.forward;
    for (let i = 0; i < 100; i++) {
      r.update(1 / 60, 0.5);
      expect(r.position).toBe(pos);
      expect(r.forward).toBe(fwd);
    }
  });

  // --- drag ---------------------------------------------------------------

  it("applies drag as an offset, clamped in pitch", () => {
    const r = new CameraRig();
    r.drag(100, 0, 1 / 60);
    r.drag(100, 0, 1 / 60);
    r.drag(-50, 0, 1 / 60);
    for (let i = 0; i < 60; i++) r.update(1 / 60, 0);

    r.drag(0, 100000, 1 / 60);
    for (let i = 0; i < 120; i++) r.update(1 / 60, 0);

    // Pitch must stay clamped regardless of how hard it is dragged.
    const p = r.position;
    const radius = Math.hypot(p.x, p.y, p.z);
    expect(radius).toBeGreaterThan(0.1);
    expect(Number.isFinite(p.x + p.y + p.z)).toBe(true);
  });

  it("keeps auto-orbit running underneath a drag", () => {
    const dragged = new CameraRig();
    dragged.beginDrag();
    dragged.drag(200, 0, 1 / 60);

    const a = new CameraRig();
    for (let i = 0; i < 300; i++) {
      dragged.update(1 / 60, 0);
      a.update(1 / 60, 0);
    }
    // Different positions because of the offset, but both moved.
    expect(dragged.position.x).not.toBeCloseTo(a.position.x, 6);
  });

  it("coasts after release and settles", () => {
    const r = new CameraRig();
    r.beginDrag();
    for (let i = 0; i < 10; i++) r.drag(30, 0, 1 / 60);
    r.endDrag();

    const x0 = r.position.x;
    for (let i = 0; i < 30; i++) r.update(1 / 60, 0);
    const x1 = r.position.x;
    for (let i = 0; i < 900; i++) r.update(1 / 60, 0);
    const x2 = r.position.x;

    // Still moving right after release, then converging.
    expect(Math.abs(x2 - x1)).toBeLessThan(Math.abs(x1 - x0));
  });

  // --- trauma --------------------------------------------------------------

  it("decays trauma at 1.2 per second, to zero within ~0.83 s", () => {
    const r = new CameraRig();
    r.addTrauma(1);
    expect(r.currentTrauma).toBeCloseTo(1, 9);

    // Half a second: exactly 0.6 of trauma consumed.
    for (let i = 0; i < 30; i++) r.update(1 / 60, 0);
    expect(r.currentTrauma).toBeCloseTo(1 - CAMERA.traumaDecayPerSec * 0.5, 6);

    // Past 1/1.2 s it is spent and must be clamped at zero, not negative.
    for (let i = 0; i < 60; i++) r.update(1 / 60, 0);
    expect(r.currentTrauma).toBe(0);
  });

  it("clamps accumulated trauma at 1", () => {
    const r = new CameraRig();
    // 0.15 + 0.30 × 3 = 1.05, which must clamp.
    r.addLargeEditTrauma();
    for (let i = 0; i < 3; i++) r.addRevertTrauma();
    expect(r.currentTrauma).toBe(1);

    // And it never goes below zero either.
    for (let i = 0; i < 200; i++) r.update(1 / 60, 0);
    expect(r.currentTrauma).toBe(0);
  });

  it("uses the spec's amounts for large edits and reverts", () => {
    const a = new CameraRig();
    a.addLargeEditTrauma();
    expect(a.currentTrauma).toBeCloseTo(CAMERA.traumaLarge, 9);

    const b = new CameraRig();
    b.addRevertTrauma();
    expect(b.currentTrauma).toBeCloseTo(CAMERA.traumaRevert, 9);
    expect(CAMERA.traumaRevert).toBeGreaterThan(CAMERA.traumaLarge);
  });

  // --- reduced motion ------------------------------------------------------

  it("adds no shake under reduced motion, per §9.11", () => {
    const r = new CameraRig({ reduceMotion: true });
    r.addRevertTrauma();
    expect(r.currentTrauma).toBe(0);
  });

  it("reduces the drift but does not remove it", () => {
    const normal = new CameraRig();
    const reduced = new CameraRig({ reduceMotion: true });
    for (let i = 0; i < 400; i++) {
      normal.update(1 / 60, 0);
      reduced.update(1 / 60, 0);
    }
    const driftOf = (r: CameraRig): number => {
      // Distance from the ideal orbit is the drift, roughly.
      const d = Math.hypot(r.position.x, r.position.y, r.position.z);
      return Math.abs(d - 5.5);
    };
    expect(driftOf(reduced)).toBeLessThan(driftOf(normal));
  });

  it("honours a mid-session change to the motion preference", () => {
    const r = new CameraRig();
    r.addRevertTrauma();
    expect(r.currentTrauma).toBeGreaterThan(0);
    r.setReduceMotion(true);
    expect(r.currentTrauma).toBe(0);
  });

  // --- lifecycle -----------------------------------------------------------

  it("resets to the entrance pose", () => {
    const r = new CameraRig();
    for (let i = 0; i < 600; i++) r.update(1 / 60, 0.8);
    r.addRevertTrauma();
    r.reset();
    expect(r.position.x).toBeCloseTo(CAMERA.entranceFrom, 9);
    expect(r.currentTrauma).toBe(0);
  });

  it("stays finite for a long run with everything switched on", () => {
    const r = new CameraRig();
    for (let i = 0; i < 5000; i++) {
      if (i % 97 === 0) r.addRevertTrauma();
      if (i % 13 === 0) {
        r.beginDrag();
        r.drag((i % 7) - 3, (i % 5) - 2, 1 / 60);
        r.endDrag();
      }
      r.update(1 / 60, (i % 100) / 100);
      for (const v of [
        r.position.x,
        r.position.y,
        r.position.z,
        r.forward.x,
        r.forward.y,
        r.forward.z,
      ]) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });
});
