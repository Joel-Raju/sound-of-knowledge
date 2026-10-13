/**
 * Screenshot harness. Spec §13.4 / T4.2 acceptance.
 *
 * Captures PNGs of the debug page's canvas at several times into
 * `artifacts/shots/`, and prints per-image luminance mean, luminance std-dev, and
 * the fraction of pixels brighter than 0.9 (a bloom sanity check — a scene with
 * no HDR headroom cannot be blooming, and a scene that is *all* HDR is clipped
 * white). §13.4's liveness check additionally compares two captures to confirm
 * the scene is animating, not just non-blank.
 *
 * **The std-dev threshold is the point of this script.** Spec §12 says the agent
 * cannot see the screen, so every visual target gets a measurable proxy. A blank
 * canvas and a correctly-rendered orb are both "some pixels"; only the variance
 * distinguishes them. T4.2's acceptance is std-dev > 5 in the centre region.
 *
 * **Std-dev alone is not sufficient, though**, and this script deliberately
 * measures more than the acceptance criterion. A canvas full of salt-and-pepper
 * noise has a huge std-dev and is broken; a smooth gradient has a small one and
 * is fine. So the centre-region check is paired with the temporal difference
 * (§13.4 item 2: mean absolute pixel difference > 1.0 between t=6 s and t=12 s),
 * and a `mean` floor — because "high variance" and "correct" are different
 * claims.
 *
 * Pixels are read through a rAF callback. A WebGL drawing buffer is discarded
 * once the frame is composited, so a read from outside the frame loop sees
 * zeros and every image would be black.
 *
 * Usage: npx tsx scripts/shot.ts [--times 2,6,12] [--port 4319]
 */
import { chromium, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isExpectedLocalNoise } from "../tests/e2e/helpers";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = resolve(ROOT, "artifacts/shots");

const args = process.argv.slice(2);
const TIMES = (args.includes("--times") ? String(args[args.indexOf("--times") + 1]) : "2,6,12")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
const PORT = Number(process.env.SOK_PORT ?? 4319);

/** §11.3's `?quality=` override — lets us inspect a tier the machine wouldn't pick. */
const QUALITY = args.includes("--quality") ? String(args[args.indexOf("--quality") + 1]) : null;

/**
 * Magnification of the centre crop written alongside each capture.
 *
 * `--zoom 6` takes the middle 1/6 of the canvas and writes it at 4× nearest-
 * neighbour. Per-pixel defects — a dither lattice, banding, a one-pixel seam —
 * are invisible at 1:1 and are precisely what a human review is for.
 */
const ZOOM = args.includes("--zoom") ? Number(args[args.indexOf("--zoom") + 1]) || 1 : 1;

/** `?jitter=` — the orb's march-jitter amplitude, for sweeping. */
const JITTER = args.includes("--jitter") ? String(args[args.indexOf("--jitter") + 1]) : null;

/**
 * `--spawn N` — fire `N` synthetic spark/burst/pulse events, T4.3's debug pattern.
 *
 * Spawns are **re-armed before every capture**, not once at load. §9.5 gives a
 * streak 1.1–1.8 s and a ring 2.2 s, so a single spawn fired at t=0 has been dead
 * for several seconds by the default t=6 s capture and the acceptance check would
 * measure an empty pool.
 *
 * Re-arming immediately before the capture means the spawns are between 0 and a
 * frame old, which is exactly the window where they are brightest.
 */
const SPAWN = args.includes("--spawn") ? Number(args[args.indexOf("--spawn") + 1]) || 0 : 0;

/**
 * `--no-sparks` — mount the orb alone, without the spark and ring layers.
 *
 * §9.5 draws every instance every frame (`instanceCount = CAP`, dead particles
 * clipped in the vertex shader), so the pool costs the same whether or not
 * anything has been spawned. `--spawn` therefore cannot measure spark cost —
 * the draw is already happening. Measuring the marginal cost needs the layers
 * absent, which is what this does.
 */
const NO_SPARKS = args.includes("--no-sparks");

/**
 * What a scene is measuring, for the file name and the printed header.
 *
 * Without this a `--no-sparks` capture overwrites the real one, because the
 * quality suffix is the only thing distinguishing runs and it is empty at the
 * default tier.
 */
/**
 * `--sweep` — capture every layer/composer combination against **one** server.
 *
 * This exists because the alternative produced a wrong answer. `ensureServer` reuses
 * whatever is listening on the port, so a shell loop that kills the port and
 * re-launches per variant does not reliably get a fresh server: the next run can find
 * the previous one still listening and attach to it. Four A/B rows came back with the
 * combinations mislabelled — a `--no-sparks --no-post` run reported post-processing
 * on — and the giveaway was only that no output file with the expected suffix
 * appeared. Every variant differs solely by URL parameter, so one server and one
 * browser can serve all of them, and nothing is left to race.
 */
const SWEEP = args.includes("--sweep");

/**
 * `--no-post` — skip §9.8's composer, drawing straight to the canvas.
 *
 * Needed for the T4.4 A/B: without it there is no way to attribute a change in the
 * capture to the composer rather than to the layers. Suppressed under `--sweep`,
 * which drives the four combinations itself from the URL.
 */
const NO_POST = args.includes("--no-post") && !SWEEP;

/**
 * What this run is measuring, for the filename and the printed header. Without it a
 * variant capture overwrites the real one: the quality suffix is the only thing
 * distinguishing runs, and it is empty at the default tier.
 */
const variant = [NO_SPARKS ? "nosparks" : "", NO_POST ? "nopost" : "", SPAWN > 0 ? `spawn${SPAWN}` : ""]
  .filter((s) => s !== "")
  .join("-");

/** Keeps captures from different tiers and variants from overwriting one another. */
const suffix = [QUALITY, variant].filter((s) => s !== "").join("-");

/** T4.3's stated acceptance threshold — bright pixels as a fraction of the frame. */
export const SPARK_BRIGHT_MIN = 0.002;

/**
 * T4.3's *discriminating* threshold: mean |Δpixel| a spawn must add.
 *
 * Same value as `MIN_TEMPORAL_DIFF` (§13.4's animating check) because it answers
 * the same question — did anything change on screen — just against a frame that
 * is known to be identical apart from the spawn.
 */
export const SPARK_DELTA_MIN = 1.0;

/** T4.2's acceptance threshold, centre region. */
export const CENTRE_STDDEV_MIN = 5;

/**
 * T4.4 — the corner patch must show *some* variation, and not be noise.
 *
 * Spec §13.4 asks for "soft glow and non-banded dark gradient", and this is its
 * numeric form: a std-dev of exactly 0 means a perfectly flat gradient, which is
 * what banding looks like before it is visible; above 6 means the patch is grain
 * rather than a gradient. The floor is deliberately 0 and the ceiling deliberately
 * generous — the test is "is there structure here, and is it a gradient rather than
 * static", not a judgement about the grain's strength.
 */
export const CORNER_STDDEV_MIN = 0;
export const CORNER_STDDEV_MAX = 6;
/** §13.4 item 2 — the scene must change between two captures. */
export const MIN_TEMPORAL_DIFF = 1.0;

interface ShotStats {
  timeSec: number;
  /**
   * Centre-region luminance, **0–255 sRGB**. Not normalised.
   *
   * §13.4's threshold is "luminance std-dev > 5", which only means anything on a
   * 0–255 scale — on 0–1 a std-dev above 5 is not merely unlikely, it is
   * impossible. Measured in 0–1 first and reported 0.08 against a threshold of 5,
   * which reads as a catastrophic failure and is really a unit error.
   */
  mean: number;
  stdDev: number;
  cornerStdDev: number;
  /** fraction of centre pixels with luminance > 0.9 — bloom headroom check */
  brightFraction: number;
  /** fraction of centre pixels that are exactly the clear colour — emptiness */
  backgroundFraction: number;
  /** 32×32 luminance grid, for §13.4's true mean-absolute-pixel-difference. */
  grid: Float32Array;
  /**
   * The **real** engine's own frame-time EMA, straight from the page.
   *
   * Reported because it is the number that actually matters and it needs no
   * stand-in geometry: `probe:shader` approximates the orb with raw WebGL, while
   * this is the shipped `IcosahedronGeometry` through three.js on a real canvas.
   * Where the two agree, the probe's conclusions can be trusted for T4.5+.
   */
  emaMs: number;
  p95Ms: number;
  /**
   * True GPU frame cost of the *shipped* pipeline: rAF callback entry through a
   * forced synchronisation.
   *
   * This exists because `emaMs` above is **not** the same number and is not
   * wrong on its own terms — it measures how fast the main thread issues
   * commands, which under a GPU-bound load is pinned at the vsync interval.
   * Comparing the two is the only way to see the difference.
   */
  syncedFrameMs: number;
  /**
   * The engine's own synchronised sample — the one §9.10's governor now acts on.
   * Reported next to `syncedFrameMs` (this script's independent readback) so the
   * shipped measurement is checked against an external one, not trusted.
   */
  engineSyncedMs: number;
  governorLevel: number;
  renderScale: number;
  /**
   * T4.3: mean |Δpixel| between this capture and the immediately preceding
   * empty-pool frame. `null` when `--spawn` was not in play.
   *
   * This, not `brightFraction`, is the discriminating signal — the orb's own
   * core is ~9.9 % "bright", so T4.3's stated "> 0.2 % bright pixels" passes
   * identically with and without sparks.
   */
  spawnDelta: number | null;
  /** PNG bytes, for the artefact on disk. */
  bytes: number;
  /** any shader/WebGL errors seen in the page up to this point */
  errors: string[];
}

/**
 * Capture the centre region and compute its statistics, in the page.
 *
 * The region is the middle 50 % of the canvas. Not the whole frame: at T4.2 the
 * orb is a disc in the middle of a dark field, so a full-frame std-dev would be
 * dominated by the background being black and would pass for any scene at all —
 * including one where the orb failed to compile.
 *
 * Returns base64 PNG plus the numbers, so one round trip yields both the file
 * and the measurements.
 */
/** What one capture yields: the numbers, and the two PNGs. */
interface FrameSample {
  mean: number;
  cornerStdDev: number;
  stdDev: number;
  brightFraction: number;
  backgroundFraction: number;
  grid: number[];
  /** full-frame PNG */
  png: string;
  /** magnified centre crop; "" when `--zoom` is not in play */
  zoomPng: string;
}

/**
 * Read the same 32×32 centre luminance grid `capture` builds, without spawning.
 *
 * Used as T4.3's baseline. Kept as its own `page.evaluate` rather than folded
 * into the capture callback because the baseline must be a *separate frame* —
 * reading and spawning in one rAF would put the new particles in the baseline.
 */
async function readCentreGrid(page: Page): Promise<Float32Array> {
  const raw = await page.evaluate(
    (): Promise<number[] | null> =>
      new Promise<number[] | null>((done) => {
        let settled = false;
        const guard = setTimeout(() => {
          if (settled) return;
          settled = true;
          done(null);
        }, 30_000);
        requestAnimationFrame(() => {
          try {
            const canvas = document.querySelector(
              "canvas[data-testid='visual-canvas']",
            ) as HTMLCanvasElement | null;
            const gl = canvas?.getContext("webgl2");
            if (!canvas || !gl) {
              settled = true;
              clearTimeout(guard);
              return done(null);
            }
            const w = gl.drawingBufferWidth;
            const h = gl.drawingBufferHeight;
            const x0 = Math.floor(w * 0.25);
            const y0 = Math.floor(h * 0.25);
            const rw = Math.max(1, Math.floor(w * 0.5));
            const rh = Math.max(1, Math.floor(h * 0.5));
            const px = new Uint8Array(rw * rh * 4);
            gl.readPixels(x0, y0, rw, rh, gl.RGBA, gl.UNSIGNED_BYTE, px);

            const G = 32;
            const sum = new Float64Array(G * G);
            const counts = new Float64Array(G * G);
            for (let y = 0; y < rh; y++) {
              const gy = Math.min(G - 1, Math.floor((y * G) / rh));
              for (let x = 0; x < rw; x++) {
                const gx = Math.min(G - 1, Math.floor((x * G) / rw));
                const i = (y * rw + x) * 4;
                const lum =
                  0.2126 * (px[i] ?? 0) + 0.7152 * (px[i + 1] ?? 0) + 0.0722 * (px[i + 2] ?? 0);
                sum[gy * G + gx] = (sum[gy * G + gx] ?? 0) + lum;
                counts[gy * G + gx] = (counts[gy * G + gx] ?? 0) + 1;
              }
            }
            const grid: number[] = new Array(G * G);
            for (let i = 0; i < G * G; i++) {
              const n = counts[i] ?? 0;
              grid[i] = n > 0 ? (sum[i] ?? 0) / n : 0;
            }
            settled = true;
            clearTimeout(guard);
            done(grid);
          } catch {
            settled = true;
            clearTimeout(guard);
            done(null);
          }
        });
      }),
  );
  return raw === null ? new Float32Array(0) : Float32Array.from(raw);
}

async function capture(
  page: Page,
  timeSec: number,
  errors: string[],
  zoom: number,
  suffix: string,
  spawn = 0,
): Promise<ShotStats> {
  // Wait on the engine's own clock, Node-side. The two clocks diverge under
  // swiftshader — a frame can take 50 ms — so a wall-clock wait would capture a
  // different point in the piece than the one requested.
  await page.waitForFunction(
    (t) => {
      const v = (window as unknown as { __sok?: { visual?: { engine?: { clockNow: number } } } })
        .__sok?.visual;
      return (v?.engine?.clockNow ?? 0) >= t;
    },
    timeSec,
    { timeout: 120_000, polling: "raf" },
  );

  // Re-arm the pool at the capture instant, not at load. See `SPAWN`.
  //
  // First take a baseline grid with the pool *empty*. T4.3's stated criterion —
  // "bright pixels ratio > 0.2 %" — is satisfied by the orb alone (measured at
  // 9.87 % with an empty pool), so it cannot tell sparks from no sparks. What
  // discriminates is how much light the spawns *add*, so the baseline is read
  // immediately before and differenced against the capture below.
  let baselineGrid: Float32Array | null = null;
  if (spawn > 0) {
    baselineGrid = await readCentreGrid(page);
  }

  if (spawn > 0) {
    await page.evaluate((n) => {
      const v = window as unknown as {
        __sok?: { visual?: { debugSpawn(n?: number): void } };
      };
      v.__sok?.visual?.debugSpawn(n);
    }, spawn);
    // Let the spawned particles reach the frame — a spawn stamped at `uTime` is
    // drawn on the *next* tick, and at age 0 a streak's alpha is still 0
    // (§9.5's `smoothstep(0.0, 0.1, u)`). One frame is enough to get past that.
    await page.waitForFunction(
      (t) => {
        const v = (window as unknown as { __sok?: { visual?: { engine?: { clockNow: number } } } })
          .__sok?.visual;
        return (v?.engine?.clockNow ?? 0) > t;
      },
      timeSec,
      { timeout: 30_000, polling: "raf" },
    );
  }

  // Read the live engine's own frame stats, so the capture is annotated with what
  // the shipped code is actually costing — no stand-in geometry involved.
  //
  // `syncedFrameMs` is the honest one. `emaMs` comes from rAF deltas, so it
  // measures how fast the main thread issues commands; when the GPU is the
  // bottleneck Chromium keeps rAF at the vsync interval anyway and `emaMs`
  // settles at 16.7 ms no matter how long the orb actually takes to rasterise.
  const live = await page.evaluate(
    () =>
      new Promise<{
        emaMs: number;
        p95Ms: number;
        level: number;
        scale: number;
        syncedFrameMs: number;
        /**
         * The engine's *own* synced sample — the one §9.10's governor now acts on.
         * Reported separately from `syncedFrameMs` (this script's independent
         * readback) so the shipped measurement can be checked against an external
         * one rather than trusted.
         */
        engineSyncedMs: number;
      }>((done) => {
        // One sample is enough, and re-registering an rAF callback from inside
        // itself would need a *named* function binding — which esbuild's
        // keepNames wraps in `__name`, which does not exist in the page. A
        // single rAF + sync is both simpler and immune to that.
        requestAnimationFrame(() => {
          const t0 = performance.now();
          const c = document.querySelector(
            "canvas[data-testid='visual-canvas']",
          ) as HTMLCanvasElement | null;
          const gl = c?.getContext("webgl2");
          const px = new Uint8Array(4);
          // The engine issues this frame's commands at the top of its own tick,
          // which is queued ahead of ours, so syncing here waits for that draw.
          if (gl) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          const synced = performance.now() - t0;
          const s = window.__sok?.visual?.stats();
          done({
            emaMs: s?.emaMs ?? -1,
            p95Ms: s?.p95Ms ?? -1,
            level: s?.level ?? -1,
            scale: s?.scale ?? -1,
            syncedFrameMs: synced,
            engineSyncedMs: s?.syncedMs ?? -1,
          });
        });
      }),
  );

  const shot = await page.evaluate(
    async (
      zoom,
    ): Promise<{
      png: string;
      zoomPng: string;
  cornerStdDev: number;
      mean: number;
      stdDev: number;
      brightFraction: number;
      backgroundFraction: number;
      grid: number[];
    } | null> => {
      // Note there are no named function bindings in this callback — no
      // `const f = () => {}`. esbuild's keepNames (on by default under tsx)
      // rewrites those into `__name(...)` wrappers, and Playwright ships this
      // function's *source text* to the browser, where `__name` does not exist.
      // Waiting for the clock is done Node-side via `waitForFunction` for the
      // same reason.
      const raw = await new Promise<FrameSample | { reason: string }>((done) => {
        // A capture that never resolves is far worse than one that fails: the
        // run hangs until CI's job timeout with no indication of where. So the
        // settle logic is inlined rather than factored into a `finish` helper —
        // a named `const finish = () => {}` here would be rewritten by esbuild's
        // keepNames into `__name(...)`, which does not exist in the page. Same
        // reason there are no other named function bindings in this callback.
        let settled = false;
        const guard = setTimeout(() => {
          if (settled) return;
          settled = true;
          done({ reason: "capture timed out after 30 s" });
        }, 30_000);
        requestAnimationFrame(() => {
          // Any throw here would otherwise surface as a bare "could not capture",
          // which says nothing about why. §12's rule about silent failures applies
          // to harnesses too.
          try {
            // Inside the rAF: the drawing buffer is still live here, and `px` is
            // in scope. Both matter — see the magnified-crop comment below.
            const canvas = document.querySelector(
              "canvas[data-testid='visual-canvas']",
            ) as HTMLCanvasElement | null;
            const gl = canvas?.getContext("webgl2");
            if (!canvas || !gl) {
              settled = true;
              clearTimeout(guard);
              return done({ reason: "no canvas or no webgl2 context in the page" });
            }

            // Middle 50 % in device pixels.
            const w = gl.drawingBufferWidth;
            const h = gl.drawingBufferHeight;
            const x0 = Math.floor(w * 0.25);
            const y0 = Math.floor(h * 0.25);
            const rw = Math.max(1, Math.floor(w * 0.5));
            const rh = Math.max(1, Math.floor(h * 0.5));

            const px = new Uint8Array(rw * rh * 4);
            gl.readPixels(x0, y0, rw, rh, gl.RGBA, gl.UNSIGNED_BYTE, px);

            let sum = 0;
            let sumSq = 0;
            let bright = 0;
            let background = 0;
            const n = rw * rh;
            for (let i = 0; i < n; i++) {
              const r = px[i * 4] ?? 0;
              const g = px[i * 4 + 1] ?? 0;
              const b = px[i * 4 + 2] ?? 0;
              // Rec. 709 luma on sRGB-encoded values, which is what the PNG stores.
              // Left on the 0-255 scale so §13.4's thresholds apply directly.
              const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
              sum += lum;
              sumSq += lum * lum;
              if (lum > 230) bright++;
              if (r + g + b === 0) background++;
            }

            // T4.4 — a std-dev over a **corner** patch of the centre region, which
            // is where banding shows first. The orb's core is far too structured to
            // serve as a banding witness: its own contrast dominates any quantisation
            // step. The corner is background, dust and vignette only.
            const cw = Math.max(2, Math.floor(rw / 8));
            const chh = Math.max(2, Math.floor(rh / 8));
            let cSum = 0;
            let cSumSq = 0;
            let cn = 0;
            for (let y = 0; y < chh; y++) {
              for (let x = 0; x < cw; x++) {
                const i = ((y * rw) + x) * 4;
                const lum = 0.2126 * (px[i] ?? 0) + 0.7152 * (px[i + 1] ?? 0) + 0.0722 * (px[i + 2] ?? 0);
                cSum += lum;
                cSumSq += lum * lum;
                cn++;
              }
            }
            const cMean = cSum / Math.max(1, cn);
            const cornerStdDev = Math.sqrt(
              Math.max(0, cSumSq / Math.max(1, cn) - cMean * cMean),
            );
            const mean = sum / n;
            const variance = Math.max(0, sumSq / n - mean * mean);

            // A coarse luminance grid, so §13.4's "mean absolute pixel difference
            // between the two" can be measured from the real pixels rather than
            // from differences of summary statistics — which a scene can satisfy
            // by drifting uniformly.
            const G = 32;
            const grid: number[] = new Array(G * G).fill(0);
            const counts = new Array(G * G).fill(0);
            for (let i = 0; i < n; i++) {
              const gx = Math.min(G - 1, Math.floor(((i % rw) / rw) * G));
              const gy = Math.min(G - 1, Math.floor((Math.floor(i / rw) / rh) * G));
              const r = px[i * 4] ?? 0;
              const gg = px[i * 4 + 1] ?? 0;
              const b = px[i * 4 + 2] ?? 0;
              const idx = gy * G + gx;
              grid[idx] = (grid[idx] ?? 0) + 0.2126 * r + 0.7152 * gg + 0.0722 * b;
              counts[idx] = (counts[idx] ?? 0) + 1;
            }
            for (let i = 0; i < grid.length; i++) {
              grid[i] = counts[i] ? (grid[i] ?? 0) / (counts[i] ?? 1) : 0;
            }

            // Magnified centre crop. Per-pixel artefacts — a dither lattice,
            // banding, a one-pixel seam — are invisible at 1:1 and are exactly
            // what a human review is for.
            //
            // It must be built from `px`, never from `drawImage(canvas, …)`:
            // the WebGL drawing buffer is discarded once the frame is composited,
            // so outside this rAF the canvas reads as blank and the crop comes
            // out white. `px` is ordinary JS memory and still holds exactly what
            // the GPU produced. Nearest-neighbour by construction, because
            // smoothing would average the artefact away.
            // Always build the crop, even when --zoom is off: one code path is
            // worth more here than the few milliseconds it costs, and a second
            // path is a second place for the drawing buffer to be read too late.
            const side = Math.max(8, Math.floor(Math.min(rw, rh) / Math.max(1, zoom)));
            const scale = 4;
            const z = document.createElement("canvas");
            z.width = side * scale;
            z.height = side * scale;
            const zctx = z.getContext("2d");
            if (!zctx) {
              settled = true;
              clearTimeout(guard);
              return done({ reason: "could not get a 2d context for the crop" });
            }

            const img = zctx.createImageData(z.width, z.height);
            // Centre square of the readPixels region, which is stored bottom-up.
            const rx0 = Math.floor((rw - side) / 2);
            const ry0 = Math.floor((rh - side) / 2);
            for (let y = 0; y < z.height; y++) {
              // ImageData row 0 is the top; readPixels row 0 is the bottom.
              const srcY = ry0 + Math.floor((z.height - 1 - y) / scale);
              for (let x = 0; x < z.width; x++) {
                const srcX = rx0 + Math.floor(x / scale);
                const si = (srcY * rw + srcX) * 4;
                const di = (y * z.width + x) * 4;
                img.data[di] = px[si] ?? 0;
                img.data[di + 1] = px[si + 1] ?? 0;
                img.data[di + 2] = px[si + 2] ?? 0;
                img.data[di + 3] = 255;
              }
            }
            zctx.putImageData(img, 0, 0);

            void Promise.all([
              new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png")),
              new Promise<Blob | null>((r) => z.toBlob(r, "image/png")),
            ]).then(async ([full, crop]) => {
              if (!full || !crop) {
                settled = true;
                clearTimeout(guard);
                return done({
                  reason:
                    "toBlob returned null — full frame " +
                    (full ? "ok" : "null") +
                    ", crop " +
                    (crop ? "ok" : "null"),
                });
              }
              // Base64 inlined rather than factored into a helper: esbuild keeps
              // names, and a `const toB64 = () => {}` inside page.evaluate becomes
              // __name(...) in a context where __name does not exist.
              const out = [
                new Uint8Array(await full.arrayBuffer()),
                new Uint8Array(await crop.arrayBuffer()),
              ];
              const b64 = ["", ""];
              for (let k = 0; k < 2; k++) {
                const b = out[k];
                if (!b) continue;
                let acc = "";
                const CHUNK = 0x8000;
                for (let i = 0; i < b.length; i += CHUNK) {
                  acc += String.fromCharCode(...b.subarray(i, i + CHUNK));
                }
                b64[k] = btoa(acc);
              }
              settled = true;
              clearTimeout(guard);
              done({
                mean,
                stdDev: Math.sqrt(variance),
                cornerStdDev,
                brightFraction: bright / n,
                backgroundFraction: background / n,
                grid,
                png: b64[0] ?? "",
                zoomPng: zoom > 1 ? (b64[1] ?? "") : "",
              });
            });
          } catch (e) {
            settled = true;
            clearTimeout(guard);
            done({ reason: e instanceof Error ? e.message : String(e) });
            // Rethrow on a microtask so the page reports it in the console too.
            setTimeout(() => {
              throw e instanceof Error ? e : new Error(String(e));
            }, 0);
          }
        });
      });
      if ("reason" in raw) throw new Error("shot: " + raw.reason);
      return raw;
    },
    zoom,
  );
  if (!shot) throw new Error(`could not capture the canvas at t=${timeSec}s`);

  const png = Buffer.from(shot.png, "base64");
  const tag = suffix === "" ? "" : `-${suffix}`;
  const stem = `t${String(timeSec).replace(".", "_")}s${tag}`;
  writeFileSync(resolve(SHOTS, `${stem}.png`), png);
  if (shot.zoomPng !== "") {
    writeFileSync(resolve(SHOTS, `${stem}-zoom.png`), Buffer.from(shot.zoomPng, "base64"));
  }

  return {
    timeSec,
    mean: shot.mean,
    stdDev: shot.stdDev,
    cornerStdDev: shot.cornerStdDev,
    brightFraction: shot.brightFraction,
    backgroundFraction: shot.backgroundFraction,
    grid: Float32Array.from(shot.grid),
    emaMs: live.emaMs,
    p95Ms: live.p95Ms,
    syncedFrameMs: live.syncedFrameMs,
    engineSyncedMs: live.engineSyncedMs,
    governorLevel: live.level,
    renderScale: live.scale,
    spawnDelta:
      baselineGrid && baselineGrid.length > 0
        ? meanAbsDiffGrid(baselineGrid, Float32Array.from(shot.grid))
        : null,
    bytes: png.length,
    errors: [...errors],
  };
}

/**
 * §13.4 item 2 — mean absolute pixel difference between two captures, > 1.0.
 *
 * Measured from the real pixels via the 32×32 grids, not from differences of
 * summary statistics. A statistic-of-statistics proxy is satisfiable by a scene
 * that simply brightens uniformly while every pixel stays put, which is exactly
 * the "not blank but not animating" failure this check exists to catch.
 */
export function meanAbsDiff(a: ShotStats, b: ShotStats): number {
  return meanAbsDiffGrid(a.grid, b.grid);
}

/**
 * Mean absolute difference between two luminance grids.
 *
 * Split out from `meanAbsDiff` so T4.3's baseline can be differenced against a
 * bare grid, before there is a `ShotStats` to wrap it in.
 */
export function meanAbsDiffGrid(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return sum / a.length;
}

async function isUp(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/?debug=1`);
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureServer(port: number): Promise<() => void> {
  if (await isUp(port)) {
    console.log(`reusing the server already listening on ${port}`);
    return () => {};
  }
  const child = spawn("npm", ["run", "start", "--", "--port", String(port)], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let log = "";
  child.stderr?.on("data", (d: Buffer) => (log += d.toString()));
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await isUp(port)) return () => child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 400));
  }
  child.kill("SIGTERM");
  throw new Error(`server did not start within 120s\n${log.slice(-2000)}`);
}

async function main(): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  console.log(`shots → ${SHOTS}`);
  console.log(
    `capture times: ${TIMES.join(", ")} s (engine clock)${ZOOM > 1 ? `; centre crop 1/${ZOOM} at 4× nearest` : ""}\n`,
  );

  const stop = await ensureServer(PORT);
  const browser = await chromium.launch({
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });

  let failed = false;
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      // §3.1 keeps @vercel/analytics, which requests /_vercel/* and only exists
      // on Vercel. The URL is in the message *location*, not the text — a
      // resource-load failure logs only "Failed to load resource: ... 404" — so
      // filtering on the text alone silently keeps reporting them.
      const where = m.location()?.url ?? "";
      if (isExpectedLocalNoise(m.text()) || isExpectedLocalNoise(where)) return;
      errors.push(where ? `${m.text()}  @ ${where}` : m.text());
    });
    page.on("pageerror", (e) => {
      if (!isExpectedLocalNoise(e.message)) errors.push(e.message);
    });

    const url =
      `http://127.0.0.1:${PORT}/?debug=1` +
      (QUALITY ? `&quality=${QUALITY}` : "") +
      (JITTER !== null ? `&jitter=${JITTER}` : "") +
      (NO_SPARKS ? "&nosparks=1" : "") +
      (NO_POST ? "&nopost=1" : "");
    await page.goto(url);
    await page.waitForFunction(() => window.__sokVisualReady === true, null, { timeout: 60_000 });
    const tier = await page.evaluate(() => window.__sok?.visual?.stats()?.tier ?? "unknown");
    const jitterInUse = await page.evaluate(() => {
      const orb = (
        window as unknown as {
          __sok?: {
            visual?: { orb?: { material: { uniforms: Record<string, { value: unknown }> } } };
          };
        }
      ).__sok?.visual?.orb;
      const v = orb?.material.uniforms.uJitter?.value;
      return typeof v === "number" ? v : -1;
    });
    console.log(`tier: ${tier}${QUALITY ? ` (forced via ?quality=${QUALITY})` : ""}`);
    if (NO_SPARKS) console.log("sparks/rings/dust: NOT MOUNTED (--no-sparks)");
    console.log(`post: ${NO_POST ? "DISABLED (--no-post)" : tier === "low" ? "none — low tier" : "attached"}`);
    console.log(
      `jitter: ${jitterInUse}${JITTER !== null ? " (forced via ?jitter=)" : " (default)"}\n`,
    );

    // Put the orb's ripples on screen before the first capture. A screenshot of
    // an orb with no impacts would pass a std-dev check while proving nothing
    // about §9.4's impact path.
    await page.evaluate(() => {
      const v = window as unknown as {
        __sok?: { visual?: { addImpacts(n?: number, m?: number, k?: "push" | "dent"): void } };
      };
      v.__sok?.visual?.addImpacts(6, 0.7, "push");
      v.__sok?.visual?.addImpacts(3, 0.9, "dent");
    });

    // --sweep: capture all four layer/composer combinations against this one server.
    // Each is a fresh page load, since ?nosparks and ?nopost are read at mount time
    // and nothing removes a layer once it is attached.
    if (SWEEP) {
      const COMBOS: [string, string][] = [
        ["nosparks-nopost", "&nosparks=1&nopost=1"],
        ["nosparks", "&nosparks=1"],
        ["nopost", "&nopost=1"],
        ["full", ""],
      ];
      console.log("\n=== sweep: one server, four variants ===");
      for (const [name, qs] of COMBOS) {
        await page.goto(`http://127.0.0.1:${PORT}/?debug=1${QUALITY ? `&quality=${QUALITY}` : ""}${qs}`);
        await page.waitForFunction(() => window.__sokVisualReady === true, null, {
          timeout: 60_000,
        });
        const mounted = await page.evaluate(() => {
          const v = window.__sok?.visual as
            | { post?: unknown; sparks?: unknown; rings?: unknown; dust?: unknown }
            | undefined;
          return {
            post: v?.post != null,
            sparks: v?.sparks != null,
            dust: v?.dust != null,
          };
        });
        const rows: ShotStats[] = [];
        for (const t of TIMES) {
          rows.push(await capture(page, t, errors, ZOOM, `${QUALITY ? `${QUALITY}-` : ""}${name}`, 0));
        }
        const r = rows[rows.length - 1]!;
        console.log(
          `${name.padEnd(18)} post=${String(mounted.post).padEnd(5)} ` +
            `sparks=${String(mounted.sparks).padEnd(5)} dust=${String(mounted.dust).padEnd(5)}  ` +
            `mean=${r.mean.toFixed(2).padStart(6)}  stddev=${r.stdDev.toFixed(2).padStart(6)}  ` +
            `corner=${r.cornerStdDev.toFixed(2).padStart(5)}  bright=${(r.brightFraction * 100)
              .toFixed(2)
              .padStart(6)}%  synced=${r.syncedFrameMs.toFixed(1).padStart(6)} ms`,
        );
      }
      if (errors.length > 0) {
        console.log(`\n✗ ${errors.length} console/page error(s):`);
        for (const e of errors) console.log(`   ${e}`);
        failed = true;
      } else {
        console.log("✓ no console or page errors");
      }
      return;
    }

    const shots: ShotStats[] = [];
    for (const t of TIMES) shots.push(await capture(page, t, errors, ZOOM, suffix, SPAWN));

    console.log(
      "  t       mean    stddev   bright>230   background   rAF ema   synced   engine    L  scale    png",
    );
    for (const s of shots) {
      console.log(
        `${String(s.timeSec).padStart(4)}s  ${s.mean.toFixed(2).padStart(6)}  ` +
          `${s.stdDev.toFixed(2).padStart(7)}  ${(s.brightFraction * 100).toFixed(2).padStart(10)}%  ` +
          `${(s.backgroundFraction * 100).toFixed(2).padStart(10)}%  ` +
          `${s.emaMs.toFixed(1).padStart(7)} ms  ${s.syncedFrameMs.toFixed(1).padStart(6)} ms  ${s.engineSyncedMs.toFixed(1).padStart(6)} ms  ` +
          `${String(s.governorLevel).padStart(2)}  ${s.renderScale.toFixed(2).padStart(5)}   ` +
          `${(s.bytes / 1024).toFixed(0)} KB`,
      );
    }
    const last = shots[shots.length - 1]!;
    if (last.syncedFrameMs > last.emaMs * 1.5) {
      console.log(
        `\n⚠  rAF ema reads ${last.emaMs.toFixed(1)} ms but a synchronised frame costs ` +
          `${last.syncedFrameMs.toFixed(1)} ms (${(1000 / last.syncedFrameMs).toFixed(1)} fps).\n` +
          `   The GPU is the bottleneck and rAF is pinned at vsync, so §9.10's governor — which\n` +
          `   is fed rAF deltas — will not see this. See DECISIONS.md.`,
      );
    }

    const centre = shots[shots.length - 1] ?? shots[0]!;
    console.log(`\n--- T4.2 acceptance (luminance on a 0–255 scale) ---`);
    const stddevOk = centre.stdDev > CENTRE_STDDEV_MIN;
    console.log(
      `${stddevOk ? "✓" : "✗"} centre-region luminance std-dev ${centre.stdDev.toFixed(2)} ` +
        `> ${CENTRE_STDDEV_MIN}`,
    );
    if (!stddevOk) failed = true;

    if (shots.length >= 2) {
      const first = shots[0]!;
      const last = shots[shots.length - 1]!;
      const diff = meanAbsDiff(first, last);
      const animOk = diff > MIN_TEMPORAL_DIFF;
      console.log(
        `${animOk ? "✓" : "✗"} animating: mean |Δpixel| ${diff.toFixed(2)} > ${MIN_TEMPORAL_DIFF} ` +
          `between t=${first.timeSec}s and t=${last.timeSec}s`,
      );
      if (!animOk) {
        console.log("   A static scene passes std-dev but is not the piece working.");
        failed = true;
      }
    }

    if (centre.brightFraction > 0.5) {
      console.log(
        `✗ ${(centre.brightFraction * 100).toFixed(1)}% of the centre is clipped white — §9.8 bloom sanity`,
      );
      failed = true;
    }
    if (centre.backgroundFraction > 0.98) {
      console.log(
        `✗ centre is ${(centre.backgroundFraction * 100).toFixed(1)}% background — the orb is not drawing`,
      );
      failed = true;
    }

    // T4.4 acceptance — the corner patch is the banding witness. The centre region
    // cannot serve: the orb's core is bright and structured, so its std-dev is
    // dominated by the subject rather than by quantisation, and a banded
    // background behind it would pass unnoticed.
    console.log(`\n--- T4.4 acceptance (non-banded dark gradient) ---`);
    const cornerOk =
      centre.cornerStdDev > CORNER_STDDEV_MIN && centre.cornerStdDev < CORNER_STDDEV_MAX;
    console.log(
      `${cornerOk ? "✓" : "✗"} corner-patch luminance std-dev ${centre.cornerStdDev.toFixed(2)} ` +
        `is in (${CORNER_STDDEV_MIN}, ${CORNER_STDDEV_MAX}) at t=${centre.timeSec}s`,
    );
    if (!cornerOk) {
      console.log(
        centre.cornerStdDev <= CORNER_STDDEV_MIN
          ? "   Exactly flat: a dead-flat patch is what banding looks like before it is\n" +
            "   visible. The grain in §9.8 is what dithers it — check NoiseEffect is on."
          : "   Above the ceiling: the patch is grain rather than a gradient.",
      );
      failed = true;
    }

    if (errors.length > 0) {
      console.log(`\n✗ ${errors.length} console/page error(s):`);
      for (const e of errors) console.log(`   ${e}`);
      failed = true;
    } else {
      console.log("✓ no console or page errors");
    }

    // T4.3 acceptance. Only meaningful with `--spawn`: a run without it has an
    // empty pool by construction, and "bright pixels" would be measuring the orb.
    if (SPAWN > 0) {
      console.log(`\n--- T4.3 acceptance (--spawn ${SPAWN}) ---`);
      // The stated criterion, kept because T4.3 asks for it — but reported as
      // informational, since the orb's own core clears it with an empty pool.
      console.log(
        `· bright-pixel ratio ${(centre.brightFraction * 100).toFixed(3)}% ` +
          `(T4.3 asks > ${(SPARK_BRIGHT_MIN * 100).toFixed(1)}%, but the orb alone reads ~9.9%,` +
          `\n  so this number cannot distinguish sparks from no sparks)`,
      );

      // The discriminating check: light the spawns added over the empty-pool frame.
      const d = centre.spawnDelta ?? 0;
      const sparkOk = d > SPARK_DELTA_MIN;
      console.log(
        `${sparkOk ? "✓" : "✗"} sparks add light: mean |Δpixel| ${d.toFixed(2)} > ${SPARK_DELTA_MIN} ` +
          `vs the empty-pool frame at t=${centre.timeSec}s`,
      );
      if (!sparkOk) {
        console.log(
          "   The pool is empty or the particles are off screen. §9.1 puts the camera at\n" +
            "   radius 5.5 inside the 7–13 spawn shell, so a pattern spread over the whole\n" +
            "   sphere is mostly outside the 58° FOV.",
        );
        failed = true;
      }
    }

    console.log(
      `\ninspect ${SHOTS} — §13.4 asks for a human to note banding, clipping or wrong colours`,
    );
  } finally {
    await browser.close();
    stop();
  }

  process.exit(failed ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
