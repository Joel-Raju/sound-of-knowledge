/**
 * What changes at ~5 seconds?
 *
 * The human reports comets in the **first 5 seconds** and then none — in *every*
 * configuration, including one where 84 % of comets are inside the frustum. If 84 % were
 * visible you would see one per second. So the visibility fraction is not what stops
 * them; something else begins at about five seconds.
 *
 * Candidates, all of which land around the same time:
 *   - the live stream connects and the traffic starts
 *   - the camera's entrance ends at 2.5 s and the orbit carries the visible set away
 *   - the energy tracker warms up and the note rate jumps
 *   - the master fade finishes at 2.5 s
 *
 * So this samples the *windowed* visible fraction, the note rate and the camera pose
 * together, every 2 s for two minutes. The shape of the curve says which.
 */
import { chromium } from "@playwright/test";

const BASE = process.env.SOK_BASE ?? "http://127.0.0.1:3000";

const main = async (): Promise<void> => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${BASE}/`);
  await page.getByTestId("enter-button").click({ timeout: 20_000 });
  await page.getByTestId("hud").waitFor({ timeout: 10_000 });

  console.log("   t     notes   windowed visible   E      camera radius  yaw(deg)  stream");
  let prevNotes = 0;

  for (let t = 0; t < 60; t++) {
    await page.waitForTimeout(2_000);
    const s = (await page.evaluate(
      `(() => {
        const m = window.__sok.metrics();
        const e = window.__sok.engine;
        const v = e.getNoteVisibility(40);
        const r = e.visualEngine.rig;
        return {
          notes: m.notesScheduled, on: v.onScreen, tot: v.total,
          e: m.energy, stream: m.streamState,
          radius: Math.hypot(r.position.x, r.position.y, r.position.z),
          yaw: Math.atan2(r.position.z, r.position.x) * 180 / Math.PI,
        };
      })()`,
    )) as {
      notes: number; on: number; tot: number; e: number; stream: string;
      radius: number; yaw: number;
    };
    const rate = s.notes - prevNotes;
    prevNotes = s.notes;
    console.log(
      `  ${String(t * 2).padStart(4)}s  ${String(rate).padStart(5)}   ` +
        `${String(s.on).padStart(3)}/${String(s.tot).padEnd(3)} = ${(
          (s.on / (s.tot || 1)) * 100
        ).toFixed(0).padStart(3)}%   ${s.e.toFixed(2)}   ${s.radius.toFixed(2).padStart(6)}   ` +
        `${s.yaw.toFixed(0).padStart(7)}   ${s.stream}`,
    );
  }
  await browser.close();
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
