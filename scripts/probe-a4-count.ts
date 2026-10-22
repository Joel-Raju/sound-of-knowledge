/**
 * How many notes does the A4 calibration ACTUALLY produce, in which configuration?
 *
 * The e2e test asserted "exactly six" and passed — but the human, running the default
 * URL, got **22 notes for six steps**. The difference is the melodic gate's probability
 * `p`, which scales with energy and with density:
 *
 *   p = targetNotesPerSec(density) * STEP_SEC
 *
 * so the number of retries before the sampler picks an edit — and therefore the number
 * of COPIES left in the queue — depends on the configuration. A test that only covers
 * one configuration is a test that will not catch the bug the human hit.
 *
 * Run: `npx tsx scripts/probe-a4-count.ts
 */
import { chromium } from "@playwright/test";

const BASE = process.env.SOK_BASE ?? "http://127.0.0.1:3000";

const CONFIGS: Array<{ name: string; url: string; warmup: number }> = [
  { name: "human's config (default URL, live, normal density)", url: "/", warmup: 8_000 },
  { name: "sparse + synthetic (what the e2e test used)", url: "/?source=synthetic&density=sparse", warmup: 1_000 },
  { name: "normal + synthetic", url: "/?source=synthetic&density=normal", warmup: 1_000 },
  { name: "normal + synthetic, 10s warm-up", url: "/?source=synthetic&density=normal", warmup: 10_000 },
  { name: "sparse + live", url: "/?source=live&density=sparse", warmup: 8_000 },
  { name: "default URL, long warm-up so energy decays", url: "/", warmup: 20_000 },
];

const run = async (): Promise<void> => {
  const browser = await chromium.launch();
  for (const cfg of CONFIGS) {
    const page = await browser.newPage();
    await page.goto(`${BASE}${cfg.url}`);
    await page.getByTestId("enter-button").click({ timeout: 20_000 });
    await page.getByTestId("hud").waitFor({ timeout: 10_000 });
    await page.waitForTimeout(cfg.warmup);

    const before = await page.evaluate(
      () =>
        (
          window as unknown as {
            __sok?: { metrics?: () => { notesScheduled: number; energy: number } };
          }
        ).__sok!.metrics!(),
    );

    await page.evaluate(() => {
      const w = window as unknown as {
        __sok?: { runA4Calibration?: (o?: { gapMs?: number }) => unknown[] };
      };
      w.__sok?.runA4Calibration?.({ gapMs: 900 });
    });
    await page.waitForTimeout(12_000);

    const after = await page.evaluate(() => {
      const w = window as unknown as {
        __sok?: {
          metrics?: () => { notesScheduled: number; energy: number };
          getA4Fired?: () => string[];
        };
      };
      return { m: w.__sok!.metrics!(), fired: w.__sok!.getA4Fired!() };
    });
    const m = after.m;
    console.log(
      `${cfg.name}\n    energy=${m.energy.toFixed(3)}  fired=${after.fired.length}  ` +
        `notes=${m.notesScheduled - before.notesScheduled}  (want 6)`,
    );
    await page.close();
  }
  await browser.close();
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
