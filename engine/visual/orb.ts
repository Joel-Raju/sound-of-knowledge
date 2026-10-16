/**
 * Core orb. Spec §9.4.
 *
 * A `ShaderMaterial` on an `IcosahedronGeometry(1.2, detail)` — the geometry is
 * only the *bounding* surface; the fragment stage ray-marches the volume behind
 * it, which is why this is a volumetric orb rather than a displaced sphere.
 *
 * Three things here are load-bearing and easy to get wrong:
 *
 * 1. **The uniform arrays are preallocated `THREE.Vector4`s, mutated in place.**
 *    §9.4 requires this and §12.1's per-frame allocation budget requires it too.
 *    Reassigning `uImpactA.value` to a fresh array every frame would allocate
 *    32 Vector4s per frame for no reason; three.js reads the same objects.
 * 2. **`uFrame` is not `uTime`.** The jitter dither needs to change every frame
 *    or the banding freezes into a fixed pattern, but it must not accumulate
 *    float error over a long session the way `uTime` would.
 * 3. **Impacts expire by writing `strength = 0`, not by compacting the array.**
 *    The ring buffer's slots are addressed by index in the shader's loop, so
 *    shifting them would move a live impact's index mid-flight.
 */
import * as THREE from "three";
import { IMPACT_SLOTS, MAX_OCTAVES, MAX_STEPS, ORB_VERT } from "./shaders/orb.vert";
import { ORB_FRAG } from "./shaders/orb.frag";
import { TIER_PARAMS } from "../config";
import type { AudioFeatures, Tier } from "../types";
import type { Palette } from "./palette";
import { clamp } from "../util/math";

/** §9.4 — an impact's ripple lives for 2.5 s. */
export const IMPACT_LIFETIME_SEC = 2.5;

/** §9.4 — strength is `lerp(0.25, 1.0, magnitude)`. */
export const IMPACT_MIN_STRENGTH = 0.25;
export const IMPACT_MAX_STRENGTH = 1.0;

/** §9.4 — a revert dents (inward) rather than pushes (outward). */
export type ImpactKind = "push" | "dent";

export interface OrbOptions {
  tier?: Tier;
  /** governor level, §9.10 — L3 forces 2 octaves. */
  governorLevel?: number;
  /**
   * March-jitter amplitude, as a fraction of a step. §9.4 is 1.0; see
   * `ORB_DEFAULTS.jitter`. Exposed so the screenshot harness can sweep it.
   */
  jitter?: number;
  /**
   * C11 — scales the accumulated emission. §9.4 accumulates density front to back
   * and the centre saturates well above 1.0, so the core clips to white in every
   * tone-mapping mode tested (AgX, ACES, and with bloom off entirely). Scaling at
   * the source is the only lever that recovers the interior structure.
   */
  emission?: number;
  /** C11 — per-step absorption; lower than §9.4 so accumulation stops saturating. */
  absorb?: number;
  /** deterministic, for tests and the screenshot harness. */
  seed?: number;
}

/**
 * Defaults that differ from §9.4's literal values, each with its reason here and
 * in DECISIONS.md. Kept together so a reader can see every departure from the
 * spec in one place rather than discovering them one `uniform` at a time.
 */
export const ORB_DEFAULTS = {
  /**
   * C11's fix. §9.4 as written is 1.0; measured, that renders the core as a
   * structureless wash regardless of what post does to it.
   *
   * Set lower so the centre of the density field sits inside the range where a
   * tone-mapping curve still has room to separate values. See `DECISIONS.md`.
   */
  emission: 0.55,
  /**
   * C11 — §9.4 writes 3.2; see the shader comment for why detail is lost there.
   *
   * Swept at 3.2 / 2.0 / 1.2 / 0.7 and chosen by eye at **1.2**: the interior
   * mottling the human asked for is visible from here, and the orb still reads as a
   * luminous body rather than thinning toward gas. 0.7 carries more structure still
   * and is one `?absorb=` away, but it trades away more than the complaint asked for.
   */
  absorb: 1.2,
  /**
   * §9.4 says 1.0 — the jitter displaces the march by a full `stepLen`, and is
   * given there as being there "to hide banding".
   *
   * Measured at 3× magnification, across every tier: 1.0 and 0.35 produce a
   * plainly visible diagonal lattice; **0.0 produces no lattice and no
   * concentric banding either**. The banding is not there to be hidden — the
   * field varies by more than a step length over each step, so quantisation
   * cannot produce visible rings.
   *
   * So the dither was trading an artefact that does not occur for one that
   * does, at every quality setting. The uniform stays, because a future change
   * that made the field smooth across a step would make banding real and want
   * the knob back.
   */
  jitter: 0,
} as const;

export class Orb {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  readonly geometry: THREE.IcosahedronGeometry;

  /** Preallocated, mutated in place (§9.4). Never reallocated. */
  readonly impactA: THREE.Vector4[];
  readonly impactB: THREE.Vector4[];

  private readonly uniforms: Record<string, THREE.IUniform>;
  private readonly tier: Tier;
  /** Next slot to overwrite — §9.4 says the ring overwrites the *oldest*. */
  private cursor = 0;
  private frame = 0;
  private time = 0;

  constructor(opts: OrbOptions = {}) {
    this.tier = opts.tier ?? "high";
    const params = TIER_PARAMS[this.tier];

    this.geometry = new THREE.IcosahedronGeometry(1.2, params.orbDetail);

    this.impactA = Array.from({ length: IMPACT_SLOTS }, () => new THREE.Vector4(0, 0, 0, 0));
    this.impactB = Array.from({ length: IMPACT_SLOTS }, () => new THREE.Vector4(0, 0, 0, 0));

    this.uniforms = {
      uTime: { value: 0 },
      uFrame: { value: 0 },
      uCoreColor: { value: new THREE.Color(1, 1, 1) },
      uAccentColor: { value: new THREE.Color(1, 1, 1) },
      uDeep: { value: new THREE.Color(0, 0, 0) },
      uRms: { value: 0 },
      uBass: { value: 0 },
      uMid: { value: 0 },
      uHigh: { value: 0 },
      uFlux: { value: 0 },
      uSteps: { value: params.orbSteps },
      uOctaves: { value: params.orbOctaves },
      uJitter: { value: clamp(opts.jitter ?? ORB_DEFAULTS.jitter, 0, 1) },

      uRippleScale: { value: 1 },
      uAbsorb: { value: clamp(opts.absorb ?? ORB_DEFAULTS.absorb, 0.1, 12) },
      uEmission: { value: clamp(opts.emission ?? ORB_DEFAULTS.emission, 0.05, 4) },
      uImpactA: { value: this.impactA },
      uImpactB: { value: this.impactB },
    };

    this.material = new THREE.ShaderMaterial({
      vertexShader: ORB_VERT,
      fragmentShader: ORB_FRAG,
      uniforms: this.uniforms,
      defines: { SOK_MAX_OCTAVES: MAX_OCTAVES },
      // §9.4 writes both stages in GLSL3 syntax (`in` / `out` / `texture`), so
      // this must be GLSL3. Without it three.js assumes GLSL1 and prepends its
      // own `layout(location = 0) out highp vec4 pc_fragColor;` — which collides
      // with the shader's own `out vec4 outColor` and fails to link with a
      // confusing "must explicitly specify all locations" error rather than
      // anything mentioning glslVersion.
      glslVersion: THREE.GLSL3,
      transparent: true,
      // §9.4 — additive. Depth *writes* are off: the orb is a single convex volume
      // and nothing is behind it that could be occluded, so depth writes cost fill
      // rate for nothing. Depth *testing* is on, per §9.2 — and because no layer in
      // the scene writes depth, the depth buffer stays at its cleared far value and
      // every fragment passes. The two settings are behaviourally identical here;
      // §9.2's is the specified one and costs nothing.
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.FrontSide,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false; // its bounds never change; culling is pure cost
    // §9.2 — dust(0) → orb(1) → sparks(2) → rings(3). With additive blending the
    // order is not cosmetic: addition is commutative in exact arithmetic, but each
    // layer's alpha blend against the framebuffer is not, so a different order gives
    // a different image. The order is pinned rather than left to scene insertion.
    this.mesh.renderOrder = 1;
    this.mesh.name = "sok-orb";

    this.applyGovernor(opts.governorLevel ?? 0);
  }

  /**
   * §9.4 — add an impact, overwriting the oldest slot.
   *
   * `dir` is the edit's world direction (from the spatial mapper, §7.9); the
   * direction is normalised so `acos(dot(...))` in the shader is a real angle.
   * Magnitude is 0..1 and maps to `lerp(0.25, 1.0, magnitude)` — a minimum of
   * 0.25 because an impact with no visible strength is an impact that did not
   * happen, and the surface needs to register that *something* was edited.
   */
  addImpact(dir: THREE.Vector3, magnitude: number, kind: ImpactKind, startTime: number): void {
    const i = this.cursor;
    const a = this.impactA[i]!;
    const b = this.impactB[i]!;

    const len = Math.hypot(dir.x, dir.y, dir.z);
    if (len > 1e-6) {
      a.set(dir.x / len, dir.y / len, dir.z / len, 0);
    } else {
      // A zero direction has no angle; any unit vector is as good and keeps the
      // shader's `acos` well-defined rather than feeding it NaN.
      a.set(0, 1, 0, 0);
    }
    const m = clamp(magnitude, 0, 1);
    a.w = IMPACT_MIN_STRENGTH + (IMPACT_MAX_STRENGTH - IMPACT_MIN_STRENGTH) * m;
    b.set(startTime, kind === "dent" ? 1 : 0, 0, 0);

    this.cursor = (this.cursor + 1) % IMPACT_SLOTS;
  }

  /** Live impacts, for tests and the debug HUD. */
  get impactCount(): number {
    let n = 0;
    for (const v of this.impactA) if (v.w > 0) n++;
    return n;
  }

  /** The next slot `addImpact` will overwrite. */
  get cursorIndex(): number {
    return this.cursor;
  }

  /**
   * Apply §9.10's governor level.
   *
   * Only L3 touches the orb: steps −2 with a floor of 3, and octaves forced to
   * 2. Everything else in §9.10 is about bloom, dust, chroma and event rate,
   * none of which this material owns. Exposed separately from `update` because a
   * level change is rare and a resize is not.
   */
  applyGovernor(level: number): void {
    const params = TIER_PARAMS[this.tier];
    const steps = Math.max(3, params.orbSteps - (level >= 3 ? 2 : 0));
    const octaves = level >= 3 ? 2 : params.orbOctaves;
    this.uniforms.uSteps!.value = Math.min(steps, MAX_STEPS);
    this.uniforms.uOctaves!.value = Math.min(octaves, MAX_OCTAVES);
  }

  /**
   * Per-frame update. Spec §9.4: `update(time, features, palette)`.
   *
   * Expired impacts are zeroed here rather than in `addImpact`, because an
   * impact can outlive the 2.5 s window without anything calling in — a quiet
   * session must still stop showing ripples.
   */
  update(timeSec: number, features: AudioFeatures, palette: Palette): void {
    this.time = timeSec;
    this.frame = (this.frame + 1) % 4096; // wraps well inside float precision

    const u = this.uniforms;
    u.uTime!.value = timeSec;
    u.uFrame!.value = this.frame;

    u.uRms!.value = clamp(features.rms, 0, 1);
    u.uBass!.value = clamp(features.bass, 0, 1);
    u.uMid!.value = clamp(features.mid, 0, 1);
    u.uHigh!.value = clamp(features.high, 0, 1);
    u.uFlux!.value = clamp(features.flux, 0, 1);

    // Palette colours are uploaded from the *eased* current, so the orb drifts
    // with the scene on a harmony change rather than snapping ahead of it.
    const core = palette.current.core;
    const accent = palette.current.accent;
    const deep = palette.current.deep;
    (u.uCoreColor!.value as THREE.Color).setRGB(core.r, core.g, core.b);
    (u.uAccentColor!.value as THREE.Color).setRGB(accent.r, accent.g, accent.b);
    (u.uDeep!.value as THREE.Color).setRGB(deep.r, deep.g, deep.b);

    // Age out. The shader also checks `age > 2.5`, so this is belt-and-braces —
    // but it keeps the CPU-side count honest and stops `w > 0` meaning "alive
    // at some point in the last minute".
    for (let i = 0; i < IMPACT_SLOTS; i++) {
      const b = this.impactB[i]!;
      const a = this.impactA[i]!;
      if (a.w <= 0) continue;
      const age = timeSec - b.x;
      if (age < 0 || age > IMPACT_LIFETIME_SEC) a.w = 0;
    }
  }

  /**
   * Fire `count` synthetic impacts on a Fibonacci sphere.
   *
   * Exists for `scripts/shot.ts` and the e2e suite: §9.4's ripples are the most
   * likely thing to break silently, and proving they work needs a way to make one
   * appear without a live Wikipedia stream. Deterministic, so two runs produce
   * comparable screenshots.
   *
   * Owns its scratch `Vector3` — the caller has no `three` import and should not
   * need one.
   */
  /**
   * §9.11 — "orb ripple amplitude ×0.5" under reduced motion.
   *
   * Halved rather than removed: the ripples are the only way an edit becomes
   * visible on the orb, so suppressing them outright would leave §9.4's impact path
   * with no readout at all. 0.5 is the spec's figure.
   */
  setReducedMotion(on: boolean): void {
    this.material.uniforms.uRippleScale!.value = on ? 0.5 : 1;
  }

  addSyntheticImpacts(
    count: number,
    magnitude: number,
    kind: ImpactKind,
    timeSec: number,
    offset = 0,
  ): void {
    this.scratchDir ??= new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      Orb.directionFromIndex(this.syntheticCursor++, this.scratchDir);
      this.addImpact(this.scratchDir, magnitude, kind, timeSec);
    }
    void offset;
  }

  private scratchDir: THREE.Vector3 | null = null;
  private syntheticCursor = 0;

  /** Convenience for the harness: an arbitrary unit direction from an index. */
  static directionFromIndex(i: number, out = new THREE.Vector3()): THREE.Vector3 {
    // Fibonacci sphere — even coverage without the clustering a naive
    // random-ish mapping gives, so a screenshot at a fixed seed is stable.
    const k = (i + 0.5) / 8;
    const phi = Math.acos(1 - 2 * k);
    const theta = Math.PI * (1 + Math.sqrt(5)) * i;
    return out.set(Math.sin(phi) * Math.cos(theta), Math.sin(phi) * Math.sin(theta), Math.cos(phi));
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
