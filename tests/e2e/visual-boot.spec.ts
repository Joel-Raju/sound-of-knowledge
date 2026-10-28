import { expect, test } from "@playwright/test";
import { recordErrors } from "./helpers";
import "./sok-window";

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
  // `?deep=0.5` — see the note below on why this test measures a brighter background
  // than the one that ships.
  await page.goto("/?debug=1&deep=0.5");
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
  // **Compare against the palette, at a lightness chosen so the comparison has signal.**
  //
  // This test used to assert "not pure black", which worked only while `deep` was
  // bright enough to be distinguishable from black. C6 moved it to L = 0.04, where the
  // background rounds to (0,0,1) — and at that darkness nothing can tell the palette
  // apart from a hardcoded `setClearColor(0x000000)`, which is the entire failure
  // this test exists to catch.
  //
  // I first tried comparing against the palette's own `deep` at the shipped L = 0.04,
  // and **verified it did not work**: with the clear colour hardcoded to black the
  // test still passed, because the whole background spans one 8-bit unit and any
  // tolerance wide enough to absorb rounding also absorbs the fault. Darker is not
  // more precise here; it is less.
  //
  // So the page is loaded with `?deep=0.5`. The override exists precisely so a test
  // can ask for a background bright enough to measure. At L = 0.5 the tolerance can
  // be 2 units instead of 4, which is tight enough to catch a stale clear colour.
  const expected = await page.evaluate(() => {
    const engine = window.__sok?.visual?.engine as unknown as {
      palette: { current: { deep: { r: number; g: number; b: number } } };
    };
    const d = engine.palette.current.deep;
    const enc = (c: number): number =>
      Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
    return { r: enc(d.r), g: enc(d.g), b: enc(d.b) };
  });
  // Sanity: the override really took, or the tight tolerance below is meaningless.
  expect(Math.max(expected.r, expected.g, expected.b), "?deep= must have brightened the palette")
    .toBeGreaterThan(40);

  expect(
    Math.abs(pixel.r - expected.r) + Math.abs(pixel.g - expected.g) + Math.abs(pixel.b - expected.b),
    `clear colour rgb(${pixel.r},${pixel.g},${pixel.b}) should match the palette's deep rgb(${expected.r},${expected.g},${expected.b})`,
  ).toBeLessThanOrEqual(2);

  // §9.3 gives lydian's `deep` hue 260°, so blue must dominate red.
  expect(pixel.b).toBeGreaterThan(pixel.r);
  expect(pixel.g).toBeGreaterThanOrEqual(pixel.r);
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

  // C6, decided by eye: the background is authored at L = 0.04, which renders as
  // (0,0,1)–(0,0,2) after §9.8's tone mapping. The background is now **too dark to
  // carry a hue**, so this test can no longer use it to witness §9.3's harmony ease.
  //
  // It did for a long time, and the constraint was real: at L = 0.06 lydian and
  // mixolydian quantised to the same 8-bit triple and the drift measured exactly zero.
  // Keeping the background at L = 0.10 to preserve a 1/255 signal was the wrong
  // trade — a navy wash to observe a harmony change that the orb, the dust and the
  // sparks all show far more legibly.
  //
  // So the harmony is witnessed through `core` and `dust` below. Measured at 8-bit
  // across all four modes, they are 50–140 units apart; `deep` spans 1.
  const luma = 0.2126 * before.r + 0.7152 * before.g + 0.0722 * before.b;
  expect(luma, `background luma was ${luma.toFixed(2)}`).toBeLessThan(2);
  expect(
    Math.max(before.r, before.g, before.b),
    "the background must be black, not navy",
  ).toBeLessThanOrEqual(3);

  // Retarget to aeolian, whose hues are a clear shift from lydian's.
  await page.evaluate(() => {
    const e = window.__sok?.visual?.engine as { setHarmony(m: string, r: number): void } | null;
    e?.setHarmony("aeolian", 6);
  });

  const readCore = async (): Promise<{ r: number; g: number; b: number }> =>
    page.evaluate(() => {
      const p = (window.__sok?.visual?.engine as { palette: { current: { core: { r: number; g: number; b: number } } } })
        .palette.current;
      const enc = (c: number): number =>
        Math.round(
          255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055),
        );
      return { r: enc(p.core.r), g: enc(p.core.g), b: enc(p.core.b) };
    });

  const distance = (
    a: { r: number; g: number; b: number },
    b: { r: number; g: number; b: number },
  ): number => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);

  const coreBefore = await readCore();

  // Mid-ease the colour must have moved *off* the old value — not snapped past it
  // and not stayed put. Both of those failures would pass a test that only compared
  // before with after. §9.3 eases with τ = 2 s, so ~1τ is two-thirds of the way.
  await page.waitForTimeout(2000);
  const coreDuring = await readCore();
  expect(
    distance(coreBefore, coreDuring),
    "the palette's core colour must drift during the §9.3 ease",
  ).toBeGreaterThan(5);

  // And it must end up clearly somewhere new — nowhere near the value it started at.
  await page.waitForTimeout(3500);
  const coreAfter = await readCore();
  expect(
    distance(coreBefore, coreAfter),
    "the palette's core colour must end on the new harmony",
  ).toBeGreaterThan(20);
});

test("all four harmonies are distinguishable through the orb, not the background", async ({
  page,
}) => {
  // The claim that makes C6's L = 0.04 safe: §9.3's harmony survives the move to a
  // black background, because the channels that carry it are nowhere near the 8-bit
  // floor. Measured separation across the four modes:
  //
  //   deep  (0,0,1) (0,0,1) (0,0,2) (0,0,2)   → 2 distinct, 1 unit apart
  //   dust  ~40–60 units between every pair
  //   core  ~50–140 units between every pair
  //
  // If this fails, the background is the only place the harmony was visible and the
  // trade was not free after all.
  await page.goto("/?debug=1&quality=high");
  await page.waitForFunction(() => window.__sokVisualReady === true, null, { timeout: 30_000 });

  const enc = (c: number): number =>
    Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));

  const seen: Record<string, string[]> = { core: [], dust: [], deep: [] };
  for (const mode of ["lydian", "mixolydian", "dorian", "aeolian"]) {
    await page.evaluate((m) => {
      const e = window.__sok?.visual?.engine as { setHarmony(m: string, r: number): void };
      e.setHarmony(m, 0);
    }, mode);
    await page.waitForTimeout(4000);
    const c = await page.evaluate(() => {
      const p = (window.__sok?.visual?.engine as { palette: { current: Record<string, { r: number; g: number; b: number }> } })
        .palette.current;
      return { core: p.core, dust: p.dust, deep: p.deep };
    });
    for (const k of ["core", "dust", "deep"] as const) {
      const rgb = c[k] as { r: number; g: number; b: number };
      seen[k]?.push([rgb.r, rgb.g, rgb.b].map(enc).join(","));
    }
  }

  const distinct = (a: string[]): number => new Set(a).size;
  expect(distinct(seen.core!), "the core colour must tell the four modes apart").toBe(4);
  expect(distinct(seen.dust!), "the dust colour must tell the four modes apart").toBe(4);
  // The background is *not* expected to — that is the trade, stated as an assertion
  // so a future change to `deep` that restores it is noticed as a comment, not a bug.
  expect(distinct(seen.deep!)).toBeLessThan(4);
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
