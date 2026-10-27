/**
 * Capture the three framings, side by side, so they can be *looked at*.
 *
 * A framing decision is settled by looking, not by reading a percentage.
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.SOK_BASE ?? "http://127.0.0.1:3000";
const OUT = "artifacts/shots/framing";

const CONFIGS: Array<[string, string]> = [
  ["a-default", ""],
  ["b-radius14", "?camRadius=14"],
  ["c-fov90", "?fov=90"],
];

const main = async (): Promise<void> => {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();

  for (const [name, q] of CONFIGS) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(`${BASE}/${q}`);
    await page.getByTestId("enter-button").click({ timeout: 20_000 });
    await page.getByTestId("hud").waitFor({ timeout: 10_000 });
    // Let the entrance finish and a few edits arrive.
    await page.waitForTimeout(12_000);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    const s = (await page.evaluate(
      `(() => {
        const e = window.__sok.engine;
        const r = e.visualEngine.rig;
        return { radius: Math.hypot(r.position.x, r.position.y, r.position.z), fov: e.visualEngine.camera.fov };
      })()`,
    )) as { radius: number; fov: number };
    console.log(`  ${name.padEnd(14)} radius=${s.radius.toFixed(2)}  fov=${s.fov.toFixed(0)}`);
    await page.close();
  }
  console.log(`\nwrote frames to ${OUT}/`);
  await browser.close();
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
