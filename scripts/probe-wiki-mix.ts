/**
 * The live stream's actual wiki mix, weighted by each wiki's on-screen visibility.
 *
 * Two measurements now exist and need joining:
 *
 *  - `probe-home-visibility.ts`: for each wiki, the fraction of the camera's 349 s orbit
 *    during which that wiki's home is inside the frustum. enwiki — which dominates
 *    Wikipedia traffic — is visible only **19 %** of the time; ptwiki, zhwiki, trwiki,
 *    kowiki and elwiki are **never** visible.
 *
 *  - the live stream's own wiki mix, which is what decides how much of the traffic comes
 *    from each home.
 *
 * The product of the two is the fraction of edits that produce a comet a human can
 * actually see.
 */
import { chromium } from "@playwright/test";

const BASE = process.env.SOK_BASE ?? "http://127.0.0.1:3000";

const main = async (): Promise<void> => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${BASE}/?source=replay`);
  await page.getByTestId("enter-button").click({ timeout: 20_000 });
  await page.getByTestId("hud").waitFor({ timeout: 10_000 });

  // Count the wikis the engine actually sees. The replay bundle is a recorded sample
  // of the real stream, so its wiki mix is representative.
  const counts = await page.evaluate(
    `(() => {
      const w = window.__sok;
      if (!w) return null;
      // The HUD ticker exposes the language; the full wiki mix needs the ingest
      // counters, which the engine does not publish per-wiki. So this reads the
      // replay file directly instead.
      return null;
    })()`,
  );
  void counts;

  // Read the replay fixture and count wikis in it.
  const res = await page.evaluate(
    `fetch('/replay/sample.ndjson').then(r => r.text()).then(t => {
      const out = {};
      for (const line of t.split('\\n')) {
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line);
          const w = j.wiki || (j.host || '').split('.')[0] || '?';
          out[w] = (out[w] || 0) + 1;
        } catch { }
      }
      return out;
    })`,
  );
  const mix = (res ?? {}) as Record<string, number>;
  const total = Object.values(mix).reduce((a, b) => a + b, 0);
  console.log(`replay fixture: ${total} edits across ${Object.keys(mix).length} wikis\n`);
  const sorted = Object.entries(mix).sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log("  wiki            edits   share");
  for (const [w, n] of sorted) {
    console.log(`  ${w.padEnd(14)} ${String(n).padStart(5)}   ${((n / total) * 100).toFixed(1)}%`);
  }
  await browser.close();
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
