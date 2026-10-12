/**
 * Palette. Spec §9.3.
 *
 * Colours are authored in OKLCH and converted to linear sRGB for shader
 * uniforms — the conversion and its gamut mapping live in `util/oklch.ts` and
 * were built in T0.3.
 *
 * Three rules, all from §9.3:
 *   - **key shift** — `hue += fifths * 5°`, so adjacent keys on the circle of
 *     fifths land on adjacent hues;
 *   - **transitions** — the *target* changes on a harmony event and the
 *     *current* eases toward it with τ = 2 s, in linear RGB;
 *   - **event colours** — additions take the accent, removals the core, with
 *     HDR multipliers where the spec calls for them.
 *
 * No allocation after construction: every `update()` writes into preallocated
 * triples, because this runs on the frame loop.
 */
import { MODE_NAMES } from "../config";
import { mixRgb, oklchToLinearSrgb, type Rgb } from "../util/oklch";
import { smoothingCoefficient } from "../util/math";
import type { ModeId } from "../types";

/** Authoring values, spec §9.3's per-mode table. */
interface PaletteSpec {
  core: readonly [number, number, number];
  accent: readonly [number, number, number];
  dust: readonly [number, number, number];
  deep: readonly [number, number, number];
}

const SPEC: Record<ModeId, PaletteSpec> = {
  lydian: {
    core: [0.86, 0.12, 85],
    accent: [0.82, 0.14, 200],
    dust: [0.75, 0.06, 60],
    deep: [0.12, 0.02, 260],
  },
  mixolydian: {
    core: [0.84, 0.13, 165],
    accent: [0.82, 0.15, 60],
    dust: [0.72, 0.05, 180],
    deep: [0.12, 0.025, 230],
  },
  dorian: {
    core: [0.8, 0.13, 250],
    accent: [0.78, 0.16, 330],
    dust: [0.7, 0.05, 260],
    deep: [0.11, 0.025, 270],
  },
  aeolian: {
    core: [0.74, 0.14, 295],
    accent: [0.78, 0.15, 25],
    dust: [0.65, 0.05, 300],
    deep: [0.1, 0.03, 290],
  },
};

/** Per-language hue offset, ±12° (spec §9.3). Deterministic from the hash. */
export const LANG_HUE_SPREAD_DEG = 12;

/** Spec §9.3 — palette uniforms ease toward the target with τ = 2 s. */
export const PALETTE_TAU_SEC = 2;

/**
 * Spec §9.3 — `fifths = ((rootPc*7) % 12 + 6) % 12 − 6`.
 *
 * Exported because the mapping is worth testing on its own: it is the one piece
 * of the palette with arithmetic in it, and getting it wrong makes every key
 * look wrong in the same way.
 */
export function fifthsOf(rootPc: number): number {
  const pc = ((Math.round(rootPc) % 12) + 12) % 12;
  return ((((pc * 7) % 12) + 6) % 12) - 6;
}

/** Spec §9.3 — `hue += fifths * 5°`. */
export function keyHueShift(rootPc: number): number {
  return fifthsOf(rootPc) * 5;
}

/**
 * Hue offset for one language, ±12°.
 *
 * Uses the low bits of the existing FNV-1a hash rather than a second hash
 * function, so a language maps to the same value everywhere in the app.
 */
export function langHueOffset(hash: number): number {
  // Map to [-1, 1] from the low 16 bits, then scale.
  const unit = ((hash >>> 0) & 0xffff) / 0xffff;
  return (unit * 2 - 1) * LANG_HUE_SPREAD_DEG;
}

/** The four colours, in linear sRGB, for a mode and key. */
export interface PaletteColors {
  core: Rgb;
  accent: Rgb;
  dust: Rgb;
  deep: Rgb;
}

function build(spec: PaletteSpec, hueShift: number): PaletteColors {
  const shift = (c: readonly [number, number, number], out: Rgb): Rgb => {
    let h = c[2] + hueShift;
    // Keep hue in [0, 360) — a negative hue is equivalent but confusing to log.
    h = ((h % 360) + 360) % 360;
    return oklchToLinearSrgb(c[0], c[1], h, out);
  };
  return {
    core: shift(spec.core, { r: 0, g: 0, b: 0 }),
    accent: shift(spec.accent, { r: 0, g: 0, b: 0 }),
    dust: shift(spec.dust, { r: 0, g: 0, b: 0 }),
    deep: shift(spec.deep, { r: 0, g: 0, b: 0 }),
  };
}

const KEYS: (keyof PaletteColors)[] = ["core", "accent", "dust", "deep"];

/** Event colour kinds, spec §9.3. */
export type EventColor = "addition" | "removal" | "large" | "revert" | "burst" | "bot";

function copyInto(dst: PaletteColors, src: PaletteColors): void {
  for (const k of KEYS) {
    dst[k].r = src[k].r;
    dst[k].g = src[k].g;
    dst[k].b = src[k].b;
  }
}

export class Palette {
  /** Where the ease is heading. */
  readonly target: PaletteColors;
  /** Where the ease currently is — this is what shaders read. */
  readonly current: PaletteColors;

  private mode: ModeId = "lydian";
  private rootPc = 0;

  /** Scratch for event colours, so the frame loop never allocates. */
  private readonly scratchA: Rgb = { r: 0, g: 0, b: 0 };
  private readonly scratchB: Rgb = { r: 0, g: 0, b: 0 };
  private readonly eventOut: Rgb = { r: 0, g: 0, b: 0 };

  constructor(mode: ModeId = "lydian", rootPc = 0) {
    this.target = {
      core: { r: 0, g: 0, b: 0 },
      accent: { r: 0, g: 0, b: 0 },
      dust: { r: 0, g: 0, b: 0 },
      deep: { r: 0, g: 0, b: 0 },
    };
    this.current = {
      core: { r: 0, g: 0, b: 0 },
      accent: { r: 0, g: 0, b: 0 },
      dust: { r: 0, g: 0, b: 0 },
      deep: { r: 0, g: 0, b: 0 },
    };
    this.set(mode, rootPc, true);
  }

  get currentMode(): ModeId {
    return this.mode;
  }

  get currentRootPc(): number {
    return this.rootPc;
  }

  /**
   * Retarget the palette. `immediate` skips the ease — used at construction and
   * by tests, never on a live harmony event.
   */
  set(mode: ModeId, rootPc: number, immediate = false): void {
    const spec = SPEC[mode];
    if (!spec) return;
    this.mode = mode;
    this.rootPc = rootPc;
    const next = build(spec, keyHueShift(rootPc));
    copyInto(this.target, next);
    if (immediate) copyInto(this.current, next);
  }

  /**
   * Ease `current` toward `target`, spec §9.3 — exponential smoothing with
   * τ = 2 s, in linear RGB.
   *
   * Frame-rate independent: `a = 1 − exp(−dt/τ)`, not a fixed fraction per
   * frame, so a 30 Hz device and a 144 Hz device converge at the same rate.
   */
  update(dtSec: number): void {
    const a = smoothingCoefficient(dtSec, PALETTE_TAU_SEC);
    if (a <= 0) return;
    if (a >= 1) {
      copyInto(this.current, this.target);
      return;
    }
    for (const k of KEYS) {
      const t = this.target[k];
      const c = this.current[k];
      c.r += (t.r - c.r) * a;
      c.g += (t.g - c.g) * a;
      c.b += (t.b - c.b) * a;
    }
  }

  /** True while the ease is still moving, so the renderer can skip redundant uniform writes. */
  get isSettled(): boolean {
    for (const k of KEYS) {
      const t = this.target[k];
      const c = this.current[k];
      if (Math.abs(t.r - c.r) > 1e-4 || Math.abs(t.g - c.g) > 1e-4 || Math.abs(t.b - c.b) > 1e-4) {
        return false;
      }
    }
    return true;
  }

  /**
   * Colour for one event, spec §9.3. Writes into a reused object.
   *
   * The returned triple is **owned by the Palette** and is overwritten on the
   * next call — read it, do not keep it. That is what lets this stay
   * allocation-free on the frame loop.
   */
  colorFor(kind: EventColor, _magnitude = 0.5): Rgb {
    const core = this.current.core;
    const accent = this.current.accent;
    const dust = this.current.dust;
    const o = this.eventOut;

    switch (kind) {
      case "addition":
        o.r = accent.r;
        o.g = accent.g;
        o.b = accent.b;
        break;
      case "removal":
        o.r = core.r;
        o.g = core.g;
        o.b = core.b;
        break;
      case "large": {
        // `mix(core, accent, 0.5) * 1.3`
        const m = mixRgb(core, accent, 0.5, this.scratchA);
        o.r = m.r * 1.3;
        o.g = m.g * 1.3;
        o.b = m.b * 1.3;
        break;
      }
      case "revert": {
        // `mix(core, accent, 0.5) * 1.5`, then 40 % toward white
        const m = mixRgb(core, accent, 0.5, this.scratchA);
        o.r = m.r * 1.5 * 0.6 + 0.4;
        o.g = m.g * 1.5 * 0.6 + 0.4;
        o.b = m.b * 1.5 * 0.6 + 0.4;
        break;
      }
      case "burst": {
        // `accent * 1.8` + 30 % white
        o.r = accent.r * 1.8 * 0.7 + 0.3;
        o.g = accent.g * 1.8 * 0.7 + 0.3;
        o.b = accent.b * 1.8 * 0.7 + 0.3;
        break;
      }
      case "bot": {
        // `dust * 1.6`
        o.r = dust.r * 1.6;
        o.g = dust.g * 1.6;
        o.b = dust.b * 1.6;
        break;
      }
    }

    // HDR values above 1 are intentional (§9.2) — they drive the bloom. `magnitude`
    // is deliberately *not* applied here: §9.5's "spark head 1.5–3.5 scaled by
    // lerp(1.5, 3.5, magnitude)" is a property of the spark shader, applied in
    // T4.3. Multiplying the base event colour here would make every ordinary
    // note 1.5–3.5× brighter, which is the spark's job twice over.
    //
    // NaN can only arrive from a corrupted palette, but a NaN colour uploaded as
    // a uniform renders as black or white depending on the driver, so it is
    // clamped rather than trusted.
    if (!Number.isFinite(o.r)) o.r = 0;
    if (!Number.isFinite(o.g)) o.g = 0;
    if (!Number.isFinite(o.b)) o.b = 0;
    return o;
  }

  /**
   * Clear colour for the renderer, spec §9.1 — palette `deep`.
   *
   * Returned as a fresh object because the renderer reads it once at startup
   * and again on mode change, and a shared mutable triple here would be a trap.
   */
  clearColor(): Rgb {
    const d = this.current.deep;
    return { r: d.r, g: d.g, b: d.b };
  }
}

/** Every mode's authored values, for tests and the tuning docs. */
export const PALETTE_SPEC: Readonly<Record<ModeId, PaletteSpec>> = SPEC;

/** The modes in declaration order, matching `MODE_NAMES`. */
export const PALETTE_MODES: readonly ModeId[] = MODE_NAMES;
