import { expect, test } from "@playwright/test";
import "./sok-window";

/**
 * The dust must be **visible**, and visibility is a property of the relationship
 * between the dust and the background — not of the constant that sets it.
 *
 * **Why this is a differential and not a constant assertion.** `DUST_BASE_ALPHA` was
 * 0.35 from T4.4 until T5.4, and a test asserting `=== 0.35` would have kept passing the
 * entire time the dust was invisible. It became invisible because two *other* decisions
 * changed the ground underneath it: C6 moved the background from navy (0,4,18) to black
 * (0,0,1), and C11 dimmed the orb so it stopped lighting its surroundings. Nothing about
 * the dust file changed, so nothing about a test on the dust file fired.
 *
 * So this measures what the dust *adds*: render with it, render without it, diff. That
 * fails if the dust stops rendering, if the background changes again, if the tone mapping
 * changes, or if somebody renames the constant — none of which a value assertion sees.
 *
 * Measured on the live path, peak channel value **outside** the orb:

 * | `dustAlpha` | peak | % pixels lit |
 * |---|---|---|
 * | 0 (off)     | 2   | 0.000 % |
 * | 0.35        | 13  | 0.025 % |
* | 0.75 (now)  | ~70 | —        |
 */

/** Peak channel value outside the orb's disc, read from inside the frame loop. */
const probe = (page: import("@playwright/test").Page) =>
  page.evaluate(
    () =>
      new Promise<{ peak: number; litFraction: number; floor: number }>((resolve) => {
        requestAnimationFrame(() => {
          const c = document.querySelector("canvas");
          if (!c) return resolve({ peak: 0, litFraction: 0, floor: 0 });
          const gl = (c.getContext("webgl2") ?? c.getContext("webgl")) as WebGL2RenderingContext;
          const w = c.width;
          const h = c.height;
          const px = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
          let peak = 0;
          let lit = 0;
          let n = 0;
          let sum = 0;
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              // Skip the orb: it is the subject, and its own glow would swamp the diff.
              const dx = x / w - 0.5;
              const dy = y / h - 0.5;
              if (Math.hypot(dx, dy) < 0.3) continue;
              const i = (y * w + x) * 4;
              const v = Math.max(px[i] ?? 0, px[i + 1] ?? 0, px[i + 2] ?? 0);
              sum += v;
              n++;
              if (v > 6) lit++;
              if (v > peak) peak = v;
            }
          }
          resolve({ peak, litFraction: n ? lit / n : 0, floor: n ? sum / n : 0 });
        });
      }),
  );

const enter = async (page: import("@playwright/test").Page, query: string): Promise<void> => {
  await page.goto(`/${query}`);
  await page.waitForFunction(() => window.__sok?.metrics !== undefined, null, { timeout: 30_000 });
  await page.getByTestId("enter-button").click();
  await expect(page.getByTestId("hud")).toBeVisible({ timeout: 5_000 });
  await page.waitForTimeout(3_000);
};

test.describe("§9.7 — the dust is visible", () => {
  test("it adds light outside the orb, and switches off cleanly", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1000, height: 640 });

    await enter(page, "?source=synthetic&nodust=1");
    const off = await probe(page);

    await enter(page, "?source=synthetic");
    const on = await probe(page);

    // The switch has to actually remove the dust, or the whole measurement is
    // meaningless. Checked on **peak**, not on the mean: dust covers ~0.03 % of the
    // frame, so the mean moves by 0.005 while the peak moves from 2 to 70. An earlier
    // version of this asserted on the mean and failed for exactly that reason — a
    // statistic that cannot see a sparse signal.
    expect(
      on.peak,
      `nodust=1 did not remove the dust (peak ${on.peak} vs ${off.peak})`,
    ).toBeGreaterThan(off.peak * 3);

    // The bright motes must clear the grain floor by a real margin. 0.35 peaked at 13
    // against a floor of 2 and was called invisible; the bound is 3× the off-state peak
    // plus an absolute floor, so it fails if either the dust disappears or the
    // background gets bright enough to swallow it again.
    expect(on.peak, `peak outside the orb was ${on.peak}`).toBeGreaterThan(24);

    // **No `litFraction` bound.** There was one, at 0.0004, and it was removed: at 0.75 it
    // measured 0.035 % and at the invisible 0.35 it measured 0.025 %. Those two numbers
    // do not distinguish the two cases — the statistic measures *area*, and dust is
    // sparse by design, so area barely moves while brightness moves 5×. A bound that
    // cannot fail for the reason it exists is a bound that only fails when the suite is
    // busy, which is worse than no bound.
    //
    // Peak brightness outside the orb is the discriminator: 2 → 13 → 70.
    expect(
      on.peak,
      `peak outside the orb was ${on.peak} against ${off.peak} with the dust off`,
    ).toBeGreaterThan(24);
  });

  test("the grain dither alone does not trip the visibility bound", async ({ page }) => {
    // The other half of the differential: with the dust off, the same measurement must
    // **fail** the visibility bound. Without this, a test that passes in both states is
    // measuring the grain — which is precisely the mistake this file exists to avoid.
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1000, height: 640 });
    await enter(page, "?source=synthetic&nodust=1");
    const off = await probe(page);
    // 24 is the same bound the visible case has to clear. If the dust is off and the
    // grain alone reaches it, the bound is measuring the grain.
    expect(off.peak, `the grain floor reached ${off.peak}`).toBeLessThan(24);
  });
});

test.describe("§11.7 — the dust sweep handles exist on the live path", () => {
  test("?dustAlpha= and ?dustDensity= are honoured outside the debug harness", async ({
    page,
  }) => {
    // They were added in T4.4 for the debug harness only, which meant the dust's
    // contribution could not be separated from the grain in the live path — and "the
    // dust looks invisible" and "the dust is invisible" are different claims that only
    // one measurement distinguishes.
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1000, height: 640 });

    await enter(page, "?source=synthetic&dustAlpha=0");
    const zero = await probe(page);
    await enter(page, "?source=synthetic&dustAlpha=1");
    const one = await probe(page);
    expect(one.peak).toBeGreaterThan(zero.peak * 3);
  });
});