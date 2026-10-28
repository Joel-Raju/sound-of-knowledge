/**
 * Sixty seconds at radius 14, where ~98 % of comets should be inside the frustum.
 *
 * At 2-5 notes/s that is 2-5 visible comets per second. They cannot hide. So:
 *
 *   - comets appear  -> the real path renders, and the problem is purely how many of
 *                       them are in frame (§9.1's camera placement)
 *   - nothing appears -> the real path does not render at all, and the frustum
 *                        analysis is describing the wrong problem
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import sharp from "sharp";

const BASE = process.env.SOK_BASE ?? "http://127.0.0.1:3000";
const OUT = "artifacts/shots/framing";

const main = async (): Promise<void> => {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${BASE}/?camRadius=14`);
  await page.getByTestId("enter-button").click({ timeout: 20_000 });
  await page.getByTestId("hud").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(6_000);

  let best = { lum: -1, i: -1 };
  let framesWithComet = 0;
  const lumas: number[] = [];

  for (let i = 0; i < 300; i++) {
    const buf = await page.screenshot();
    const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    // Exclude the HUD bands and the orb's disc.
    let maxL = 0;
    for (let y = 70; y < height - 70; y++) {
      for (let x = 0; x < width; x++) {
        const dx = x - 640;
        const dy = y - 350;
        if (dx * dx + dy * dy < 110 * 110) continue;
        const j = (y * width + x) * channels;
        const l = 0.2126 * data[j]! + 0.7152 * data[j + 1]! + 0.0722 * data[j + 2]!;
        if (l > maxL) maxL = l;
      }
    }
    lumas.push(maxL);
    if (maxL > 60) framesWithComet++;
    if (maxL > best.lum) {
      best = { lum: maxL, i };
      await sharp(buf).toFile(`${OUT}/radius14-best.png`);
    }
    await page.waitForTimeout(180);
  }

  lumas.sort((a, b) => a - b);
  console.log(`  300 frames over ~54 s at radius 14`);
  console.log(`  frames with a pixel above 60 outside the orb: ${framesWithComet}`);
  console.log(`  luminance percentiles: p50=${lumas[150]?.toFixed(0)} p90=${lumas[270]?.toFixed(0)} p99=${lumas[297]?.toFixed(0)} max=${best.lum.toFixed(0)}`);
  console.log(`  best frame ${best.i} -> ${OUT}/radius14-best.png`);
  await browser.close();
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
