/**
 * Does the flavour demo actually produce the five voices, and their visuals?
 *
 * A5, A7 and A8 ask about specific event types. The demo forces them — but only the
 * *flavour* is forced, and everything else has to go through the real path. So this
 * checks that the demo's five edits really do reach the scheduler and really do produce
 * the notes and the visual effects §10.2 specifies.
 */
import { chromium } from "@playwright/test";

const BASE = process.env.SOK_BASE ?? "http://127.0.0.1:3000";

const main = async (): Promise<void> => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(`${BASE}/?source=synthetic&density=sparse`);
  await page.getByTestId("enter-button").click({ timeout: 20_000 });
  await page.getByTestId("hud").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(1_000);

  const before = (await page.evaluate(
    `(() => {
      const m = window.__sok.metrics();
      return { notes: m.notesScheduled, dropped: m.droppedNotes, visual: m.visualQueueLen };
    })()`,
  )) as { notes: number; dropped: number; visual: number };

  await page.evaluate(`(() => { window.__sok.playFlavorDemo(3); return true; })()`);

  const seen: Array<{ label: string; notes: number; rings: number; sparks: number; impacts: number }> = [];
  let cur: (typeof seen)[number] | null = null;
  const deadline = Date.now() + 24_000;
  while (Date.now() < deadline) {
    const s = (await page.evaluate(
      `(() => {
        const el = document.querySelector('[data-testid="a4-readout"]');
        const m = window.__sok.metrics();
        const vc = window.__sok.engine.getVisualCounts();
        const rings = vc.rings, sparks = vc.sparks, impacts = vc.orbImpacts;
        return {
          label: el ? el.getAttribute('data-a4-label') : null,
          notes: m.notesScheduled,
          visual: m.visualQueueLen,
          rings, sparks, impacts,
        };
      })()`,
    )) as {
      label: string | null;
      notes: number;
      visual: number;
      rings: number;
      sparks: number;
      impacts: number;
    };
    if (s.label && (!cur || cur.label !== s.label)) {
      if (cur) seen.push(cur);
      cur = { label: s.label, notes: s.notes, rings: s.rings, sparks: s.sparks, impacts: s.impacts };
    }
    if (cur) {
      cur.notes = s.notes;
      cur.rings = s.rings;
      cur.sparks = s.sparks;
      cur.impacts = s.impacts;
    }
    await page.waitForTimeout(80);
  }
  if (cur) seen.push(cur);

  console.log("flavour demo — notes and visuals at each step:\n");
  let prev = before.notes;
  let prevRings = 0;
  let prevSparks = 0;
  for (const r of seen) {
    const delta = r.notes - prev;
    prev = r.notes;
    console.log(
      `  ${r.label.padEnd(24)} notes: +${delta}  rings: +${r.rings - prevRings}  ` +
        `sparks: +${r.sparks - prevSparks}`,
    );
    prevRings = r.rings;
    prevSparks = r.sparks;
  }
  console.log(`\n  total notes: ${before.notes} -> ${prev}`);
  console.log(`  dropped notes: ${before.dropped} -> ${(await page.evaluate(
    `(() => window.__sok.metrics().droppedNotes)()`,
  )) as number}`);
  console.log(`  page errors: ${errors.length === 0 ? "none" : errors.join("; ")}`);

  const fired = await page.evaluate(
    `(() => (window.__sok.getA4Fired ? window.__sok.getA4Fired() : []))()`,
  );
  console.log(`\n  steps announced: ${(fired as string[]).length}`);
  for (const f of fired as string[]) console.log(`    ${f}`);
  await browser.close();
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
