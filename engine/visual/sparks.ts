/**
 * Sparks — stateless GPU particles. Spec §9.5.
 *
 * The whole design is that the CPU never simulates anything. Spawning writes K
 * instances into a ring buffer and flags the touched spans; every frame the
 * vertex shader recomputes each particle's position from `(uTime − spawnTime)`
 * and its per-instance attributes. Nothing is read back, nothing is stepped, and
 * an instance that is off screen costs a few ALU ops rather than a slot.
 *
 * That is why capacity is fixed at `CAP` with `instanceCount = CAP` (§9.5): a
 * sparse pool would need per-frame compaction, which is the simulation this
 * exists to avoid.
 *
 * **No allocation on the spawn path.** Values are written straight into the
 * attribute backing arrays at the computed indices — an intermediate scratch
 * buffer would be a second copy of the same data with no benefit — and the
 * target vector is a preallocated member.
 */
import * as THREE from "three";
import { SPARKS_FRAG, SPARKS_VERT } from "./shaders/sparks.shader";
import { nextHead, spawnRanges } from "./ring-buffer-ranges";
import { TIER_PARAMS } from "../config";
import type { Tier } from "../types";

/** §9.5 — kind discriminants, stored as a float in `aStyle.x`. */
export const SPARK_KIND = { streak: 0, botPulse: 1, burst: 2 } as const;
export type SparkKind = (typeof SPARK_KIND)[keyof typeof SPARK_KIND];

/** §9.5 — a streak's particles are staggered to form a comet trail. */
export const SPARK_DELAY_STEP = 0.018;

/** §9.5 — target is just outside the orb surface, which has radius 1.2. */
export const SPARK_TARGET_RADIUS = 1.25;

/** Particle counts per event, before tier and governor scaling (§9.5). */
export const SPARK_COUNTS = {
  /** Streaks scale with magnitude: `lerp(10, 26, magnitude)`. */
  streak: (magnitude: number): number => 10 + (26 - 10) * clamp01(magnitude),
  /** A large or substitution edit overrides the formula — it should be noticed. */
  streakLarge: 36,
  /** §9.5 — a bot pulse is exactly one particle. */
  botPulse: 1,
  /** §9.5 — a new page. */
  burst: 48,
  /** At or above this magnitude a streak uses `streakLarge` instead. */
  largeMagnitude: 0.75,
} as const;

export interface SparkOptions {
  tier?: Tier;
  /** §9.10 governor level — L5 scales particles by 0.7. */
  governorLevel?: number;
}

/** Particles-per-event factor after tier (§12.3) and governor (§9.10). */
export function particleFactor(tier: Tier, governorLevel: number): number {
  const tierFactor = TIER_PARAMS[tier].particleFactor;
  return tierFactor * (governorLevel >= 5 ? 0.7 : 1);
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0;
}

export class Sparks {
  readonly mesh: THREE.Mesh;
  readonly geometry: THREE.InstancedBufferGeometry;
  readonly material: THREE.ShaderMaterial;
  readonly capacity: number;

  /** Instanced attributes, mutated in place (§12.1 — no per-frame allocation). */
  readonly aOrigin: THREE.InstancedBufferAttribute;
  readonly aTarget: THREE.InstancedBufferAttribute;
  readonly aTimes: THREE.InstancedBufferAttribute;
  readonly aStyle: THREE.InstancedBufferAttribute;
  readonly aColor: THREE.InstancedBufferAttribute;

  private head = 0;
  private tier: Tier;
  private factor: number;
  /** §9.11 — 1.3 under reduced motion, 1 otherwise. */
  private durationScale = 1;
  private totalSpawned = 0;
  /** Preallocated so the spawn path never allocates (§9.5). */
  private readonly target = new THREE.Vector3();

  constructor(opts: SparkOptions = {}) {
    this.tier = opts.tier ?? "high";
    this.capacity = TIER_PARAMS[this.tier].sparkCapacity;
    this.factor = particleFactor(this.tier, opts.governorLevel ?? 0);

    const geo = new THREE.InstancedBufferGeometry();
    // A unit quad, ±0.5, per §9.5. Non-instanced: one copy shared by every
    // particle and billboarded in the vertex shader.
    geo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3),
    );
    geo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);

    this.aOrigin = instanced(this.capacity, 3);
    this.aTarget = instanced(this.capacity, 3);
    this.aTimes = instanced(this.capacity, 4);
    this.aStyle = instanced(this.capacity, 4);
    this.aColor = instanced(this.capacity, 3);
    geo.setAttribute("aOrigin", this.aOrigin);
    geo.setAttribute("aTarget", this.aTarget);
    geo.setAttribute("aTimes", this.aTimes);
    geo.setAttribute("aStyle", this.aStyle);
    geo.setAttribute("aColor", this.aColor);

    geo.instanceCount = this.capacity;

    this.geometry = geo;
    this.material = new THREE.ShaderMaterial({
      vertexShader: SPARKS_VERT,
      fragmentShader: SPARKS_FRAG,
      uniforms: { uTime: { value: 0 } },
      transparent: true,
      blending: THREE.AdditiveBlending,
      // Additive (§9.2); sparks never occlude the orb or each other.
      depthWrite: false,
      depthTest: true,
      glslVersion: THREE.GLSL3,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    // §9.2 draw order — dust 0, orb 1, sparks 2, rings 3.
    this.mesh.renderOrder = 2;
    this.mesh.name = "sok-sparks";
  }

  /** §9.10 L5, and a tier change, both rescale the particle count. */
  setScale(tier: Tier, governorLevel: number): void {
    this.tier = tier;
    this.factor = particleFactor(tier, governorLevel);
  }

  /** Particles an event of `base` particles will actually spawn. */
  countFor(base: number): number {
    // Never below one: a spawn that rounds to zero would silently drop an edit.
    return Math.max(1, Math.round(base * this.factor));
  }

  /**
   * §9.11 — "spark duration ×1.3" under reduced motion.
   *
   * Sparks *lengthen* rather than shorten, which reads as backwards until you
   * follow it: a fast, snappy streak is the motion-sickness trigger, and the same
   * particle drifting slowly for longer is the calmer version of itself. Removing
   * them would remove the visual event entirely.
   */
  setReducedMotion(on: boolean): void {
    this.durationScale = on ? 1.3 : 1;
  }

  /** `uTime` — the clock the vertex shader evaluates every particle against. */
  update(timeSec: number): void {
    this.material.uniforms.uTime!.value = timeSec;
  }

  /** Live particles, saturating at capacity. For tests and the HUD. */
  get spawned(): number {
    return Math.min(this.capacity, this.totalSpawned);
  }

  /** The slot the next spawn writes to. For tests. */
  get cursor(): number {
    return this.head;
  }

  /** §9.5 — a human edit's comet. */
  spawnStreak(
    origin: THREE.Vector3,
    dirToCore: THREE.Vector3,
    color: THREE.Color,
    magnitude: number,
  ): number {
    const m = clamp01(magnitude);
    const base =
      m >= SPARK_COUNTS.largeMagnitude ? SPARK_COUNTS.streakLarge : SPARK_COUNTS.streak(m);
    return this.emit(SPARK_KIND.streak, origin, dirToCore, color, m, base);
  }

  /** §9.5 — a bot pulse: one particle, straight line, flashes on arrival. */
  spawnBotPulse(
    origin: THREE.Vector3,
    dirToCore: THREE.Vector3,
    color: THREE.Color,
    magnitude: number,
  ): number {
    return this.emit(SPARK_KIND.botPulse, origin, dirToCore, color, clamp01(magnitude), SPARK_COUNTS.botPulse);
  }

  /** §9.5 — a new page: radial burst from the edit's own position. */
  spawnBurst(origin: THREE.Vector3, color: THREE.Color, magnitude: number): number {
    return this.emit(
      SPARK_KIND.burst,
      origin,
      null,
      color,
      clamp01(magnitude),
      SPARK_COUNTS.burst,
    );
  }

  /**
   * Write K instances at `head` and flag only the spans touched.
   *
   * §9.5: `needsUpdate = true` happens "only on frames that spawned", so it is
   * set here and nowhere else. A quiet frame uploads nothing.
   */
  private emit(
    kind: SparkKind,
    origin: THREE.Vector3,
    dirToCore: THREE.Vector3 | null,
    color: THREE.Color,
    magnitude: number,
    baseCount: number,
  ): number {
    const K = this.countFor(baseCount);

    // `target = dirToCore * 1.25`. A burst has no target — the vertex shader
    // expands from the origin instead — so it gets the origin as a placeholder.
    if (dirToCore) {
      this.target.set(
        dirToCore.x * SPARK_TARGET_RADIUS,
        dirToCore.y * SPARK_TARGET_RADIUS,
        dirToCore.z * SPARK_TARGET_RADIUS,
      );
    } else {
      this.target.copy(origin);
    }

    const spawnTime = this.material.uniforms.uTime!.value as number;
    // §9.5 — a long, slow streak for a small edit; a big one arrives fast.
    // §9.11 scales this under reduced motion; §9.5 fixes the base values.
    const duration = (1.1 + (1.8 - 1.1) * (1 - magnitude)) * this.durationScale;
    const seed = Math.random() * 1000;
    const size = 0.06 + 0.1 * magnitude;
    const brightness = 1.0 + 1.5 * magnitude;

    const oA = this.aOrigin.array as Float32Array;
    const tA = this.aTarget.array as Float32Array;
    const tmA = this.aTimes.array as Float32Array;
    const sA = this.aStyle.array as Float32Array;
    const cA = this.aColor.array as Float32Array;

    for (let j = 0; j < K; j++) {
      // Absolute index, so a wrapping spawn writes each instance exactly once
      // and the ranges below describe the same instances.
      const i = (this.head + j) % this.capacity;

      oA[i * 3] = origin.x;
      oA[i * 3 + 1] = origin.y;
      oA[i * 3 + 2] = origin.z;
      tA[i * 3] = this.target.x;
      tA[i * 3 + 1] = this.target.y;
      tA[i * 3 + 2] = this.target.z;

      tmA[i * 4] = spawnTime;
      tmA[i * 4 + 1] = duration;
      tmA[i * 4 + 2] = j * SPARK_DELAY_STEP; // the comet trail
      tmA[i * 4 + 3] = seed;

      sA[i * 4] = kind;
      sA[i * 4 + 1] = size;
      sA[i * 4 + 2] = K > 1 ? j / (K - 1) : 0; // jIndex01
      sA[i * 4 + 3] = brightness;

      cA[i * 3] = color.r;
      cA[i * 3 + 1] = color.g;
      cA[i * 3 + 2] = color.b;
    }

    // §9.5 — "wrapping with up to two contiguous ranges".
    for (const r of spawnRanges(this.head, K, this.capacity)) {
      this.aOrigin.addUpdateRange(r.start, r.count);
      this.aTarget.addUpdateRange(r.start, r.count);
      this.aTimes.addUpdateRange(r.start, r.count);
      this.aStyle.addUpdateRange(r.start, r.count);
      this.aColor.addUpdateRange(r.start, r.count);
    }

    this.head = nextHead(this.head, K, this.capacity);
    this.totalSpawned += K;

    this.aOrigin.needsUpdate = true;
    this.aTarget.needsUpdate = true;
    this.aTimes.needsUpdate = true;
    this.aStyle.needsUpdate = true;
    this.aColor.needsUpdate = true;
    return K;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

function instanced(cap: number, size: number): THREE.InstancedBufferAttribute {
  return new THREE.InstancedBufferAttribute(new Float32Array(cap * size), size, true);
}