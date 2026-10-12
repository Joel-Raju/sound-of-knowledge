/**
 * Camera rig. Spec §9.1.
 *
 * Two halves, deliberately separated:
 *
 * - **Pure helpers** (`composeYawPitch`, `traumaShake`, `distanceForEnergy`,
 *   `entranceEase`) hold all the arithmetic and are unit-tested directly.
 * - **`CameraRig`** holds state and writes into a preallocated `position` and
 *   `forward`, because §9.1 requires both "with no per-frame allocation" — the
 *   `forward` vector feeds the audio listener every frame (§8.9), so allocating
 *   one per frame would be a per-frame GC in the hot path.
 *
 * World layout, spec §9.1: the core has radius 1.2, edits spawn on a shell of
 * 7–13, and the camera orbits *inside* that shell at ≈ 5.5 looking at the
 * origin. So it is always inside the cloud of edits, which is the whole point —
 * edits fly past the viewer rather than being viewed from outside.
 */
import { clamp, easeOutCubic, expApproach, lerp } from "../util/math";
import type { Vec3 } from "../types";

/** Spec §9.1 camera constants. */
export const CAMERA = {
  fov: 58,
  near: 0.1,
  far: 200,
  /** yaw radians per second, spec §9.1 */
  orbitRate: 0.03,
  pitchBase: 0.18,
  pitchWobble: 0.12,
  pitchWobbleRate: 0.05,
  distance: 5.5,
  /** distance pulls in slightly as traffic rises */
  distanceEnergyPull: 0.5,
  /** smoothing τ for the distance follow, spec §9.1 */
  distanceTauSec: 3,
  /** positional drift amplitude, two octaves */
  drift: 0.15,
  dragYawPerPx: 0.005,
  dragPitchPerPx: 0.005,
  pitchClamp: 1.2,
  /** inertia damping: exp(-dt*3) */
  dragDamp: 3,
  traumaDecayPerSec: 1.2,
  /** rotation amplitude = trauma² * 0.03 rad */
  traumaAmplitude: 0.03,
  /** noise is sampled at 25 Hz, not per frame, so the shake is smooth */
  traumaSampleHz: 25,
  /** large edits add 0.15, reverts add 0.30 */
  traumaLarge: 0.15,
  traumaRevert: 0.3,
  /** entrance: distance eases 9 -> target over 2.5 s */
  entranceFrom: 9,
  entranceSec: 2.5,
  /** §9.11 — drift is reduced, not removed, under reduced motion */
  reducedMotionDrift: 0.4,
} as const;

/**
 * Spherical → cartesian, without touching three.js.
 *
 * Kept pure so the rig's geometry is testable in Node; the renderer only ever
 * sees the resulting `position`.
 */
export function composeYawPitch(distance: number, yaw: number, pitch: number, out: Vec3): Vec3 {
  const cp = Math.cos(pitch);
  out.x = distance * Math.cos(yaw) * cp;
  out.y = distance * Math.sin(pitch);
  out.z = distance * Math.sin(yaw) * cp;
  return out;
}

/** Spec §9.1 — `pitch = 0.18 + 0.12*sin(0.05 t)`. */
export function pitchAt(t: number): number {
  return CAMERA.pitchBase + CAMERA.pitchWobble * Math.sin(CAMERA.pitchWobbleRate * t);
}

/** Spec §9.1 — `distance = 5.5 − 0.5*E`, smoothed by the caller with τ = 3 s. */
export function distanceForEnergy(energy: number): number {
  const e = energy < 0 ? 0 : energy > 1 ? 1 : energy;
  return CAMERA.distance - CAMERA.distanceEnergyPull * e;
}

/** Spec §9.1 — entrance ease, `easeOutCubic` from 9 to the target. */
export function entranceEase(t: number, target: number): number {
  if (t >= CAMERA.entranceSec) return target;
  const k = clamp(t / CAMERA.entranceSec, 0, 1);
  return lerp(CAMERA.entranceFrom, target, easeOutCubic(k));
}

/**
 * Trauma shake amplitude in radians, spec §9.1.
 *
 * Quadratic in trauma on purpose: shake should vanish at the edges, so small
 * events produce almost no shake while a big one is unmistakable. Linear trauma
 * would make every minor edit feel like a glitch.
 */
export function traumaShake(trauma: number, noise: number): number {
  const t = clamp(trauma, 0, 1);
  if (t === 0) return 0; // avoids a -0 leaking into camera arithmetic and logs
  return t * t * CAMERA.traumaAmplitude * noise;
}

/**
 * Cheap deterministic value noise, used for the two-octave drift and the shake.
 *
 * Not a texture and not smooth noise in the strict sense — it is a hashed
 * lattice with a smoothstep between lattice points, which is enough for a
 * camera and costs a few multiplies per octave.
 */
export function valueNoise1(x: number, seed = 0): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = hash1(i, seed);
  const b = hash1(i + 1, seed);
  // smoothstep between lattice points
  const u = f * f * (3 - 2 * f);
  return a + (b - a) * u;
}

/** Two octaves, spec §9.1's "±0.15 (2 octaves)". Returns roughly [-1, 1]. */
export function driftNoise(t: number, seed = 0): number {
  return (valueNoise1(t * 0.35, seed) * 0.65 + valueNoise1(t * 0.83, seed + 17) * 0.35) * 2 - 1;
}

function hash1(i: number, seed: number): number {
  let x = (i | 0) ^ (seed | 0);
  x = Math.imul(x, 0x27d4eb2d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  return ((x >>> 0) % 100000) / 100000;
}

export interface CameraRigOptions {
  /** §9.11 — from `prefers-reduced-motion` */
  reduceMotion?: boolean;
  /** deterministic noise seed, for tests */
  seed?: number;
}

export class CameraRig {
  /** Current world position. Reused every frame; never reallocated. */
  readonly position: Vec3 = { x: 0, y: 0, z: 0 };
  /** Unit vector from the camera toward the origin, for the audio listener. */
  readonly forward: Vec3 = { x: 0, y: 0, z: 0 };

  private readonly seed: number;
  private reduceMotion: boolean;

  private t = 0;
  private yaw = 0;
  private yawOffset = 0;
  private pitchOffset = 0;
  private dragVelYaw = 0;
  private dragVelPitch = 0;
  private dragging = false;

  private energy = 0;
  private smoothedDistance: number = CAMERA.distance;
  private trauma = 0;
  private traumaClock = 0;

  constructor(opts: CameraRigOptions = {}) {
    this.seed = opts.seed ?? 1;
    this.reduceMotion = opts.reduceMotion === true;
    this.position.x = CAMERA.entranceFrom;
    this.position.y = 0;
    this.position.z = 0;
  }

  setReduceMotion(on: boolean): void {
    this.reduceMotion = on;
    // §9.11 — no shake at all under reduced motion.
    if (on) this.trauma = 0;
  }

  get currentTrauma(): number {
    return this.trauma;
  }

  /**
   * Spec §9.1 / §10.2 — shake is added on large edits and reverts.
   *
   * Accumulates rather than assigns, so two events in quick succession stack,
   * and clamps at 1 so a burst cannot produce a seizure-scale shake (§9.11).
   */
  addTrauma(amount: number): void {
    if (this.reduceMotion) return;
    this.trauma = clamp(this.trauma + amount, 0, 1);
  }

  addLargeEditTrauma(): void {
    this.addTrauma(CAMERA.traumaLarge);
  }

  addRevertTrauma(): void {
    this.addTrauma(CAMERA.traumaRevert);
  }

  /** Spec §9.1 — pointer drag. Mouse and touch both land here. */
  beginDrag(): void {
    this.dragging = true;
  }

  endDrag(): void {
    this.dragging = false;
  }

  /**
   * Spec §9.1 — `yawOffset += dx*0.005`, `pitchOffset += dy*0.005`,
   * pitch clamped to ±1.2 rad.
   *
   * The accumulated velocity is what makes the release *inertial* rather than
   * stopping dead: `exp(-dt*3)` per spec.
   */
  drag(dx: number, dy: number, dtSec: number): void {
    const dyaw = dx * CAMERA.dragYawPerPx;
    const dpitch = dy * CAMERA.dragPitchPerPx;
    this.yawOffset += dyaw;
    this.pitchOffset = clamp(this.pitchOffset + dpitch, -CAMERA.pitchClamp, CAMERA.pitchClamp);

    // Velocity from the instantaneous delta, smoothed on release. Recomputed
    // each call so a flick imparts more than a slow drag.
    const k = 1 - Math.exp(-dtSec * CAMERA.dragDamp);
    this.dragVelYaw += (dyaw - this.dragVelYaw) * (k || 1);
    this.dragVelPitch += (dpitch - this.dragVelPitch) * (k || 1);
  }

  /**
   * Advance one frame and rewrite `position` / `forward`.
   *
   * `energy` drives the distance pull (§9.1). `dtSec` is clamped by the caller
   * (the renderer clamps frame deltas) so a tab switch cannot teleport the
   * camera.
   */
  update(dtSec: number, energy: number): void {
    this.t += dtSec;
    this.energy = clamp(energy, 0, 1);

    // Auto-orbit continues underneath the user's offset (spec §9.1).
    this.yaw += CAMERA.orbitRate * dtSec;

    // Inertia after release.
    if (!this.dragging) {
      const damp = Math.exp(-dtSec * CAMERA.dragDamp);
      this.yawOffset += this.dragVelYaw;
      this.pitchOffset = clamp(
        this.pitchOffset + this.dragVelPitch,
        -CAMERA.pitchClamp,
        CAMERA.pitchClamp,
      );
      this.dragVelYaw *= damp;
      this.dragVelPitch *= damp;
      if (Math.abs(this.dragVelYaw) < 1e-5) this.dragVelYaw = 0;
      if (Math.abs(this.dragVelPitch) < 1e-5) this.dragVelPitch = 0;
    } else {
      this.dragVelYaw = 0;
      this.dragVelPitch = 0;
    }

    // Distance: target from energy, then entrance ease, then τ = 3 s smoothing.
    const target = entranceEase(this.t, distanceForEnergy(this.energy));
    this.smoothedDistance = expApproach(
      this.smoothedDistance,
      target,
      dtSec,
      CAMERA.distanceTauSec,
    );

    // Trauma decays at 1.2/s regardless of motion preference.
    if (this.trauma > 0) {
      this.trauma = Math.max(0, this.trauma - CAMERA.traumaDecayPerSec * dtSec);
    }
    // Shake noise is sampled at 25 Hz, not per frame: at 144 fps a per-frame
    // sample would make the shake jitter rather than read as a wobble.
    this.traumaClock += dtSec;
    const shakeNoise =
      valueNoise1(this.traumaClock * CAMERA.traumaSampleHz, this.seed + 91) * 2 - 1;

    let yaw = this.yaw + this.yawOffset;
    let pitch = clamp(pitchAt(this.t) + this.pitchOffset, -1.5, 1.5);

    if (!this.reduceMotion && this.trauma > 0) {
      yaw += traumaShake(this.trauma, shakeNoise);
      pitch += traumaShake(this.trauma, -shakeNoise) * 0.6;
    }

    composeYawPitch(this.smoothedDistance, yaw, pitch, this.position);

    // Drift: two octaves, reduced (not removed) under reduced motion (§9.11).
    const driftScale = CAMERA.drift * (this.reduceMotion ? CAMERA.reducedMotionDrift : 1);
    if (driftScale > 0) {
      this.position.x += driftNoise(this.t, this.seed) * driftScale;
      this.position.y += driftNoise(this.t, this.seed + 5) * driftScale * 0.6;
      this.position.z += driftNoise(this.t, this.seed + 9) * driftScale;
    }

    // Forward is the unit vector from position toward the origin.
    const len = Math.hypot(this.position.x, this.position.y, this.position.z) || 1;
    this.forward.x = -this.position.x / len;
    this.forward.y = -this.position.y / len;
    this.forward.z = -this.position.z / len;
  }

  /** Reset to the entrance pose — used on dispose and by the e2e harness. */
  reset(): void {
    this.t = 0;
    this.yaw = 0;
    this.yawOffset = 0;
    this.pitchOffset = 0;
    this.dragVelYaw = 0;
    this.dragVelPitch = 0;
    this.energy = 0;
    this.smoothedDistance = CAMERA.distance;
    this.trauma = 0;
    this.position.x = CAMERA.entranceFrom;
    this.position.y = 0;
    this.position.z = 0;
  }
}
