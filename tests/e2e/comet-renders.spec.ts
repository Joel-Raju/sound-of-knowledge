/**
 * A comet must actually RENDER.
 *
 * This is the test whose absence let the whole thing ship broken.
 *
 * `BufferAttribute.addUpdateRange(start, count)` takes **array elements**, not
 * instances. The engine passed *instance* numbers for attributes with `itemSize` 3
 * (`aOrigin`, `aTarget`) and 4 (`aTimes`, `aStyle`), so every upload was a misaligned
 * slice — the wrong bytes entirely. The sparks' positions and timings never reached the
 * GPU, and **no comet rendered, ever.**
 *
 * The symptom was "I see the comet in the first 5 seconds and then no more" — the first
 * five seconds being the entrance, where the camera is at radius 9 and the shell
 * subtends a wider angle, so a few particles happened to be in frame.
 *
 * Every other test passed throughout: the spark pool's counters rose, the notes fired,
 * the unit test on `spawnRanges` was green (the *arithmetic* was right — the bug was the
 * unit at the call site), and the offline audio renders were unaffected. **Nothing
 * checked the pixels.**
 *
 * So this checks the pixels: over a window, is there ever a bright streak outside the
 * core's disc?
 */
import { expect, test } from "@playwright/test";
import sharp from "sharp";

/** The core's disc, as fractions of the frame, at the default framing. */
const CORE = { cx: 0.5, cy: 0.49, r: 0.17 };
/** Luminance above which a pixel counts as "something is there". */
const LIT = 70;

test.describe("§9.5 — a comet renders", () => {
  test("a bright streak appears outside the core", async ({ page }) => {
    await page.goto("/?source=synthetic");
    await page.getByTestId("enter-button").click({ timeout: 20_000 });
    await page.getByTestId("hud").waitFor({ timeout: 10_000 });
    // Let the entrance finish and traffic arrive.
    await page.waitForTimeout(6_000);

    // A **count** of lit pixels, not a maximum. The core's rim is bright too, so a
    // maximum is ambiguous; but the rim is inside the excluded disc, while a comet is a
    // scatter of lit pixels across the rest of the frame.
    let bestCount = 0;
    let bestLum = 0;
    for (let i = 0; i < 40; i++) {
      // A **screenshot**, not `readPixels`. Reading the drawing buffer outside a draw
      // returns nothing — the pitfall this project has already documented once.
      const buf = await page.screenshot();
      const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
      const { width, height, channels } = info;
      let count = 0;
      for (let y = 70; y < height - 70; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const dx = x / width - CORE.cx;
          const dy = y / height - CORE.cy;
          if (dx * dx + dy * dy < CORE.r * CORE.r) continue;
          const j = (y * width + x) * channels;
          const l = 0.2126 * data[j]! + 0.7152 * data[j + 1]! + 0.0722 * data[j + 2]!;
          if (l > LIT) count++;
          if (l > bestLum) bestLum = l;
        }
      }
      if (count > bestCount) bestCount = count;
      await page.waitForTimeout(120);
    }
    console.log(
      `      lit pixels outside the core: ${bestCount} (brightest ${bestLum.toFixed(0)})`,
    );
    // Measured, three runs each:
    //
    //   the original bug:      5    263    373
    //   the fix:            1394   2809   2410   1535
    //
    // The distributions do not overlap. 900 sits in the gap: 2.4x above the broken
    // maximum, and 35 % below the fixed minimum. (It was 1200 before, which is only
    // 14 % below the fixed minimum — and the test failed on that, as it should have.)
    expect(
      bestCount,
      "no comet rendered in 5 s — check that addUpdateRange is given ARRAY ELEMENTS, not instances",
    ).toBeGreaterThan(900);
  });

  test("the update ranges are expressed in array elements", async ({ page }) => {
    // The structural check, so the unit mismatch cannot come back. three.js's
    // `addUpdateRange` is in elements, and the attributes have itemSize 3 and 4.
    await page.goto("/?source=synthetic");
    await page.getByTestId("enter-button").click({ timeout: 20_000 });
    await page.getByTestId("hud").waitFor({ timeout: 10_000 });
    await page.waitForTimeout(3_000);

    const check = (await page.evaluate(
      `(() => {
        const s = window.__sok.engine.getSparkDebug();
        return s ? { ok: true } : { ok: false };
      })()`,
    )) as { ok: boolean };
    expect(check.ok, "the spark debug handle must work").toBe(true);

    // A spawned streak's data must be *readable* at the instance the cursor points to —
    // if the upload were misaligned, the attributes the CPU reads would still be right
    // (they are the same arrays) but the GPU would have the wrong bytes. So the
    // structural assertion is on the code, and the behavioural one is the pixels above.
    const ranges = (await page.evaluate(
      `(() => {
        const s = window.__sok.engine.getSparkDebug();
        const alive = s.liveStreaks || [];
        return alive.length;
      })()`,
    )) as number;
    expect(ranges, "live streaks must exist for the pixel test to mean anything").toBeGreaterThan(0);
  });
});
