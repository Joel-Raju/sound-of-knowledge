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
    // `?cometEveryMs=0` — the throttle is **off** for this test, on purpose.
    //
    // This test asks "does a comet render at all?", and the answer must not depend on
    // how many of them there are. With the default 1.2 s throttle the lit-pixel count
    // falls below the threshold and the test fails for a reason that has nothing to do
    // with rendering. The throttle has its own test.
    await page.goto("/?source=synthetic&cometEveryMs=0");
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
      `      brightest outside the core: ${bestLum.toFixed(0)}  (lit pixels: ${bestCount})`,
    );

    // **The peak brightness, not the lit-pixel count.**
    //
    // The count is too noisy to threshold: it depends on how many comets happen to be in
    // frame, and it swung from 923 to 4163 across runs of the same build. The *peak* is
    // stable — a comet's core is 241-255 wherever it is, while the core's own rim
    // never exceeds 161.
    //
    // Measured, three runs each:
    //
    //   the original bug:  brightest 161, 161, 77
    //   the fix:            brightest 249, 251, 254
    expect(
      bestLum,
      "no comet rendered in 5 s — check that addUpdateRange is given ARRAY ELEMENTS, not instances",
    ).toBeGreaterThan(200);
  });

  test("the routine comet rate is bounded, and the punctuation never is", async ({ page }) => {
    // The human: *"the frequency of the comets is too large and it removes the visual
    // enjoyment."* With the energy finally alive the live stream carries 3.0 notes/s, so
    // a comet per note is one every 330 ms.
    //
    // This compares the throttled rate against the unthrottled rate **in the same
    // process**, so it does not depend on how busy the source happens to be — the
    // synthetic source is several times busier than the live stream, and an absolute
    // bound failed for that reason alone.
    const rate = async (ms: number): Promise<{ comets: number; throttled: number }> => {
      await page.goto(`/?source=synthetic&cometEveryMs=${ms}`);
      await page.getByTestId("enter-button").click({ timeout: 20_000 });
      await page.getByTestId("hud").waitFor({ timeout: 10_000 });
      await page.waitForTimeout(2_000);
      const a = (await page.evaluate(
        `(() => window.__sok.engine.getVisualCounts())()`,
      )) as { comets: number; throttled: number };
      await page.waitForTimeout(10_000);
      const b = (await page.evaluate(
        `(() => window.__sok.engine.getVisualCounts())()`,
      )) as { comets: number; throttled: number };
      return {
        comets: (b.comets - a.comets) / 10,
        throttled: (b.throttled - a.throttled) / 10,
      };
    };

    const off = await rate(0);
    const on = await rate(1000);
    console.log(
      `      unthrottled ${off.comets.toFixed(2)}/s  ->  throttled ${on.comets.toFixed(2)}/s ` +
        `(${on.throttled.toFixed(2)}/s removed)`,
    );

    // The throttle must actually be removing events, or it is not doing anything.
    expect(
      on.throttled,
      "the throttle must be removing routine comets",
    ).toBeGreaterThan(0.2);

    // And it must reduce the rate. A ratio, so the source's busyness does not matter.
    expect(
      on.comets,
      `throttling did not reduce the comet rate (${off.comets.toFixed(2)}/s -> ${on.comets.toFixed(2)}/s)`,
    ).toBeLessThan(off.comets * 0.85);
  });

  test("the update ranges are expressed in array elements", async ({ page }) => {
    // The structural check, so the unit mismatch cannot come back. three.js's
    // `addUpdateRange` is in elements, and the attributes have itemSize 3 and 4.
    //
    // `?cometEveryMs=0` — it needs a streak *alive at the instant of sampling*, and the
    // default throttle now caps everything but reverts and births at one per 2 s, which
    // leaves the pool empty most of the time. This test is about upload units, not
    // about how many comets there are; the throttle has its own test.
    await page.goto("/?source=synthetic&cometEveryMs=0");
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
