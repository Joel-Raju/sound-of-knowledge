/**
 * Find a frame that actually contains a comet, and write it out.
 *
 * The orb is the bright thing in the frame, so "brightest pixel" is useless. A comet is
 * a *thin streak outside the orb's disc*, so this measures the brightest pixel in the
 * region outside a circle around the core — and picks the frame that has one.
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import sharp from "sharp";

const BASE = process.env.SOK_BASE ?? "http://127.0.0.1:3000";
const OUT = "artifacts/shots/a4-comets";

const main = async (): Promise<void> => {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${BASE}/`);
  await page.getByTestId("enter-button").click({ timeout: 20_000 });
  await page.getByTestId("hud").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(1_000);

  const orb = { cx: 640, cy: 350, r: 190 }; // measured from the captured frame
  let best = { lum: -1, frame: -1 };
  const perFrame: number[] = [];

  for (let i = 0; i < 60; i++) {
    const buf = await page.screenshot();
    const { data, info } = await sharp(buf)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    let maxOut = 0;
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        const dx = x - orb.cx;
        const dy = y - orb.cy;
        if (dx * dx + dy * dy < orb.r * orb.r) continue;
        const j = (y * width + x) * channels;
        const l = 0.2126 * data[j]! + 0.7152 * data[j + 1]! + 0.0722 * data[j + 2]!;
        if (l > maxOut) maxOut = l;
      }
    }
    perFrame.push(maxOut);
    if (maxOut > best.lum) {
      best = { lum: maxOut, frame: i };
      await sharp(buf).toFile(`${OUT}/best.png`);
    }
    await page.waitForTimeout(220);
  }

  console.log("brightest pixel outside the orb, per frame:");
  console.log("  " + perFrame.map((v) => v.toFixed(0).padStart(4)).join(""));
  console.log(`\n  best frame ${best.frame} at ${best.lum.toFixed(1)} -> ${OUT}/best.png`);
  console.log(`  median ${perFrame.slice().sort((a, b) => a - b)[30]?.toFixed(1)}`);
  await browser.close();
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
