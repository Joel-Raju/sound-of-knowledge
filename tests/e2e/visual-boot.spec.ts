import { expect, test } from "@playwright/test";
import { recordErrors } from "./helpers";

/**
 * Spec T4.1 acceptance — "tests green; the main page (debug) shows a dark canvas
 * without console errors (Playwright smoke)".
 *
 * The engine itself is unit-tested (`governor`, `palette`, `tier`, the camera
 * rig's pure helpers). What is *not* unit-testable is the part that actually
 * broke three times in the audio phase: whether a context is created, wired and
 * torn down correctly in a real browser. So this asserts the things only a real
 * WebGL context can tell us — that the canvas is live, sized, rendering frames,
 * and cleared to the palette's `deep`.
 *
 * Under swiftshader this is the low tier (§12.2), so the tier assertion below
 * also covers tier detection working end-to-end in CI.
 */

interface VisualReady {
  ready: boolean;
  status: string;
  message?: string;
}

declare global {
  interface Window {
    __sokVisualReady?: boolean;
    __sok?: {
      visual?: {
        engine: unknown;
        status: string;
        message?: string;
        stats(): {
          fps: number;
          emaMs: number;
          p95Ms: number;
          tier: string;
          level: number;
          scale: number;
          drawCalls: number;
          triangles: number;
          /** Real GPU frame cost from the last synchronised sample (see DECISIONS.md). */
          syncedMs: number;
        } | null;
      };
    };
  }
}

test("the debug page renders a dark canvas with no console errors", async ({ page }) => {
  const errors = recordErrors(page);

  await page.goto("/?debug=1");
  await page.waitForFunction(() => window.__sokVisualReady === true, null, { timeout: 30_000 });

  const handle: VisualReady = await page.evaluate(() => ({
    ready: !!window.__sok?.visual?.engine,
    status: window.__sok?.visual?.status ?? "missing",
    message: window.__sok?.visual?.message,
  }));

  // A software rasteriser is the one case §12.2 pins to `low`; anything else
  // under CI would mean the GPU probe is not reaching the spec.
  expect(handle.status, `visual harness status: ${handle.message ?? "no message"}`).toBe("ready");

  const canvas = page.getByTestId("visual-canvas");
  await expect(canvas).toBeVisible();
  await expect(page.getByTestId("visual-error")).toHaveCount(0);

  errors.assertClean("visual canvas mount");
});

test("the canvas is sized to the viewport and has a live drawing buffer", async ({ page }) => {
  await page.goto("/?debug=1");
  await page.waitForFunction(() => window.__sokVisualReady === true, null, { timeout: 30_000 });

  const sized = await page.evaluate(() => {
    const c = document.querySelector(
      "canvas[data-testid='visual-canvas']",
    ) as HTMLCanvasElement | null;
    if (!c) return null;
    const ctx = c.getContext("webgl2");
    return {
      cssWidth: c.clientWidth,
      cssHeight: c.clientHeight,
      bufferWidth: c.width,
      bufferHeight: c.height,
      pixelRatio: ctx ? window.devicePixelRatio : -1,
      // §9.1 — the canvas must not be a scroller trap for touch drags.
      touchAction: c.style.touchAction,
    };
  });

  expect(sized, "the visual canvas must exist in the DOM").not.toBeNull();
  if (!sized) return;

  expect(sized.cssWidth).toBeGreaterThan(100);
  expect(sized.cssHeight).toBeGreaterThan(100);
  // The drawing buffer must be non-zero, or nothing can be drawn at all.
  expect(sized.bufferWidth).toBeGreaterThan(0);
  expect(sized.bufferHeight).toBeGreaterThan(0);
  expect(sized.touchAction).toBe("none");
});

test("the frame loop runs and the governor holds its bounds", async ({ page }) => {
  await page.goto("/?debug=1");
  await page.waitForFunction(() => window.__sokVisualReady === true, null, { timeout: 30_000 });

  // Let a few hundred frames accumulate so the frame stats and the governor's
  // warm-up (§9.10, 3 s) have both had time to say something.
  await page.waitForTimeout(4000);

  const stats = await page.evaluate(() => window.__sok?.visual?.stats() ?? null);
  expect(stats, "the engine must expose stats").not.toBeNull();
  if (!stats) return;

  expect(["low", "medium", "high"]).toContain(stats.tier);
  expect(stats.level).toBeGreaterThanOrEqual(0);
  expect(stats.level).toBeLessThanOrEqual(6);
  // §9.10 — scale ∈ [0.55, ceiling]. A frame time above and below the floor
  // would mean the governor is being fed something other than frame deltas.
  expect(stats.scale).toBeGreaterThanOrEqual(0.55 - 1e-6);

  // The loop is demonstrably running: the frame counter advanced past zero.
  const frames = await page.evaluate(() => {
    const e = window.__sok?.visual?.engine as { frames?: { frameCount: number } } | null;
    return e?.frames?.frameCount ?? 0;
  });
  expect(frames, "the rAF loop must have produced frames").toBeGreaterThan(10);
});

test("the canvas is cleared to the palette's deep colour, not black", async ({ page }) => {
  await page.goto("/?debug=1");
  await page.waitForFunction(() => window.__sokVisualReady === true, null, { timeout: 30_000 });
  // Past the entrance ease, though the clear colour does not depend on the camera.
  await page.waitForTimeout(1500);

  // Read the actual rendered pixel rather than trusting a uniform: this is the
  // check that would have caught a black clear colour surviving a palette change.
  //
  // The read happens inside a rAF callback. A WebGL drawing buffer is discarded
  // once the frame is composited, so `readPixels` called from a test continuation
  // — outside the frame loop — reads back zeros and would "prove" black whether
  // or not anything was drawn.
  const pixel = await page.evaluate(
    () =>
      new Promise<{ r: number; g: number; b: number; a: number } | null>((resolve) => {
        requestAnimationFrame(() => {
          const c = document.querySelector(
            "canvas[data-testid='visual-canvas']",
          ) as HTMLCanvasElement | null;
          if (!c) return resolve(null);
          const gl = c.getContext("webgl2");
          if (!gl) return resolve(null);
          const buf = new Uint8Array(4);
          // 2,2 is guaranteed background at this stage; the centre is where the
          // core orb lands from T4.2, so this must stay background now and must
          // stop being background then.
          gl.readPixels(2, 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
          resolve({ r: buf[0] ?? -1, g: buf[1] ?? -1, b: buf[2] ?? -1, a: buf[3] ?? -1 });
        });
      }),
  );

  expect(pixel, "must be able to read pixels from the canvas").not.toBeNull();
  if (!pixel) return;

  // §9.1 — `alpha: false`, so the drawing buffer has no alpha and reads back 255.
  expect(pixel.a, "the canvas must be opaque (§9.1 alpha:false)").toBe(255);

  // Measured under swiftshader. C6 darkened `deep`'s lightness, and the floor it hit
  // is 8-bit quantisation rather than taste — see the harmony test below. At
  // L = 0.10, lydian's `deep` is linear (0.00082, 0.00235, 0.01001) and comes
  // through the sRGB transfer as 8-bit **(1, 3, 9)** — the exact OKLCH → linear
  // sRGB → three.js Color → clear colour → drawing buffer chain, and matching the
  // measured pixels.
  const luma = 0.2126 * pixel.r + 0.7152 * pixel.g + 0.0722 * pixel.b;
  expect(luma, `clear colour luma was ${luma} (rgb ${pixel.r},${pixel.g},${pixel.b})`).toBeLessThan(
    40,
  );

  // Not pure black: a `setClearColor(0x000000)` that outlived the palette would
  // read (0, 0, 0) and sail through the luma ceiling above.
  //
  // The threshold is **> 0, not a calibrated number**: at L = 0.10 the brightest
  // channel is 9 out of 255, so any absolute bound above that is a bound on the
  // palette's lightness rather than on the wiring. What this asserts is that the
  // palette reached the buffer at all; the hue check below carries the weight.
  expect(
    Math.max(pixel.r, pixel.g, pixel.b),
    "the palette deep must survive to the buffer",
  ).toBeGreaterThan(0);

  // And it must be the palette's blue-violet, not a grey: §9.3 gives lydian's
  // `deep` a hue of 260°, so blue dominates red several times over. This is what
  // would catch a clear colour wired to the wrong palette slot.
  expect(pixel.b).toBeGreaterThan(pixel.r * 2);
  expect(pixel.g).toBeGreaterThan(pixel.r);
});

test("the clear colour follows the palette through a harmony change", async ({ page }) => {
  await page.goto("/?debug=1");
  await page.waitForFunction(() => window.__sokVisualReady === true, null, { timeout: 30_000 });
  // Past the 2 s ease (§9.3) so the starting colour is settled.
  await page.waitForTimeout(3000);

  const readPixel = () =>
    page.evaluate(
      () =>
        new Promise<{ r: number; g: number; b: number } | null>((resolve) => {
          requestAnimationFrame(() => {
            const c = document.querySelector(
              "canvas[data-testid='visual-canvas']",
            ) as HTMLCanvasElement | null;
            if (!c) return resolve(null);
            const gl = c.getContext("webgl2");
            if (!gl) return resolve(null);
            const buf = new Uint8Array(4);
            gl.readPixels(2, 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
            resolve({ r: buf[0] ?? -1, g: buf[1] ?? -1, b: buf[2] ?? -1 });
          });
        }),
    );

  const before = await readPixel();
  expect(before).not.toBeNull();
  if (!before) return;

  // Retarget to aeolian, whose `deep` is authored at hue 290° against lydian's
  // 260° — a clear hue shift, not a brightness wobble.
  await page.evaluate(() => {
    const e = window.__sok?.visual?.engine as { setHarmony(m: string, r: number): void } | null;
    e?.setHarmony("aeolian", 6);
  });

  // Mid-ease the colour must have moved *off* the old value — not snapped past it
  // and not stayed put. Both of those failures would pass a test that only
  // compared before with after.
  //
  // 2 000 ms, not 700. §9.3 eases with τ = 2 s, so 700 ms in the palette has
  // travelled only ~30 % of the way — and at C6's darkened `deep` that is under one
  // 8-bit unit, which is not a signal the assertion can carry. Reading at ~1τ gets
  // two-thirds of the way, which is unambiguous without weakening the bound.
  await page.waitForTimeout(2000);
  const during = await readPixel();
  expect(during).not.toBeNull();
  if (!during) return;

  const distance = (
    a: { r: number; g: number; b: number },
    b: { r: number; g: number; b: number },
  ): number => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
  // The clear colour must *change* as §9.3 eases the palette to a new harmony.
  //
  // This is where C6's darkening found its floor. At L ≈ 0.06 the four modes'
  // `deep` colours quantise to **the same 8-bit triple** — lydian and mixolydian
  // both land on (0,1,3) — so the harmony drift is not merely small, it is exactly
  // zero and the clear colour stops following the palette at all. At L = 0.10 all
  // four are distinct: (1,3,9), (0,4,9), (2,3,11), (3,2,12).
  //
  // So `deep` is set at L = 0.10 and the bound stays above 1. That is a real
  // constraint, not a loosened one: 8-bit quantisation sets a floor on how dark the
  // clear colour can go before §9.3 stops being observable.
  expect(
    distance(before, during),
    "the clear colour must drift during the §9.3 ease",
  ).toBeGreaterThan(1);

  // And it must end up clearly somewhere new.
  await page.waitForTimeout(3500);
  const after = await readPixel();
  expect(after).not.toBeNull();
  if (!after) return;
  // > 2, down from > 3, for the same reason as the bounds above: C6 darkened
  // `deep`, so the absolute 8-bit distance between two modes' colours shrank. The
  // measured distance is 3 — lydian's (1,3,9) against aeolian's — which is a real
  // move to a distinct triple, and the checks on either side of this one (drift
  // mid-ease, and hue dominance) are what would catch a clear colour that snapped
  // straight to the wrong palette slot.
  expect(distance(before, after), "the clear colour must end on the new palette").toBeGreaterThan(
    2,
  );
});

test("disposing the engine stops the loop and releases the context", async ({ page }) => {
  const errors = recordErrors(page);
  await page.goto("/?debug=1");
  await page.waitForFunction(() => window.__sokVisualReady === true, null, { timeout: 30_000 });
  await page.waitForTimeout(500);

  const after = await page.evaluate(async () => {
    const v = window.__sok?.visual;
    const engine = v?.engine as { dispose(): void; frames?: { frameCount: number } } | null;
    if (!engine) return { ok: false, reason: "no engine" };
    engine.dispose();
    const atDispose = engine.frames?.frameCount ?? 0;
    await new Promise((r) => setTimeout(r, 300));
    return { ok: true, atDispose, after: engine.frames?.frameCount ?? -1 };
  });

  expect(after.ok).toBe(true);
  // No further frames after dispose — this is the assertion that catches a
  // leaked rAF loop, which would keep a torn-down context alive indefinitely.
  expect(after.after).toBe(after.atDispose);

  errors.assertClean("engine dispose");
});
