/**
 * Find a real comet in a captured frame.
 *
 * The orb is the bright thing, and the HUD is text at the top and bottom, so both are
 * excluded. What is left is the frame, and a comet is a thin streak in it.
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import sharp from "sharp";

const BASE = process.env.SOK_BASE ?? "http://127.0.0.1:3000";
const OUT = "artifacts/shots/framing";

const main = async (): Promise<void> => {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const query = process.argv[2] ?? "?camRadius=14";
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${BASE}/${query}`);
  await page.getByTestId("enter-button").click({ timeout: 20_000 });
  await page.getByTestId("hud").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(4_000);

  const results: Array<{ i: number; lum: number; bright: number }> = [];

  for (let i = 0; i < 50; i++) {
    const buf = await page.screenshot();
    const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    let maxL = 0;
    let bright = 0;
    for (let y = 70; y < height - 70; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const j = (y * width + x) * channels;
        const l = 0.2126 * data[j]! + 0.7152 * data[j + 1]! + 0.0722 * data[j + 2]!;
        if (l > maxL) maxL = l;
        if (l > 25) bright++;
      }
    }
    results.push({ i, lum: maxL, bright });
    if (maxL > 120) await sharp(buf).toFile(`${OUT}/bright-${i}.png`);
    await page.waitForTimeout(130);
  }

  console.log(`query: ${query || "(default)"}\n`);
  console.log("  frame: maxLum  brightPx");
  for (const r of results) {
    if (r.lum > 25 || r.i % 8 === 0) {
      console.log(`  ${String(r.i).padStart(4)}:  ${r.lum.toFixed(0).padStart(6)}  ${String(r.bright).padStart(8)}`);
    }
  }
  const best = results.reduce((a, b) => (b.lum > a.lum ? b : a));
  console.log(`\n  best frame ${best.i}: maxLum ${best.lum.toFixed(0)}`);
  await browser.close();
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
