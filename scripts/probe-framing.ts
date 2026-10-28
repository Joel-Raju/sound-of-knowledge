/**
 * The framing comparison, over a FULL orbit.
 *
 * The camera orbits at 0.03 rad/s, so a revolution is **349 s**. A 40 s window covers
 * 69° of it — about a fifth — which is why the first attempt at this comparison
 * produced 17 %, 16 % and 10 % for three configurations that differ enormously: each
 * was sampling a different fifth of the same orbit, not a different camera.
 *
 * So this runs each configuration for a complete revolution, from the same starting
 * yaw, and reports the traffic-weighted visible fraction.
 */
import { chromium } from "@playwright/test";

const BASE = process.env.SOK_BASE ?? "http://127.0.0.1:3000";
const ORBIT_SEC = 349;

const CONFIGS: Array<[string, string]> = [
  ["default (§9.1: radius 5.5, FOV 58°)", ""],
  ["radius 14 (outside the shell)", "?camRadius=14"],
  ["FOV 90 (camera stays inside)", "?fov=90"],
  ["radius 14 + FOV 75", "?camRadius=14&fov=75"],
];

const main = async (): Promise<void> => {
  const browser = await chromium.launch();
  console.log(`one full orbit = ${ORBIT_SEC} s per configuration\n`);
  console.log("  configuration                          fired  visible   %");

  for (const [label, q] of CONFIGS) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(`${BASE}/${q}`);
    await page.getByTestId("enter-button").click({ timeout: 20_000 });
    await page.getByTestId("hud").waitFor({ timeout: 10_000 });
    await page.waitForTimeout(3_000);
    await page.evaluate(`(() => { window.__sok.resetVisibilityCounters(); return true; })()`);

    const t0 = Date.now();
    while (Date.now() - t0 < ORBIT_SEC * 1000) {
      await page.waitForTimeout(5_000);
    }
    const v = (await page.evaluate(
      `(() => window.__sok.getNoteVisibility(200))()`,
    )) as { sessionFired: number; sessionOnScreen: number; sessionFraction: number };

    console.log(
      `  ${label.padEnd(38)} ${String(v.sessionFired).padStart(5)}  ${String(
        v.sessionOnScreen,
      ).padStart(7)}  ${(v.sessionFraction * 100).toFixed(0).padStart(3)}%`,
    );
    await page.close();
  }
  await browser.close();
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
