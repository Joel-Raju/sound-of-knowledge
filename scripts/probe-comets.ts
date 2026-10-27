/**
 * Where do the comets stop?
 *
 * The human: "I see the comet in the first 5 seconds and then no more."
 *
 * The chain is: edit → sampler → scheduler → note booked → visual queued → visual
 * drained at heard-time → §10.2 fires the spark. Any of those five links can break, and
 * they fail differently:
 *
 *   notes stop rising      → the sampler or the scheduler stopped
 *   notes rise, queue flat → the queue is being drained but nothing is firing
 *   queue grows            → the heard-time gate is not releasing
 *   sparks stop            → §10.2 stopped spawning
 *
 * So this samples all of them together, every second, for 60 s.
 */
import { chromium } from "@playwright/test";

const BASE = process.env.SOK_BASE ?? "http://127.0.0.1:3000";

const main = async (): Promise<void> => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });

  await page.goto(`${BASE}/`);
  await page.getByTestId("enter-button").click({ timeout: 20_000 });
  await page.getByTestId("hud").waitFor({ timeout: 10_000 });

  console.log("   t     notes  vQueue   sparks  impacts  audio   stream");
  let prev = { notes: 0, sparks: 0, impacts: 0 };
  for (let t = 0; t < 60; t++) {
    await page.waitForTimeout(1_000);
    const s = (await page.evaluate(
      `(() => {
        const m = window.__sok.metrics();
        const v = window.__sok.engine.getVisualCounts();
        return {
          notes: m.notesScheduled, q: m.visualQueueLen, sparks: v.sparks,
          impacts: v.orbImpacts, audio: m.audioState, stream: m.streamState,
          e: m.energy, mode: m.mode,
        };
      })()`,
    )) as {
      notes: number; q: number; sparks: number; impacts: number;
      audio: string; stream: string; e: number; mode: string;
    };
    if (t % 3 === 0) {
      console.log(
        `  ${String(t).padStart(3)}s  ${String(s.notes).padStart(5)}  ${String(s.q).padStart(6)}  ` +
          `${String(s.sparks - prev.sparks).padStart(6)}  ${String(s.impacts - prev.impacts).padStart(6)}  ` +
          `${s.audio.padEnd(7)} ${s.stream.padEnd(8)} E=${s.e.toFixed(2)} ${s.mode}`,
      );
    }
    prev = { notes: s.notes, sparks: s.sparks, impacts: s.impacts };
  }

  console.log(`\n  page errors: ${errors.length === 0 ? "none" : errors.slice(0, 3).join(" | ")}`);
  await browser.close();
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
