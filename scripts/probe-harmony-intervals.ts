/**
 * When do the mode, the key and the chord actually change, and by how much?
 *
 * The spec's three intervals, at `BPM = 68` (one bar = 3.53 s):
 *
 *   CHORD  every  4 bars =  14.1 s
 *   MODE   every  8 bars =  28.2 s   <- A9's "~30 s"
 *   KEY    every 32 bars = 112.9 s
 *
 * The MODE can only change *at* a phrase boundary, and only if the energy has crossed
 * a band boundary — so 28.2 s is the *floor* on the observable interval, not a
 * guarantee. This measures what actually happened on the live stream.
 */
import { chromium } from "@playwright/test";

const BASE = process.env.SOK_BASE ?? "http://127.0.0.1:3000";

const main = async (): Promise<void> => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${BASE}/`);
  await page.getByTestId("enter-button").click({ timeout: 20_000 });
  await page.getByTestId("hud").waitFor({ timeout: 10_000 });

  const t0 = Date.now();
  const changes: Array<{ t: number; kind: string; value: string; e: number }> = [];
  let lastMode = "";
  let lastKey = "";
  let lastChord = "";

  console.log("live stream, sampling every 250 ms for 5 minutes:\n");
  while (Date.now() - t0 < 300_000) {
    await page.waitForTimeout(250);
    const s = (await page.evaluate(
      `(() => {
        const h = window.__sok.engine.getHarmonyStats();
        return h ? { mode: h.mode, key: h.keyName, chord: h.chordName, e: h.energy, bar: h.bar } : null;
      })()`,
    )) as { mode: string; key: string; chord: string; e: number; bar: number } | null;
    if (!s) continue;
    const t = (Date.now() - t0) / 1000;
    if (s.mode !== lastMode) {
      changes.push({ t, kind: "MODE", value: s.mode, e: s.e });
      lastMode = s.mode;
    }
    if (s.key !== lastKey) {
      changes.push({ t, kind: "KEY", value: s.key, e: s.e });
      lastKey = s.key;
    }
    if (s.chord !== lastChord) {
      changes.push({ t, kind: "CHORD", value: s.chord, e: s.e });
      lastChord = s.chord;
    }
  }

  console.log("  t (s)   kind   value        E");
  for (const c of changes) {
    console.log(
      `  ${c.t.toFixed(1).padStart(6)}  ${c.kind.padEnd(6)} ${c.value.padEnd(12)} E=${c.e.toFixed(3)}`,
    );
  }

  const modes = changes.filter((c) => c.kind === "MODE");
  const keys = changes.filter((c) => c.kind === "KEY");
  const chords = changes.filter((c) => c.kind === "CHORD");

  const gaps = (xs: typeof changes): number[] =>
    xs.map((x, i) => (i === 0 ? NaN : x.t - xs[i - 1]!.t)).filter((n) => !Number.isNaN(n));
  const fmt = (g: number[]): string =>
    g.length === 0
      ? "none observed"
      : `min ${Math.min(...g).toFixed(1)}s  max ${Math.max(...g).toFixed(1)}s  mean ${(
          g.reduce((a, b) => a + b, 0) / g.length
        ).toFixed(1)}s`;

  console.log(`\n  MODE changes:  ${modes.length}  gaps: ${fmt(gaps(modes))}   (spec floor 28.2 s)`);
  console.log(`  KEY changes:   ${keys.length}  gaps: ${fmt(gaps(keys))}   (spec 112.9 s)`);
  console.log(`  CHORD changes: ${chords.length}  gaps: ${fmt(gaps(chords))}   (spec 14.1 s)`);
  await browser.close();
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
