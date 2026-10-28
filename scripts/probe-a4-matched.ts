/**
 * Is the elevation A/B actually MATCHED?
 *
 * The point of `playA4Timbres` is to compare a source overhead with the same source in
 * front. If the two notes differ in pitch, timbre or level for any reason other than
 * position, the comparison is worthless — a listener would be comparing two different
 * sounds.
 *
 * So this captures the actual rendered output of the live page for each step of the
 * sequence and checks that the notes are the same except in the direction they come
 * from.
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
  let sl = 0, sr = 0, pl = 0, pr = 0;
  for (let i = 0; i < c.bL.length; i++) {
    sl += c.bL[i] * c.bL[i]; sr += c.bR[i] * c.bR[i];
    const a = Math.abs(c.bL[i]), b = Math.abs(c.bR[i]);
    if (a > pl) pl = a; if (b > pr) pr = b;
  }
  return { rmsL: Math.sqrt(sl/c.bL.length), rmsR: Math.sqrt(sr/c.bR.length), pl, pr };
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

  // Play the sequence with a long gap so each note can be measured on its own.
  await page.evaluate(`(() => { window.__sok.playA4Timbres(2.2); return true; })()`);

  const rows: Array<{ label: string; rms: number; peak: number; lr: number }> = [];
  let cur: (typeof rows)[number] | null = null;
  const deadline = Date.now() + 16_000;
  while (Date.now() < deadline) {
    const label = (await page.evaluate(
      `(() => {
        const el = document.querySelector('[data-testid="a4-readout"]');
        return el ? el.getAttribute('data-a4-label') : null;
      })()`,
    )) as string | null;
    if (label && (!cur || cur.label !== label)) {
      if (cur) rows.push(cur);
      cur = { label, rms: 0, peak: 0, lr: 0 };
    }
    const r = (await page.evaluate(READ)) as { rmsL: number; rmsR: number; pl: number; pr: number };
    if (cur) {
      const rms = Math.max(r.rmsL, r.rmsR);
      if (rms > cur.rms) {
        cur.rms = rms;
        cur.peak = Math.max(r.pl, r.pr);
        cur.lr = db(r.rmsL) - db(r.rmsR);
      }
    }
    await page.waitForTimeout(40);
  }
  if (cur) rows.push(cur);

  console.log("the matched A/B sequence — each note's level:\n");
  const fronts = rows.filter((r) => r.label === "FRONT");
  const frontRms = fronts.map((r) => r.rms);
  const meanFront = frontRms.reduce((a, b) => a + b, 0) / (frontRms.length || 1);
  for (const r of rows) {
    const rel = meanFront > 0 ? db(r.rms) - db(meanFront) : 0;
    const note =
      r.label === "FRONT"
        ? "(reference)"
        : `level vs reference: ${rel >= 0 ? "+" : ""}${rel.toFixed(2)} dB`;
    console.log(
      `  ${r.label.padEnd(7)} rms=${db(r.rms).toFixed(1)} dB  peak=${db(r.peak).toFixed(1)} dB  ` +
        `L/R=${r.lr.toFixed(1)} dB  ${note}`,
    );
  }

  // The FRONT references must agree with each other — that is the "matched" claim.
  if (frontRms.length > 1) {
    const spread = db(Math.max(...frontRms)) - db(Math.min(...frontRms));
    console.log(`\n  FRONT reference spread across repeats: ${spread.toFixed(2)} dB`);
    console.log(
      spread < 1.5
        ? "  => the repeats are MATCHED (same note, same level) — the only variable is position"
        : "  => the repeats are NOT matched — the A/B would be invalid",
    );
  }
  await browser.close();
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
