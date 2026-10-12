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

/** T4.2's acceptance threshold, centre region. */
export const CENTRE_STDDEV_MIN = 5;
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
  governorLevel: number;
  renderScale: number;
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
async function capture(page: Page, timeSec: number, errors: string[]): Promise<ShotStats> {
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
          });
        });
      }),
  );

  const shot = await page.evaluate(
    async (): Promise<{
      png: string;
      mean: number;
      stdDev: number;
      brightFraction: number;
      backgroundFraction: number;
      grid: number[];
    } | null> => {
      // Read inside a rAF so the drawing buffer has not been composited away.
      //
      // Note there are no named function bindings in this callback — no
      // `const f = () => {}`. esbuild's keepNames (on by default under tsx)
      // rewrites those into `__name(...)` wrappers, and Playwright ships this
      // function's *source text* to the browser, where `__name` does not exist.
      // Waiting for the clock is done Node-side via `waitForFunction` for the
      // same reason.
      const stats = await new Promise<{
        mean: number;
        stdDev: number;
        brightFraction: number;
        backgroundFraction: number;
        grid: number[];
      } | null>((done) => {
        requestAnimationFrame(() => {
          const c = document.querySelector(
            "canvas[data-testid='visual-canvas']",
          ) as HTMLCanvasElement | null;
          const gl = c?.getContext("webgl2");
          if (!c || !gl) return done(null);

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
          for (let i = 0; i < grid.length; i++)
            grid[i] = counts[i] ? (grid[i] ?? 0) / (counts[i] ?? 1) : 0;

          done({
            mean,
            stdDev: Math.sqrt(variance),
            brightFraction: bright / n,
            backgroundFraction: background / n,
            grid,
          });
        });
      });
      if (!stats) return null;

      const canvas = document.querySelector(
        "canvas[data-testid='visual-canvas']",
      ) as HTMLCanvasElement | null;
      if (!canvas) return null;
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
      if (!blob) return null;
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < buf.length; i += CHUNK) {
        bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
      }
      return { ...stats, png: btoa(bin) };
    },
  );

  if (!shot) throw new Error(`could not capture the canvas at t=${timeSec}s`);

  const png = Buffer.from(shot.png, "base64");
  const name = `t${String(timeSec).replace(".", "_")}s.png`;
  writeFileSync(resolve(SHOTS, name), png);

  return {
    timeSec,
    mean: shot.mean,
    stdDev: shot.stdDev,
    brightFraction: shot.brightFraction,
    backgroundFraction: shot.backgroundFraction,
    grid: Float32Array.from(shot.grid),
    emaMs: live.emaMs,
    p95Ms: live.p95Ms,
    syncedFrameMs: live.syncedFrameMs,
    governorLevel: live.level,
    renderScale: live.scale,
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
  if (a.grid.length !== b.grid.length || a.grid.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < a.grid.length; i++) sum += Math.abs(a.grid[i]! - b.grid[i]!);
  return sum / a.grid.length;
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
  console.log(`capture times: ${TIMES.join(", ")} s (engine clock)\n`);

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

    const url = `http://127.0.0.1:${PORT}/?debug=1${QUALITY ? `&quality=${QUALITY}` : ""}`;
    await page.goto(url);
    await page.waitForFunction(() => window.__sokVisualReady === true, null, { timeout: 60_000 });

    const tier = await page.evaluate(() => window.__sok?.visual?.stats()?.tier ?? "unknown");
    console.log(`tier: ${tier}${QUALITY ? ` (forced via ?quality=${QUALITY})` : ""}\n`);

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

    const shots: ShotStats[] = [];
    for (const t of TIMES) shots.push(await capture(page, t, errors));

    console.log(
      "  t       mean    stddev   bright>230   background   rAF ema   synced    L  scale    png",
    );
    for (const s of shots) {
      console.log(
        `${String(s.timeSec).padStart(4)}s  ${s.mean.toFixed(2).padStart(6)}  ` +
          `${s.stdDev.toFixed(2).padStart(7)}  ${(s.brightFraction * 100).toFixed(2).padStart(10)}%  ` +
          `${(s.backgroundFraction * 100).toFixed(2).padStart(10)}%  ` +
          `${s.emaMs.toFixed(1).padStart(7)} ms  ${s.syncedFrameMs.toFixed(1).padStart(6)} ms  ` +
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

    if (errors.length > 0) {
      console.log(`\n✗ ${errors.length} console/page error(s):`);
      for (const e of errors) console.log(`   ${e}`);
      failed = true;
    } else {
      console.log("✓ no console or page errors");
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
