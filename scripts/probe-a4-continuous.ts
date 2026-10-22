/**
 * Measure the pan per step, sampling CONTINUOUSLY across each step's window.
 *
 * The previous probe measured a fixed 700 ms window starting 350 ms after the label
 * appeared. But the label appears when the calibration step fires, while the *note* is
 * picked by the probabilistic sampler and may sound up to a second later — so the
 * window could easily contain only the previous note's tail.
 *
 * This polls every 50 ms from one label change to the next and keeps the extreme
 * difference seen, which captures the note wherever in the window it lands.
 */
import { chromium } from "@playwright/test";

const BASE = process.env.SOK_BASE ?? "http://127.0.0.1:3000";

const INSTALL = `(() => {
  const eng = window.__sok.engine;
  const ctx = eng.audioEngine.context;
  const master = eng.audioEngine.outputNode;
  const sp = ctx.createChannelSplitter(2);
  master.connect(sp);
  const aL = ctx.createAnalyser(); const aR = ctx.createAnalyser();
  aL.fftSize = 2048; aR.fftSize = 2048;
  sp.connect(aL, 0); sp.connect(aR, 1);
  window.__a4cap = { aL, aR, bL: new Float32Array(2048), bR: new Float32Array(2048) };
})()`;

const READ = `(() => {
  const c = window.__a4cap;
  c.aL.getFloatTimeDomainData(c.bL);
  c.aR.getFloatTimeDomainData(c.bR);
  let sl = 0, sr = 0;
  for (let i = 0; i < c.bL.length; i++) {
    sl += c.bL[i] * c.bL[i];
    sr += c.bR[i] * c.bR[i];
  }
  return { rmsL: Math.sqrt(sl / c.bL.length), rmsR: Math.sqrt(sr / c.bR.length) };
})()`;

const db = (v: number): number => (v > 0 ? 20 * Math.log10(v) : -999);

const main = async (): Promise<void> => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${BASE}/?source=synthetic&density=sparse`);
  await page.getByTestId("enter-button").click({ timeout: 20_000 });
  await page.getByTestId("hud").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(800);
  await page.evaluate(INSTALL);

  // Bypass the reverb and delay sends. Their tails are LONG and, more importantly,
  // they are fed by every earlier note — so a measurement of "the current step" is
  // really a measurement of the whole history, which is why every step showed the
  // same ~30 dB left excess. With the sends off, only the current note is heard.
  await page.evaluate(`(() => {
    window.__sok.engine.audioEngine.bypassFx(["reverb", "delay"], true);
    return true;
  })()`);

  await page.evaluate(`(() => { window.__sok.runA4Calibration({ gapMs: 3500 }); return true; })()`);

  const rows: Array<{
    label: string;
    maxLeft: number;
    maxRight: number;
    best: number;
  }> = [];
  let cur: (typeof rows)[number] | null = null;
  const deadline = Date.now() + 32_000;
  while (Date.now() < deadline) {
    const label = (await page.evaluate(
      `(() => {
        const el = document.querySelector('[data-testid="a4-readout"]');
        return el ? el.getAttribute('data-a4-label') : null;
      })()`,
    )) as string | null;
    if (label && (!cur || cur.label !== label)) {
      if (cur) rows.push(cur);
      cur = { label, maxLeft: 0, maxRight: 0, best: 0 };
    }
    const r = (await page.evaluate(READ)) as { rmsL: number; rmsR: number };
    if (cur) {
      // **Ignore silence.** A source directly ahead or behind puts almost nothing in
      // either channel at some instants, and the ratio between two near-zero numbers is
      // meaningless — it produced "845 dB" differences. Only compare when the louder
      // channel is above a real floor.
      const louder = Math.max(r.rmsL, r.rmsR);
      if (louder < 1e-4) {
        await page.waitForTimeout(50);
        continue;
      }
      const dL = db(r.rmsL) - db(r.rmsR);
      // Keep the largest excursion in each direction.
      if (dL > cur.maxLeft) cur.maxLeft = dL;
      if (-dL > cur.maxRight) cur.maxRight = -dL;
    }
    await page.waitForTimeout(50);
  }
  if (cur) rows.push(cur);

  console.log("per-step channel difference, sampled continuously through each step:\n");
  for (const r of rows) {
    const side = r.maxRight > r.maxLeft ? "RIGHT" : "LEFT";
    const mag = Math.max(r.maxLeft, r.maxRight);
    console.log(
      `  ${r.label.padEnd(7)}  maxL-minusR=${r.maxLeft.toFixed(2)} dB  ` +
        `maxR-minusL=${r.maxRight.toFixed(2)} dB  -> strongest on ${side} by ${mag.toFixed(2)} dB`,
    );
  }
  await browser.close();
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
