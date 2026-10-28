import { expect, test } from "@playwright/test";
import { recordErrors } from "./helpers";

/**
 * Cross-browser smoke. Spec §13.4 / checklist F1–F3.
 *
 * **Every test here is tagged `@crossbrowser`.** The `firefox-smoke` and
 * `webkit-smoke` projects in `playwright.config.ts` `grep` for that tag — and
 * until this file existed they matched **zero** tests, so both projects were
 * silent no-ops that CI reported as green. That is the same failure as a shader
 * that renders nothing and times beautifully: a green result produced by a
 * process that did no work.
 *
 * A smoke test's job is to catch "this browser is completely broken", not to
 * assert parity. So each one asks a question whose answer must be yes on any
 * engine, and none of them assert something that legitimately varies — which is
 * why the `outputLatency` test below asserts the *fallback* rather than the
 * field's presence.
 */

test.describe("cross-browser smoke", () => {
  test("boots, gets a WebGL2 context, and rasterises something @crossbrowser", async ({ page }) => {
    const errors = recordErrors(page);
    await page.goto("/?debug=1");
    await page.waitForFunction(() => window.__sokVisualReady === true, null, { timeout: 60_000 });

    const probe = await page.evaluate(
      () =>
        new Promise<Record<string, number | boolean | string> | null>((resolve) => {
          // Inside a rAF: the drawing buffer is discarded once the frame is
          // composited, and a read from outside the loop sees black on every
          // engine. See scripts/shot.ts for the longer version of this.
          requestAnimationFrame(() => {
            const c = document.querySelector(
              "canvas[data-testid='visual-canvas']",
            ) as HTMLCanvasElement | null;
            const gl = c?.getContext("webgl2");
            if (!c || !gl) return resolve(null);
            // Read the **centre**, not a corner. This used to read (2,2) — the
            // background — and asserted its luma was above zero, which worked only
            // while `deep` was bright enough to be distinguishable from black. C6
            // moved the background to L = 0.04, where it legitimately rounds to
            // (0,0,1) or (0,0,0) depending on the engine's dithering, and the
            // check then failed on perfectly correct renders.
            //
            // The question is "did anything get drawn", and the orb is the thing
            // that gets drawn. The background is a colour, not evidence.
            const px = new Uint8Array(4);
            const w = c.width;
            const h = c.height;
            gl.readPixels(Math.floor(w / 2), Math.floor(h / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
            resolve({
              hasWebGL2: true,
              luma: 0.2126 * (px[0] ?? 0) + 0.7152 * (px[1] ?? 0) + 0.0722 * (px[2] ?? 0),
              renderer: String(gl.getParameter(gl.RENDERER)).slice(0, 80),
              version: String(gl.getParameter(gl.VERSION)).slice(0, 80),
            });
          });
        }),
    );

    expect(probe, "no WebGL2 context or canvas on this engine").not.toBeNull();
    if (!probe) return;
    expect(probe.hasWebGL2).toBe(true);

    // Not "is it exactly the palette's deep" — that is what visual-boot asserts
    // on Chromium. Here it is only "did the orb reach the buffer at all".
    expect(
      probe.luma,
      `renderer: ${probe.renderer} / ${probe.version}`,
    ).toBeGreaterThan(1);

    errors.assertClean("cross-browser boot");
  });

  test("the orb actually draws, not just the clear colour @crossbrowser", async ({ page }) => {
    // A booted canvas with a working clear is still compatible with a shader
    // that failed to compile — that is exactly the failure mode T4.2 hit, and it
    // is invisible to a "did it boot" check. So: does anything brighter than the
    // background reach the centre?
    await page.goto("/?debug=1");
    await page.waitForFunction(() => window.__sokVisualReady === true, null, { timeout: 60_000 });

    // §9.1 opens with a camera entrance ease, so the orb is **not** at the centre for
    // the first second or so. Reading immediately after `__sokVisualReady` is a race:
    // on a fast machine the ease has finished, on a loaded CI runner it has not, and the
    // assertion below then fails for a reason that has nothing to do with the engine.
    // This test was flaky for exactly that reason.
    //
    // Polled to a *low* bar first — "something is there at all" — and only then held to
    // the real bound, which distinguishes "not drawn yet" from "genuinely too dim" in a
    // way no single fixed wait can.
    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              new Promise<number>((resolve) => {
                requestAnimationFrame(() => {
                  const c = document.querySelector(
                    "canvas[data-testid='visual-canvas']",
                  ) as HTMLCanvasElement | null;
                  const gl = (c?.getContext("webgl2") ?? c?.getContext("webgl")) as
                    | WebGL2RenderingContext
                    | null;
                  if (!c || !gl) return resolve(0);
                  const px = new Uint8Array(4);
                  gl.readPixels(
                    Math.floor(c.width / 2),
                    Math.floor(c.height / 2),
                    1,
                    1,
                    gl.RGBA,
                    gl.UNSIGNED_BYTE,
                    px,
                  );
                  resolve(
                    0.2126 * (px[0] ?? 0) + 0.7152 * (px[1] ?? 0) + 0.0722 * (px[2] ?? 0),
                  );
                });
              }),
          ),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0.5);

    const stats = await page.evaluate(
      () =>
        new Promise<{ stdDev: number; mean: number } | null>((resolve) => {
          requestAnimationFrame(() => {
            const c = document.querySelector(
              "canvas[data-testid='visual-canvas']",
            ) as HTMLCanvasElement | null;
            const gl = c?.getContext("webgl2");
            if (!c || !gl) return resolve(null);
            const w = gl.drawingBufferWidth;
            const h = gl.drawingBufferHeight;
            const rw = Math.max(1, Math.floor(w * 0.3));
            const rh = Math.max(1, Math.floor(h * 0.3));
            const px = new Uint8Array(rw * rh * 4);
            gl.readPixels(
              Math.floor(w * 0.35),
              Math.floor(h * 0.35),
              rw,
              rh,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              px,
            );
            let sum = 0;
            let sq = 0;
            const n = rw * rh;
            for (let i = 0; i < n; i++) {
              const l =
                (0.2126 * (px[i * 4] ?? 0) +
                  0.7152 * (px[i * 4 + 1] ?? 0) +
                  0.0722 * (px[i * 4 + 2] ?? 0)) /
                255;
              sum += l;
              sq += l * l;
            }
            const mean = sum / n;
            resolve({ mean, stdDev: Math.sqrt(Math.max(0, sq / n - mean * mean)) });
          });
        }),
    );

    expect(stats, "could not read the centre of the canvas").not.toBeNull();
    if (!stats) return;
    // A clear-colour-only render is a flat field: near-zero variance.
    expect(stats.stdDev, "centre is flat — the orb did not draw").toBeGreaterThan(0.01);
  });

  test("AudioContext runs and outputLatency falls back cleanly @crossbrowser", async ({ page }) => {
    // F2/F3. Firefox does not implement `outputLatency`; Safari's behaviour
    // varies by version. §8.2 requires the `baseLatency` fallback, so what is
    // asserted is that *some* usable number comes back — never that the field
    // exists, which would fail on exactly the engines that need the fallback.
    const result = await page.evaluate(async () => {
      const w = window as unknown as { AudioContext?: typeof AudioContext };
      if (!w.AudioContext) return { ok: false, reason: "no AudioContext constructor" };
      const ctx = new AudioContext({ latencyHint: "playback" });
      try {
        await ctx.resume();
        const anyCtx = ctx as unknown as {
          outputLatency?: number;
          baseLatency?: number;
        };
        const hasOutput = typeof anyCtx.outputLatency === "number" && anyCtx.outputLatency > 0;
        const hasBase = typeof anyCtx.baseLatency === "number" && anyCtx.baseLatency > 0;
        return {
          ok: true,
          state: ctx.state as string,
          hasOutput,
          hasBase,
          sampleRate: ctx.sampleRate,
        };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    });

    expect(result.ok, `AudioContext failed: ${JSON.stringify(result)}`).toBe(true);
    if (!result.ok) return;
    expect(result.state).toBe("running");
    expect(result.sampleRate).toBeGreaterThan(8000);
    // The fallback contract: at least one of the two must be usable.
    expect(
      result.hasOutput || result.hasBase,
      "neither outputLatency nor baseLatency available — §8.2's fallback cannot work",
    ).toBe(true);
  });

  test("reduced motion is honoured on this engine @crossbrowser", async ({ browser }) => {
    // §9.11 again, but specifically because `matchMedia("(prefers-reduced-motion:
    // reduce)")` is emulated differently per engine — a browser that ignores it
    // would show no shake and would look correct here.
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    try {
      await page.goto("/?debug=1");
      await page.waitForFunction(() => window.__sokVisualReady === true, null, { timeout: 60_000 });

      const reduceMotion = await page.evaluate(() => {
        const v = (
          window as unknown as {
            __sok?: { visual?: { engine?: { rig?: { reduceMotionEnabled: boolean } } } };
          }
        ).__sok?.visual;
        return v?.engine?.rig?.reduceMotionEnabled;
      });
      expect(reduceMotion, "this engine ignored prefers-reduced-motion").toBe(true);
    } finally {
      await context.close();
    }
  });
});
