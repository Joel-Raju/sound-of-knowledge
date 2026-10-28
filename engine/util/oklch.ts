/**
 * OKLCH → linear sRGB. Spec §9.3.
 *
 * Björn Ottosson's OKLab matrices, transcribed exactly as given in the spec.
 * Colours are authored perceptually (OKLCH) and consumed by shaders, which
 * need *linear* values — converting to sRGB-encoded floats here would make
 * every palette entry too dark once the renderer applies its own output
 * transform.
 */

export type Oklch = { L: number; C: number; h: number };
export type Rgb = { r: number; g: number; b: number };

const DEG = Math.PI / 180;

/** Spec §9.3 gamut-reduction step. */
const GAMUT_REDUCTION = 0.05;
const MAX_GAMUT_ITERATIONS = 8;

/** Linear sRGB for one OKLab triple. */
export function oklabToLinearSrgb(L: number, a: number, b: number, out: Rgb): Rgb {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  out.r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  out.g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  out.b = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return out;
}

/** Inverse of `oklabToLinearSrgb` for a single channel triple. */
export function linearSrgbToOklab(r: number, g: number, b: number, out: Oklch): Oklch {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  out.L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

  out.C = Math.hypot(a, bb);
  out.h = Math.atan2(bb, a) / DEG;
  return out;
}

/**
 * Gamut tolerance.
 *
 * Converting an in-gamut colour lands a few units in the last place outside
 * [0,1] — OKLCH(0.628, 0.2577, 29.23) *is* linear red and comes out at
 * r = 1.00021. The spec's remedy for "out of gamut" is to cut chroma by 5 %,
 * which for a boundary colour is a visible hue shift, whereas clamping
 * 1.00021 → 1.0 is imperceptible. So the tolerance sits well above float
 * noise (1e-3 ≈ 0.1 %) to make us clamp rather than desaturate.
 */
const GAMUT_EPSILON = 1e-3;

function inGamut(c: Rgb): boolean {
  const e = GAMUT_EPSILON;
  return c.r >= -e && c.r <= 1 + e && c.g >= -e && c.g <= 1 + e && c.b >= -e && c.b <= 1 + e;
}

/**
 * OKLCH → linear sRGB with gamut mapping.
 *
 * Spec §9.3: clamp to 0..1; if out of gamut, reduce chroma by 5 % steps until
 * in gamut, max 8 iterations. Preserves hue and lightness, which is what makes
 * the mode palettes keep their character even when a hue pushes outside sRGB.
 *
 * `out` is caller-provided so hot paths never allocate.
 */
export function oklchToLinearSrgb(L: number, C: number, hDeg: number, out: Rgb): Rgb {
  let c = C < 0 ? 0 : C;
  const h = hDeg * DEG;
  const ca = Math.cos(h);
  const sa = Math.sin(h);

  let iterations = 0;
  for (;;) {
    oklabToLinearSrgb(L, c * ca, c * sa, out);
    if (inGamut(out) || iterations >= MAX_GAMUT_ITERATIONS) break;
    c *= 1 - GAMUT_REDUCTION;
    iterations++;
  }

  // Final clamp (spec §9.3). Also guarantees finite output for NaN input.
  out.r = clampFinite(out.r);
  out.g = clampFinite(out.g);
  out.b = clampFinite(out.b);
  return out;
}

function clampFinite(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Convenience: allocate a fresh object. Cold paths only (config tables, tests). */
export function oklch(L: number, C: number, hDeg: number): Rgb {
  return oklchToLinearSrgb(L, C, hDeg, { r: 0, g: 0, b: 0 });
}

/** Component-wise mix of two linear-sRGB triples. Writes into `out`. */
export function mixRgb(a: Rgb, b: Rgb, t: number, out: Rgb): Rgb {
  out.r = a.r + (b.r - a.r) * t;
  out.g = a.g + (b.g - a.g) * t;
  out.b = a.b + (b.b - a.b) * t;
  return out;
}

/** Scale a linear triple, clamping to the HDR range the shaders actually use. */
export function scaleRgb(c: Rgb, k: number, out: Rgb): Rgb {
  out.r = clampFinite(c.r * k);
  out.g = clampFinite(c.g * k);
  out.b = clampFinite(c.b * k);
  return out;
}

/** Copy. Cold paths / tests. */
export function copyRgb(c: Rgb, out: Rgb): Rgb {
  out.r = c.r;
  out.g = c.g;
  out.b = c.b;
  return out;
}
