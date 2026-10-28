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

/**
 * §9.5 — `duration = lerp(1.1, 1.8, 1 − magnitude)`.
 *
 * Exported because §10.2 needs a streak's *arrival* time ("push, at arrival time
 * (`now + duration*0.85`)"), and the code firing the orb impact has to agree with the
 * particle it is impact-timing to the millisecond. Two copies of this formula is how
 * they would drift — and a drifted arrival is the one §10.2 error that is invisible
 * when wrong: the impact just lands a little early or late.
 *
 * §9.11's reduced-motion scale is applied by the caller, here and in `emit`.
 */
export function sparkDuration(magnitude: number): number {
  return 1.1 + (1.8 - 1.1) * (1 - clamp01(magnitude));
}

/** §10.2 — a streak reaches the core at 85 % of its duration. */
export const SPARK_ARRIVAL_FRACTION = 0.85;

export interface StreakStyleOpts {
  /** §10.2 — a large edit's streak is "×1.8 size". */
  sizeScale?: number;
  /** §10.2 — the `accent` / `core` brightness variants. See `STREAK_STYLE_BRIGHTNESS`. */
  brightnessScale?: number;
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
  /** DEBUG ONLY — a multiplier on size and brightness. See `setAppearanceScale`. */
  private appearanceScale = 1;
  /**
   * DEBUG ONLY — what the GPU actually has.
   *
   * The live path renders no comet at any scale, while `debugSpawn` renders a glorious
   * one, and both go through `director.fire`. So the difference has to be in the data the
   * shader reads: `aOrigin`, `aTarget`, `aTimes`, `aStyle`. This reports, for the most
   * recently written instances, the values the vertex shader will evaluate.
   */
  getLastSpawnDebug(): {
    uTime: number;
    instances: Array<{
      origin: [number, number, number];
      target: [number, number, number];
      spawnTime: number;
      duration: number;
      delay: number;
      kind: number;
      size: number;
      brightness: number;
      age: number;
      alive: boolean;
    }>;
    /** alive instances per kind: [streak, botPulse, burst] */
    aliveByKind: [number, number, number];
    /** instances ever written per kind */
    totalByKind: [number, number, number];
    /** Live streak instances, from anywhere in the pool. */
    liveStreaks: Array<{
      origin: [number, number, number];
      target: [number, number, number];
      spawnTime: number;
      duration: number;
      delay: number;
      kind: number;
      size: number;
      brightness: number;
      age: number;
      alive: boolean;
    }>;
    capacity: number;
  } {
    const uTime = this.material.uniforms.uTime!.value as number;
    const oA = this.aOrigin.array as Float32Array;
    const tA = this.aTarget.array as Float32Array;
    const tmA = this.aTimes.array as Float32Array;
    const sA = this.aStyle.array as Float32Array;
    const out: Array<{
      origin: [number, number, number];
      target: [number, number, number];
      spawnTime: number;
      duration: number;
      delay: number;
      kind: number;
      size: number;
      brightness: number;
      age: number;
      alive: boolean;
    }> = [];
    // The whole pool, scanned. Looking only at the last few instances is useless: one
    // burst writes 48 of them and buries everything else.
    const aliveByKind: [number, number, number] = [0, 0, 0];
    const totalByKind: [number, number, number] = [0, 0, 0];
    // Live **streaks** from the whole pool. Looking only at the last few instances is
    // useless: one burst writes 48 of them and buries everything else.
    const liveStreaks: Array<{
      origin: [number, number, number];
      target: [number, number, number];
      spawnTime: number;
      duration: number;
      delay: number;
      kind: number;
      size: number;
      brightness: number;
      age: number;
      alive: boolean;
    }> = [];
    for (let i = 0; i < this.capacity; i++) {
      const kind = sA[i * 4]!;
      const spawnTime = tmA[i * 4]!;
      const duration = tmA[i * 4 + 1]!;
      const delay = tmA[i * 4 + 2]!;
      const age = uTime - spawnTime - delay;
      const alive = age >= 0 && age <= duration && duration > 0;
      const k = kind < 0.5 ? 0 : kind < 1.5 ? 1 : 2;
      if (duration > 0) totalByKind[k]!++;
      if (alive) {
        aliveByKind[k]!++;
        if (k === 0 && liveStreaks.length < 48) {
          liveStreaks.push({
            origin: [oA[i * 3]!, oA[i * 3 + 1]!, oA[i * 3 + 2]!],
            target: [tA[i * 3]!, tA[i * 3 + 1]!, tA[i * 3 + 2]!],
            spawnTime,
            duration,
            delay,
            kind,
            size: sA[i * 4 + 1]!,
            brightness: sA[i * 4 + 3]!,
            age,
            alive,
          });
        }
      }
    }
    for (let k = 0; k < 16; k++) {
      const i = (this.head - 1 - k + this.capacity * 2) % this.capacity;
      const spawnTime = tmA[i * 4]!;
      const duration = tmA[i * 4 + 1]!;
      const delay = tmA[i * 4 + 2]!;
      const age = uTime - spawnTime - delay;
      out.push({
        origin: [oA[i * 3]!, oA[i * 3 + 1]!, oA[i * 3 + 2]!],
        target: [tA[i * 3]!, tA[i * 3 + 1]!, tA[i * 3 + 2]!],
        spawnTime,
        duration,
        delay,
        kind: sA[i * 4]!,
        size: sA[i * 4 + 1]!,
        brightness: sA[i * 4 + 3]!,
        age,
        alive: age >= 0 && age <= duration,
      });
    }
    return {
      uTime,
      instances: out,
      liveStreaks,
      aliveByKind,
      totalByKind,
      capacity: this.capacity,
    };
  }

  /** DEBUG ONLY — a multiplier on the particle count. See `setParticleScale`. */
  private particleScale = 1;
  /** DEBUG ONLY — whether the spark system draws at all. See `setEnabled`. */
  private enabled = true;
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
    return Math.max(1, Math.round(base * this.factor * this.particleScale));
  }

  /**
   * §9.11 — "spark duration ×1.3" under reduced motion.
   *
   * Sparks *lengthen* rather than shorten, which reads as backwards until you
   * follow it: a fast, snappy streak is the motion-sickness trigger, and the same
   * particle drifting slowly for longer is the calmer version of itself. Removing
   * them would remove the visual event entirely.
   */
  /**
   * DEBUG ONLY — a multiplier on the streak's size and brightness.
   *
   * **Why this exists.** A typical Wikipedia edit has magnitude ≈ 0.19, and §9.5's
   * formula gives it `10 + 16·m` = **13 particles**, each `0.06 + 0.1·m` ≈ **0.078**
   * world units across. At the shell's distance that is a **5-pixel** speck, at low
   * brightness, for 1.7 s, one at a time. `debugSpawn` uses magnitude 0.7 and fires
   * 400 at once, which is why the T4.2 screenshots looked right — the real path looks
   * nothing like them.
   *
   * So the comet is genuinely too small to read as "a comet streaking into the core".
   * How much bigger it should be is a judgement, and a judgement that can be dialled
   * from a URL is one a human can settle by looking.
   *
   * **The human's verdict (2026-10-27): the comets are visible, the §9.5 curve reads
   * better than any alternative, and at 1.5× the comet is "on the bigger side" — so
   * smaller. The default is therefore 1.0**, with the knob still available for anyone
   * who wants to compare.
   */
  setAppearanceScale(s: number): void {
    this.appearanceScale = Number.isFinite(s) && s > 0 ? s : 1;
  }

  /** DEBUG ONLY — the current appearance multiplier, so a URL override can be verified. */
  get appearanceMultiplier(): number {
    return this.appearanceScale;
  }

  /**
   * DEBUG ONLY — make the whole system inert.
   *
   * The dust test measures "light outside the core", and that was dust-only **because
   * the comets never rendered**. Now they do, so the dust's own contribution cannot be
   * separated from a comet that happened to be in frame.
   */
  setEnabled(on: boolean): void {
    this.enabled = on;
    this.mesh.visible = on;
  }

  /**
   * DEBUG ONLY — a multiplier on the particle count.
   *
   * §9.5 gives a typical edit `10 + 16·m` = 13 particles, and the tier's
   * `particleFactor` cuts that to **6 on the low tier**. Six dots along a trail is a
   * dotted line, not a streak — and a 2-pixel dot is not a comet.
   */
  setParticleScale(s: number): void {
    this.particleScale = Number.isFinite(s) && s > 0 ? s : 1;
  }
  get particleMultiplier(): number {
    return this.particleScale;
  }

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
    opts: StreakStyleOpts = {},
  ): number {
    const m = clamp01(magnitude);
    const base =
      m >= SPARK_COUNTS.largeMagnitude ? SPARK_COUNTS.streakLarge : SPARK_COUNTS.streak(m);
    return this.emit(
      SPARK_KIND.streak,
      origin,
      dirToCore,
      color,
      m,
      base,
      opts.sizeScale ?? 1,
      opts.brightnessScale ?? 1,
    );
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
    sizeScale = 1,
    brightnessScale = 1,
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
    const duration = sparkDuration(magnitude) * this.durationScale;
    const seed = Math.random() * 1000;
    const size = (0.06 + 0.1 * magnitude) * sizeScale * this.appearanceScale;
    const brightness = (1.0 + 1.5 * magnitude) * brightnessScale * this.appearanceScale;

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
    //
    // **`addUpdateRange` takes ARRAY ELEMENTS, not instances.** three.js's
    // `BufferAttribute.addUpdateRange(start, count)` documents the start as "position at
    // which to update" in the attribute's own array, and the renderer does
    // `bufferSubData(type, range.start * BYTES_PER_ELEMENT, array, range.start, range.count)`.
    // `aOrigin` has itemSize 3 and `aTimes` itemSize 4, so the instance range
    // [s, s+c) must be uploaded as the element range [s*itemSize, c*itemSize).
    //
    // Passing the instance numbers directly uploaded a **misaligned** slice — the wrong
    // bytes entirely — so the sparks' positions and timings never reached the GPU and
    // **the comets did not render at all**. The symptom was "the comet in the first five
    // seconds and then no more"; the cause was a unit mismatch at one call site.
    //
    // `spawnRanges` was right all along and had a unit test: it returns *instance*
    // spans. The conversion to elements belongs here, at the boundary.
    for (const r of spawnRanges(this.head, K, this.capacity)) {
      this.aOrigin.addUpdateRange(r.start * this.aOrigin.itemSize, r.count * this.aOrigin.itemSize);
      this.aTarget.addUpdateRange(r.start * this.aTarget.itemSize, r.count * this.aTarget.itemSize);
      this.aTimes.addUpdateRange(r.start * this.aTimes.itemSize, r.count * this.aTimes.itemSize);
      this.aStyle.addUpdateRange(r.start * this.aStyle.itemSize, r.count * this.aStyle.itemSize);
      this.aColor.addUpdateRange(r.start * this.aColor.itemSize, r.count * this.aColor.itemSize);
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