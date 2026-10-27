/**
 * Are the comets actually on screen? Measured from the rendered pixels.
 *
 * The human: "I see the comet in the first 5 seconds and then no more." The engine is
 * not stopping — sparks spawn continuously (`probe-comets.ts` showed the spawn counter
 * rising all the way through). So either the comets are off-screen, or they are on
 * screen but too dim to see.
 *
 * **Those two need different fixes** and screenshots tell them apart: if the comet is
 * off-screen there are no bright pixels anywhere; if it is on screen but dim, there are
 * bright pixels in the frame and the problem is contrast.
 *
 * Method: screenshot the canvas every 400 ms and measure the brightest pixel, plus the
 * brightest pixel outside the centre (where the orb sits) — a comet is a streak
 * *arriving*, so it appears in the periphery.
 */
import { chromium } from "@playwright/test";
import sharp from "sharp";

const BASE = process.env.SOK_BASE ?? "http://127.0.0.1:3000";

const main = async (): Promise<void> => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${BASE}/`);
  await page.getByTestId("enter-button").click({ timeout: 20_000 });
  await page.getByTestId("hud").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(1_000);

  const canvas = page.locator("canvas").first();
  console.log("   t     maxLum   brightPx  maxPeripheral   reading");
  let brightest = 0;
  let brightestPeripheral = 0;

  for (let t = 0; t < 60; t++) {
    await page.waitForTimeout(400);
    const buf = await canvas.screenshot();
    const img = sharp(buf);
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;

    let maxL = 0;
    let bright = 0;
    let maxPer = 0;
    // The centre third is where the orb is; a comet arriving is outside it.
    const cx0 = Math.floor(width / 3);
    const cx1 = Math.floor((width * 2) / 3);
    const cy0 = Math.floor(height / 3);
    const cy1 = Math.floor((height * 2) / 3);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * channels;
        const l = 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
        if (l > maxL) maxL = l;
        if (l > 40) bright++;
        if (x < cx0 || x > cx1 || y < cy0 || y > cy1) {
          if (l > maxPer) maxPer = l;
        }
      }
    }
    if (maxL > brightest) brightest = maxL;
    if (maxPer > brightestPeripheral) brightestPeripheral = maxPer;
    if (t % 4 === 0) {
      console.log(
        `  ${String((t * 0.4).toFixed(1)).padStart(5)}s  ${maxL.toFixed(1).padStart(7)}  ` +
          `${String(bright).padStart(8)}  ${maxPer.toFixed(1).padStart(13)}`,
      );
    }
  }

  console.log(`\n  brightest pixel in the whole run: ${brightest.toFixed(1)}`);
  console.log(`  brightest peripheral pixel:        ${brightestPeripheral.toFixed(1)}`);
  console.log(
    `\n  => if the peripheral max stays low while the engine is spawning sparks, the comets\n` +
      `     are off-screen. If it is high, they are on screen and something else is wrong.`,
  );
  await browser.close();
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
