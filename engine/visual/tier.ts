/**
 * Quality tier detection. Spec §12.2.
 *
 * **Pure** — the environment arrives as an argument, so every branch is
 * unit-testable without a browser. Nothing here touches `window`, `navigator`,
 * or a WebGL context; `readEnvironment()` does that, once, at startup.
 */
import type { Tier } from "../types";
import { TIER_PARAMS } from "../config";

/** What detection is allowed to look at. All optional — absence means "unknown". */
export interface TierEnv {
  /** `matchMedia("(pointer: coarse)")` — a touch-first device. */
  coarsePointer?: boolean;
  /** viewport width in CSS pixels */
  width?: number;
  /** viewport height in CSS pixels */
  height?: number;
  /** `navigator.hardwareConcurrency` */
  cores?: number;
  /** `navigator.deviceMemory` in GB — Chromium only, absent elsewhere */
  deviceMemory?: number;
  /** `WEBGL_debug_renderer_info` UNMASKED_RENDERER_WEBGL, lower-cased by the caller */
  gpuRenderer?: string;
}

const SOFTWARE_GPU = /swiftshader|llvmpipe|software/;
/**
 * Integrated GPUs that should not get the top tier. `arc` is explicitly
 * excluded — Intel Arc is a discrete card and belongs on `high`.
 */
const INTEGRATED_GPU = /intel|uhd|iris/;

/**
 * Spec §12.2, verbatim.
 *
 * Order matters and is load-bearing:
 * 1. a software rasteriser is always `low`, whatever else is true — it is the
 *    one answer we can be certain of, and it is what CI runs under;
 * 2. then the pointer/viewport heuristic for touch devices;
 * 3. then the integrated-GPU heuristic;
 * 4. everything else is assumed capable.
 *
 * Note this can *only* move a device down. There is no branch that promotes to
 * `high` on evidence — `high` is the default for "nothing suspicious found",
 * which is the right bias for a piece that degrades gracefully but looks poor
 * on a machine that cannot keep up.
 */
export function detectTier(env: TierEnv): Tier {
  const gpu = (env.gpuRenderer ?? "").toLowerCase();

  if (SOFTWARE_GPU.test(gpu)) return "low";

  const smallestSide = Math.min(env.width ?? Infinity, env.height ?? Infinity);
  const coarse = env.coarsePointer === true || smallestSide < 600;

  const cores = env.cores ?? 4;
  const mem = env.deviceMemory ?? 4;

  if (coarse) return cores >= 8 && mem >= 6 ? "medium" : "low";
  if (INTEGRATED_GPU.test(gpu) && !/arc/.test(gpu)) return "medium";
  return "high";
}

/**
 * Spec §12.3 — the drawing-buffer pixel ratio ceiling for a tier:
 * `high → min(dpr, 2)`, `medium → min(dpr, 1.5)`, `low → 1.0`.
 *
 * Pure so the table is directly testable at several `dpr` values, which is the
 * only way to catch the reading of it changing — see the note in
 * `renderer.ts` on why this *is* the pixel ratio rather than a multiple of it.
 */
export function pixelRatioCeiling(dpr: number, tier: Tier): number {
  const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return Math.min(d, TIER_PARAMS[tier].maxRenderScale);
}

/**
 * Spec §9.11 — `matchMedia("(prefers-reduced-motion: reduce)")`.
 *
 * Read at startup and kept live, because the preference can change mid-session
 * (macOS System Settings, GNOME accessibility). Defaults to `false` where
 * `matchMedia` is unavailable, so the common path is the full-motion one.
 */
export function readReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * Watch the reduced-motion preference, calling `onChange` with each new value.
 * Returns an unsubscribe function; a no-op where `matchMedia` is unavailable.
 */
export function watchReducedMotion(onChange: (reduced: boolean) => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  let mq: MediaQueryList;
  try {
    mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  } catch {
    return () => {};
  }
  // `addEventListener` on MediaQueryList is the modern form; Safari < 14 only has
  // the deprecated `addListener`, which is checked rather than assumed absent.
  const handler = (e: MediaQueryListEvent): void => onChange(e.matches);
  if (typeof mq.addEventListener === "function") {
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }
  if (typeof mq.addListener === "function") {
    mq.addListener(handler as unknown as (e: MediaQueryListEvent) => void);
    return () => mq.removeListener(handler as unknown as (e: MediaQueryListEvent) => void);
  }
  return () => {};
}

/**
 * Read the tier environment from the browser. Called once, at startup.
 *
 * Every probe is wrapped: a browser that refuses a WebGL context, or omits
 * `deviceMemory`, must degrade to the defaults in `detectTier` rather than
 * throw during boot.
 */
export function readEnvironment(): TierEnv {
  const env: TierEnv = {};
  if (typeof window === "undefined") return env;

  env.width = window.innerWidth;
  env.height = window.innerHeight;

  try {
    env.coarsePointer =
      typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  } catch {
    /* older or privacy-restricted browser; leave undefined */
  }

  const nav = navigator as Navigator & { deviceMemory?: number };
  env.cores = nav.hardwareConcurrency;
  env.deviceMemory = nav.deviceMemory;

  env.gpuRenderer = readGpuRenderer();
  return env;
}

/**
 * `UNMASKED_RENDERER_WEBGL` is the only reliable signal for the tier, and it
 * is gated behind an extension that Firefox and Safari do not expose. Its
 * absence yields `''`, which `detectTier` reads as "unknown" — correct, since
 * the browser's own GPU is presumably adequate to render the page at all.
 */
function readGpuRenderer(): string {
  try {
    const canvas = document.createElement("canvas");
    const gl =
      (canvas.getContext("webgl2") as WebGL2RenderingContext | null) ??
      (canvas.getContext("webgl") as WebGLRenderingContext | null);
    if (!gl) return "";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const raw = ext
      ? (gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as unknown)
      : gl.getParameter(gl.RENDERER);
    return typeof raw === "string" ? raw : "";
  } catch {
    return "";
  }
}
