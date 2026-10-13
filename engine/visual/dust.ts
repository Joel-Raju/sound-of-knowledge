/**
 * Dust — ambient background particles. Spec §9.7.
 *
 * `THREE.Points` with a `ShaderMaterial`. Positions are generated **once** with a
 * seeded PRNG and never touched: the drift is a pure function of `uTime` and
 * `aSeed`, exactly as §9.5 does for sparks, so there is no simulation state and no
 * per-frame CPU work beyond a handful of uniforms.
 *
 * The shell is radius 3–40 and the camera sits at 5.5 (§9.1), so the dust surrounds
 * the viewer as well as the orb — which is what makes the scene read as a volume
 * rather than a backdrop.
 */
import * as THREE from "three";
import { TIER_PARAMS } from "../config";
import type { Tier } from "../types";
import { mulberry32 } from "../util/random";

/** §9.7 — uniform distribution within a spherical shell, 3 to 40. */
export const DUST_SHELL = { inner: 3, outer: 40 } as const;

/**
 * §9.7 — `gl_PointSize` is clamped to this range in device pixels.
 *
 * The clamp is not cosmetic. A point with no size clamp is a square whose area grows
 * as the square of distance-inverse, so one close mote can cover a tenth of the screen
 * as a hard white block — and this is a scene with additive blending on a dark
 * background, where that reads as a glitch rather than as dust.
 */
export const DUST_SIZE = { min: 1, max: 6 } as const;

/** §9.7 — `0.4 *` drift amplitude, in world units. */
export const DUST_DRIFT = 0.4;

/** §9.7 — high-frequency band boosts point size by up to 50 %. */
export const DUST_HI_BOOST = 0.5;

export interface DustOptions {
  tier?: Tier;
  /** Seed for the position PRNG; fixed so a capture is reproducible (§13.4). */
  seed?: number;
}

/** Re-exported as one object so the harness and tests read a single definition. */
export const DUST = { shell: DUST_SHELL, size: DUST_SIZE } as const;

export class Dust {
  readonly points: THREE.Points;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.ShaderMaterial;
  /** Allocated point count. Mutable because `setTier` reallocates. */
  count: number;

  private tier: Tier;
  /** Visible count after §9.7's L4 halving; the governor's only lever here. */
  private visible: number;

  constructor(opts: DustOptions = {}) {
    this.tier = opts.tier ?? "high";
    this.count = TIER_PARAMS[this.tier].dustPoints;
    this.visible = this.count;

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", dustPositions(this.count, opts.seed ?? 0x5eed));
    this.geometry.setAttribute("aSeed", dustSeeds(this.count, opts.seed ?? 0x5eed));
    // The points never move in world space — drift is in the shader — so the static
    // bounds are correct and frustum culling can stay on. Without them three.js
    // computes a sphere containing the whole 3–40 shell, which would never cull.
    this.geometry.computeBoundingSphere();

    this.material = new THREE.ShaderMaterial({
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: 1 },
        uHigh: { value: 0 },
        uColor: { value: new THREE.Color(0.5, 0.5, 0.5) },
        uSizeMin: { value: DUST_SIZE.min },
        uSizeMax: { value: DUST_SIZE.max },
        uBaseSize: { value: 3 },
        uDrift: { value: DUST_DRIFT },
        uHiBoost: { value: DUST_HI_BOOST },
        uTwinkle: { value: 1 },
      },
      transparent: true,
      // Additive, like the sparks: dust is light, not paint.
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      glslVersion: THREE.GLSL3,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    // §9.2 draw order — dust is first, behind everything.
    this.points.renderOrder = 0;
    this.points.name = "sok-dust";
    // Set explicitly rather than left at three.js's default of `count: Infinity`.
    // L4 halving reads `drawRange.count`, so an explicit full-range value makes the
    // pre-L4 state a known quantity instead of a sentinel.
    this.geometry.setDrawRange(0, this.count);
  }

  /**
   * §9.7 — governor L4 halves the visible count.
   *
   * `setDrawRange` rather than rebuilding the buffer: the points keep their seeded
   * positions, so which half is dropped must not depend on when the level changed.
   */
  setGovernorLevel(level: number): void {
    this.visible = level >= 4 ? Math.floor(this.count / 2) : this.count;
    this.geometry.setDrawRange(0, this.visible);
  }

  /** Switch tier — regenerates the buffer, since the count differs. */
  setTier(tier: Tier, seed = 0x5eed): void {
    if (tier === this.tier) return;
    this.tier = tier;
    const next = TIER_PARAMS[tier].dustPoints;
    this.geometry.setAttribute("position", dustPositions(next, seed));
    this.geometry.setAttribute("aSeed", dustSeeds(next, seed));
    this.geometry.computeBoundingSphere();
    this.geometry.setDrawRange(0, next);
    this.count = next;
    this.visible = next;
  }

  /** Points currently drawn. */
  get drawn(): number {
    return this.visible;
  }

  /** §9.11 — reduced motion caps the twinkle rather than removing the dust. */
  setTwinkleScale(scale: number): void {
    this.material.uniforms.uTwinkle!.value = scale;
  }

  /**
   * §9.7 per-frame update.
   *
   * `color` is the palette's `Rgb` triple rather than a `THREE.Color`, because the
   * palette speaks `Rgb` everywhere else in the engine and converting here would
   * allocate or require the harness to keep a spare `Color` around. The three floats
   * are copied into the uniform directly.
   */
  update(
    timeSec: number,
    pixelRatio: number,
    high: number,
    color: { r: number; g: number; b: number },
  ): void {
    const u = this.material.uniforms;
    u.uTime!.value = timeSec;
    u.uPixelRatio!.value = pixelRatio;
    u.uHigh!.value = high;
    // Copied rather than aliased: the palette eases its colour every frame, and
    // holding a reference would let a disposed palette keep this alive.
    (u.uColor!.value as THREE.Color).setRGB(color.r, color.g, color.b);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * Positions uniform in **volume** within a shell, 3 to 40.
 *
 * The radius is sampled as cbrt of a linear interpolation of the cubes, not as a
 * linear interpolation of the radii. Uniform-in-radius crowds a third of all the
 * points inside r < 13 and packs them against the inner boundary — and the camera
 * sits at 5.5 (§9.1), just outside that boundary, so those are the points nearest
 * the eye. At 6 px each and additive, a shell of near-camera motes reads as a
 * starfield rather than as dust, and lifts the whole background off black.
 * Uniform-in-volume is also the ordinary reading of "uniformly distributed in a
 * shell": constant density per unit volume.
 *
 * Direction comes from a spherical Fibonacci lattice with a per-point random phase,
 * so points are spread evenly over the sphere instead of clumping the way
 * independent random directions do.
 */
function dustPositions(count: number, seed: number): THREE.BufferAttribute {
  const rand = mulberry32(seed);
  const out = new Float32Array(count * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const ri3 = DUST_SHELL.inner ** 3;
  const ro3 = DUST_SHELL.outer ** 3;
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / Math.max(1, count - 1)) * 2; // -1 … 1
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i + rand() * (Math.PI * 2);
    const r = Math.cbrt(ri3 + (ro3 - ri3) * rand());
    out[i * 3] = Math.cos(theta) * ring * r;
    out[i * 3 + 1] = y * r;
    out[i * 3 + 2] = Math.sin(theta) * ring * r;
  }
  return new THREE.BufferAttribute(out, 3);
}

/** Per-point random in [0,1) driving both the drift phase and the twinkle phase. */
function dustSeeds(count: number, seed: number): THREE.BufferAttribute {
  // Offset so the seed stream does not replay the same values as the positions.
  const rand = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = rand();
  return new THREE.BufferAttribute(out, 1);
}

/**
 * §9.7 vertex shader.
 *
 * `position` and the point-size attribute are three.js's own declarations — see the
 * note in `sparks.shader.ts`; redeclaring them fails to link under GLSL3.
 *
 * No backticks appear in any comment below: they would terminate the template
 * literal this file is written in.
 */
export const DUST_VERT = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uPixelRatio;
uniform float uHigh;
uniform float uBaseSize;
uniform float uSizeMin;
uniform float uSizeMax;
uniform float uDrift;
uniform float uHiBoost;

in float aSeed;

out float vTwinkle;

void main() {
  // Drift is a pure function of time and this point's seed — no state, no
  // simulation, matching §9.5's treatment of sparks.
  vec3 p = position + uDrift * vec3(
    sin(uTime * 0.05 + aSeed * 10.0),
    cos(uTime * 0.043 + aSeed * 7.0),
    sin(uTime * 0.037 + aSeed * 13.0)
  );

  vec4 mv = modelViewMatrix * vec4(p, 1.0);

  // Perspective falloff. Division by -mv.z would invert and explode for a point at
  // or behind the eye plane, so the denominator is floored first.
  float depth = max(0.5, -mv.z);
  float size = uBaseSize * uPixelRatio * (1.0 + uHiBoost * uHigh) * (5.0 / depth);
  gl_PointSize = clamp(size, uSizeMin, uSizeMax);

  // §9.7's twinkle, computed here so the fragment stage only multiplies.
  vTwinkle = 0.25 + 0.75 * pow(sin(uTime * (0.5 + aSeed) + aSeed * 40.0), 2.0);
  gl_Position = projectionMatrix * mv;
}
`;

/**
 * §9.7 fragment shader — a soft round point.
 *
 * `gl_PointCoord` is a single varying across the whole quad, so the round falloff is
 * computed from its distance to the centre; a square point would read as a grid of
 * hard rectangles rather than as dust.
 */
export const DUST_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uColor;
uniform float uTwinkle;

in float vTwinkle;
out vec4 outColor;

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  if (d > 1.0) discard;
  float a = 1.0 - d * d;
  float alpha = a * vTwinkle * uTwinkle;
  if (alpha <= 0.0) discard;
  outColor = vec4(uColor * alpha, alpha);
}
`;