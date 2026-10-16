/**
 * Post-processing stack. Spec §9.8, with the §9.11 photosensitivity limits applied.
 *
 * The composer is the only thing that draws to screen (§9.8) — the renderer issues
 * its draw into the composer's buffer and the composer's final pass reaches the
 * canvas. That is why `setSize` has to be called on both, and why the pixel ratio is
 * applied to the renderer rather than to the composer.
 *
 * **Bloom intensity is not a value, it is a filtered signal.** §9.8 asks for
 * `0.8 + 0.6 * rmsSmooth`, and §9.11 independently caps any global brightness
 * modulation at ±35 % with τ ≥ 0.15 s. Both are implemented, and the ±35 % is
 * measured against §9.8's own baseline rather than against zero — capping an
 * intensity *ratio* to ±35 % would allow a floor value of 0.8 to swing to 1.08 and
 * back, which is ±19 % of the signal but ±35 % of nothing in particular.
 */
import * as THREE from "three";
import {
  BloomEffect,
  ChromaticAberrationEffect,
  EffectComposer,
  EffectPass,
  NoiseEffect,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
  BlendFunction,
} from "postprocessing";
import { TIER_PARAMS } from "../config";
import type { Tier } from "../types";

/** §9.11 — τ for the bloom low-pass. The spec's floor is 0.15 s. */
export const BLOOM_TAU_SEC = 0.15;
/** §9.11 — "amplitude limited to ±35 %", applied around the §9.8 baseline. */
export const BLOOM_AMPLITUDE_LIMIT = 0.35;
/** §9.8 — `intensity = 0.8 + 0.6 * rmsSmooth`. */
export const BLOOM_BASE = 0.8;
export const BLOOM_RMS_GAIN = 0.6;
/** §9.11 — reduced motion caps bloom intensity here. */
export const BLOOM_REDUCED_MOTION_CAP = 0.7;

/** §9.8 — `caKick` decays with τ = 0.35 s; +0.0025 on a revert. */
export const CA_TAU_SEC = 0.35;
export const CA_REVERT_KICK = 0.0025;
/**
 * §10.2 — a large edit's "slow bloom swell". A separate, longer clock from
 * `BLOOM_TAU_SEC`: the swell should still be faintly present after the transient
 * that caused it has gone, which is what makes it read as a swell rather than a pulse.
 */
export const BLOOM_SWELL_TAU_SEC = 1.6;
/** §10.2 — how much a large edit swells the bloom, in intensity units. */
export const BLOOM_SWELL_LARGE = 0.22;
export const CA_BASE_OFFSET = 0.0004;

/** §9.8 — "AgX if available in the installed version, else ACES Filmic", exposure 1.0. */
export type ToneMappingChoice = "agx" | "aces";

/**
 * Both modes are available in `postprocessing@6.39.5`, so the spec's fallback is
 * never needed. Which one is *used* is C11, and the answer was measured rather than
 * assumed — see `DECISIONS.md`.
 *
 * AgX desaturates and rolls highlights off hard, which flattens §9.4's ray-marched
 * interior into one near-white value. ACES holds more separation up top. `?tonemap=aces`
 * switches between them so the two can be compared in a single sweep.
 */
const TONE_MAPPING: Record<ToneMappingChoice, ToneMappingMode> = {
  agx: ToneMappingMode.AGX,
  aces: ToneMappingMode.ACES_FILMIC,
};

/** §9.2 — the effects that can be toggled at runtime. */
export const POST_EFFECTS = ["bloom", "chromaticAberration", "noise", "vignette"] as const;
export type PostEffect = (typeof POST_EFFECTS)[number];

/** §9.8 — ≤ 3 full-screen passes excluding the bloom mip chain. */
export const POST_PASS_COUNT = 2;

/** Exponential smoothing toward a target with time constant `tau` (§9.11). */
function lowpass(current: number, target: number, dtSec: number, tau: number): number {
  if (!(dtSec > 0)) return current;
  const a = 1 - Math.exp(-dtSec / Math.max(1e-4, tau));
  return current + (target - current) * a;
}

export interface PostOptions {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  tier?: Tier;
  /** C11 — `?tonemap=`. Defaults to AgX, which is §9.8's stated preference. */
  toneMapping?: ToneMappingChoice;
}

export class Post {
  readonly composer: EffectComposer;
  readonly bloom: BloomEffect;
  readonly chromaticAberration: ChromaticAberrationEffect;
  readonly vignette: VignetteEffect;
  readonly noise: NoiseEffect;
  readonly toneMapping: ToneMappingEffect;

  /** The §9.8 target before §9.11 clamps it — useful for the HUD and for tests. */
  private bloomBias = 0;
  /** §10.2's transient swell; decays in `update` on `BLOOM_SWELL_TAU_SEC`. */
  private bloomSwell = 0;
  private bloomCurrent = BLOOM_BASE;
  private caKick = 0;
  private caOffset = new THREE.Vector2(CA_BASE_OFFSET, CA_BASE_OFFSET);
  /** Reused so the per-frame update allocates nothing (§12.1). */
  private enabled: Record<PostEffect, boolean>;

  constructor(opts: PostOptions) {
    this.tier = opts.tier ?? "high";
    const tierParams = TIER_PARAMS[this.tier];

    this.composer = new EffectComposer(opts.renderer, {
      frameBufferType: THREE.HalfFloatType,
      multisampling: 0,
    });

    this.bloom = new BloomEffect({
      mipmapBlur: true,
      intensity: BLOOM_BASE,
      luminanceThreshold: 0.55,
      luminanceSmoothing: 0.25,
      radius: 0.75,
      levels: tierParams.bloomLevels,
    });

    this.chromaticAberration = new ChromaticAberrationEffect({
      offset: this.caOffset,
      radialModulation: true,
      modulationOffset: 0.15,
    });

    this.vignette = new VignetteEffect({
      darkness: 0.55,
      offset: 0.3,
    });

    // Grain doubles as dither: §9.8 says so outright, and §13.4's acceptance for
    // this task is "non-banded dark gradient", which a 0.06 grain is what fixes.
    this.noise = new NoiseEffect({
      blendFunction: BlendFunction.OVERLAY,
      premultiply: true,
    });
    this.noise.blendMode.opacity.value = tierParams.grainOpacity;

    // §9.8 — "AgX if available in the installed version, else ACES Filmic",
    // exposure 1.0. Both exist in 6.39.5, so the fallback is never *needed*; the
    // choice between them is C11's, and is switchable rather than baked in.
    //
    // Only `mode` is set, and the library's own defaults are used for the adaptive
    // parameters (whitePoint, middleGrey, minLuminance, …) because §9.8 specifies
    // none of them. Inventing values for them lifted the near-black clear colour to a
    // visible navy across the whole frame — a tone-mapping curve problem that reads
    // exactly like a palette one, and would have been misfiled as the latter.
    const mode = opts.toneMapping ?? "agx";
    this.toneMapping = new ToneMappingEffect({ mode: TONE_MAPPING[mode] });

    this.composer.addPass(new RenderPass(opts.scene, opts.camera));

    // §9.8 asks for "as few EffectPasses as the library allows". Chromatic
    // aberration, vignette and grain are all a single texture fetch plus arithmetic,
    // so they merge into one pass; tone mapping must stay last because it converts
    // the framebuffer's working space, and merging it with anything after it would
    // mean operating on already-tonemapped values.
    this.composer.addPass(
      new EffectPass(
        opts.camera,
        this.chromaticAberration,
        this.vignette,
        this.noise,
      ),
    );
    this.composer.addPass(new EffectPass(opts.camera, this.toneMapping));

    // §9.8 — CA is off on tier low / governor L1; grain drops to 0.02 there too.
    this.enabled = {
      bloom: true,
      chromaticAberration: tierParams.chromaticAberration,
      noise: true,
      vignette: true,
    };
    this.chromaticAberration.blendMode.opacity.value = this.enabled.chromaticAberration
      ? 1
      : 0;
    if (this.tier === "low") {
      this.enabled.chromaticAberration = false;
      this.chromaticAberration.blendMode.opacity.value = 0;
    }
  }

  private tier: Tier;

  /**
   * §9.11 — reduced motion caps bloom at 0.7 and removes the CA kick entirely.
   *
   * Cap rather than disable: §9.11 says "bloom intensity cap 0.7", not "no bloom".
   */
  setReducedMotion(on: boolean): void {
    this.reducedMotion = on;
    if (on) {
      this.caKick = 0;
      this.chromaticAberration.blendMode.opacity.value = 0;
    }
  }

  private reducedMotion = false;

  /**
   * §9.8 — a baseline offset applied on top of the RMS response.
   *
   * **This used to be dead.** The setter wrote `bloomTarget` and `update()` never read
   * it, recomputing bloom from RMS every frame — so the setter had no effect on screen
   * whatsoever while looking entirely configured. Found while wiring §10.2's "slow
   * bloom swell" for a large edit, which is the first clause that needs it.
   *
   * Expressed as a *bias* rather than a replacement so it composes with §9.8's
   * RMS-driven term instead of cancelling it: `v` is the intensity this calls for when
   * the mix is silent.
   */
  setBloomIntensity(v: number): void {
    this.bloomBias = v - BLOOM_BASE;
  }

  /**
   * §10.2 — a large edit carries "trauma +0.15; slow bloom swell".
   *
   * Separate from `setBloomIntensity` because the two have different lifetimes: a bias
   * persists until changed, a swell decays away on its own slower clock. Conflating
   * them would have made a transient into a permanent shift in how the whole mix looks.
   */
  swellBloom(amount: number): void {
    this.bloomSwell += amount;
  }

  /** §9.8 — +0.0025 on a revert. Ignored under §9.11 reduced motion. */
  kickChromaticAberration(amount = CA_REVERT_KICK): void {
    if (this.reducedMotion) return;
    this.caKick += amount;
  }

  /** T4.4's named runtime setter for the degradation ladder. */
  setLevels(level: number): void {
    this.setGovernorLevel(level);
  }

  /** §9.8 / §9.10 — CA off at governor L1; §9.7-style feature shedding after. */
  setGovernorLevel(level: number): void {
    const caAllowed = level < 1 && this.tier !== "low" && !this.reducedMotion;
    this.enabled.chromaticAberration = caAllowed;
    this.chromaticAberration.blendMode.opacity.value = caAllowed ? 1 : 0;
    if (level >= 2) this.enabled.bloom = false;
  }

  setEnabled(effect: PostEffect, on: boolean): void {
    this.enabled[effect] = on;
    const opacity = on ? 1 : 0;
    if (effect === "chromaticAberration") {
      this.chromaticAberration.blendMode.opacity.value = opacity;
      return;
    }
    if (effect === "noise") {
      this.noise.blendMode.opacity.value = on
        ? TIER_PARAMS[this.tier].grainOpacity
        : 0;
      return;
    }
    // Bloom and vignette carry no blend-mode opacity of their own; they are gated by
    // `intensity` / `darkness`, which is what "disabled" means for each.
    if (effect === "bloom") this.bloom.intensity = on ? this.bloomCurrent : 0;
    if (effect === "vignette") this.vignette.darkness = on ? 0.55 : 0;
  }

  isEnabled(effect: PostEffect): boolean {
    return this.enabled[effect];
  }

  /**
   * Per-frame update — the low-pass filters, §9.11.
   *
   * @param dtSec frame delta
   * @param rmsSmooth the engine's smoothed RMS, 0–1
   */
  update(dtSec: number, rmsSmooth: number): void {
    // §9.8's target, then §9.11's clamp around it.
    const raw = BLOOM_BASE + BLOOM_RMS_GAIN * clamp01(rmsSmooth);
    const span = BLOOM_AMPLITUDE_LIMIT * BLOOM_BASE;
    const biased = raw + this.bloomBias + this.bloomSwell;
    const clamped = Math.min(biased, BLOOM_BASE + span);
    const capped = this.reducedMotion
      ? Math.min(clamped, BLOOM_REDUCED_MOTION_CAP)
      : clamped;

    this.bloomCurrent = lowpass(this.bloomCurrent, capped, dtSec, BLOOM_TAU_SEC);
    if (this.enabled.bloom) this.bloom.intensity = this.bloomCurrent;

    // The swell decays on its own, slower clock: §10.2's "slow bloom swell" for a
    // large edit is meant to *linger* after the transient passes, not track it.
    this.bloomSwell = lowpass(this.bloomSwell, 0, dtSec, BLOOM_SWELL_TAU_SEC);

    // CA kick decays with its own τ, per §9.8.
    this.caKick = lowpass(this.caKick, 0, dtSec, CA_TAU_SEC);
    const offset = CA_BASE_OFFSET + this.caKick;
    this.caOffset.set(offset, offset);
    this.chromaticAberration.offset = this.caOffset;
  }

  /** The bloom intensity actually applied last frame — for tests and the HUD. */
  get bloomIntensity(): number {
    return this.bloom.intensity;
  }

  /** CA offset actually applied last frame. */
  get chromaticOffset(): number {
    return this.caOffset.x;
  }

  /**
 * Resize on window resize and on every governor scale change (§9.8).
 *
 * **The pixel ratio is not passed here, and that is not an omission.** Verified in
 * `postprocessing@6.39.5`: `EffectComposer` has no `setPixelRatio`. Its `setSize`
 * takes CSS pixels, calls `renderer.setSize()` itself, and derives every render
 * target from `renderer.getDrawingBufferSize()` — which already includes whatever
 * `setPixelRatio` the renderer was given. The engine applies that ratio from
 * §9.1/§12.3 (`min(dpr, tierCeiling)` and the governor's scale), so folding it in
 * here as well would scale the buffer twice.
 */
  setSize(width: number, height: number): void {
    this.composer.setSize(width, height);
  }

  render(deltaSec: number): void {
    this.composer.render(deltaSec);
  }

  dispose(): void {
    this.composer.dispose();
    this.bloom.dispose();
    this.chromaticAberration.dispose();
    this.vignette.dispose();
    this.noise.dispose();
    this.toneMapping.dispose();
  }
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0;
}