/**
 * Does a comet render AT ALL, when it is spawned where it can be seen?
 *
 * The remaining question after everything else: the engine spawns sparks continuously,
 * ~27 % of edits land inside the frustum, and yet a captured frame shows no streak. Two
 * explanations remain:
 *
 *   (a) the sparks are rendered but the real spawn positions are off-screen, or
 *   (b) the spark rendering itself is broken.
 *
 * `debugSpawn` (§T4.3) spawns into a **70° cone centred on the point diametrically
 * opposite the camera** — a cone chosen because it is *visible*. So if a screenshot
 * after `debugSpawn` shows streaks, the rendering works and the real path's problem is
 * purely that its spawn positions are off-screen.
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.SOK_BASE ?? "http://127.0.0.1:3000";
const OUT = "artifacts/shots/a4-comets";

const main = async (): Promise<void> => {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${BASE}/?debug=1`);
  await page.waitForTimeout(3_000);

  const ready = await page.evaluate(
    `(() => {
      const v = window.__sok && window.__sok.visual;
      if (!v) return "no visual handle";
      return typeof v.debugSpawn;
    })()`,
  );
  console.log("debugSpawn available:", ready);

  await page.evaluate(
    `(() => { window.__sok.visual.debugSpawn(400); return true; })()`,
  );
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/debug-spawn.png` });
  console.log(`wrote ${OUT}/debug-spawn.png`);

  const counts = await page.evaluate(
    `(() => { const p = window.__sok.visual.poolCounts(); return p; })()`,
  );
  console.log("pool counts:", JSON.stringify(counts));

  await browser.close();
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
