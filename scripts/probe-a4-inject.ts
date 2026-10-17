/**
 * Verify the A4 human-check method actually works, before handing it to anyone.
 *
 * T6.6. Proves that a single edit injected into the live page produces exactly one
 * scheduled note and one visual — i.e. that the console snippet offered for A4 is
 * real and not a plausible-looking object literal that the pipeline silently drops.
 *
 * Run: `npx tsx scripts/probe-a4-inject.ts`
 */
import { chromium } from "@playwright/test";

const BASE = process.env.SOK_BASE ?? "http://127.0.0.1:3000";

const edit = (over: Record<string, unknown> = {}) => ({
  id: 4242,
  ts: Date.now(),
  wiki: "enwiki",
  host: "en.wikipedia.org",
  lang: "en",
  project: "wikipedia",
  ns: 0,
  title: "A4 Direction Probe",
  actor: "registered",
  kind: "edit",
  minor: false,
  delta: 400,
  absDelta: 400,
  magnitude: 0.5,
  importance: 0.5,
  revNew: 1,
  ...over,
});

const run = async (): Promise<void> => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  // NOT `?debug=1` — that renders the debug harness, which has no Enter button.
  // `window.__sok` is assigned by `experience.tsx` on the normal page too, after Enter.
  await page.goto(`${BASE}/?source=synthetic&density=sparse`);
  await page.getByTestId("enter-button").click({ timeout: 20_000 });
  await page.getByTestId("hud").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(1_500);

  const readMetrics = () =>
    page.evaluate(() => {
      const m = (window as unknown as { __sok?: { metrics?: () => unknown } }).__sok?.metrics?.();
      return m as { notesScheduled: number; visualQueueLen: number; droppedNotes: number } | undefined;
    });

  const before = await readMetrics();
  console.log("  before inject:", JSON.stringify(before));

  // Wait for any synthetic traffic to settle so the delta is attributable.
  await page.waitForTimeout(1_200);
  const baseline = await readMetrics();

  await page.evaluate((e) => {
    const w = window as unknown as { __sok?: { injectEdits?: (x: unknown[]) => void } };
    w.__sok?.injectEdits?.([e]);
  }, edit());

  await page.waitForTimeout(2_500);
  const after = await readMetrics();
  console.log("  baseline    :", JSON.stringify(baseline));
  console.log("  after 1 edit:", JSON.stringify(after));

  const dNotes = (after?.notesScheduled ?? 0) - (baseline?.notesScheduled ?? 0);
  const dVisual = (after?.visualQueueLen ?? 0) - (baseline?.visualQueueLen ?? 0);
  console.log(`\n  delta notes scheduled: ${dNotes}`);
  console.log(`  delta visual queue   : ${dVisual}`);
  console.log(`  page errors          : ${errors.length === 0 ? "none" : errors.join("; ")}`);

  const ok = dNotes >= 1;
  console.log(`\n  ${ok ? "PASS — injection reaches the scheduler" : "FAIL — injection did NOT produce a note"}`);

  await browser.close();
  process.exit(ok ? 0 : 1);
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
