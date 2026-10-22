/**
 * Does the harmony actually drift on the live page?
 *
 * The human watched for 3-4 minutes and the HUD showed the same mode and the same
 * edits/s throughout, with the key shown as "—".
 *
 * Two separate questions:
 *  1. Is the **harmony** frozen? The mode is a function of energy, so a frozen mode
 *     means a frozen energy — which may be correct if the traffic rate is steady.
 *  2. Is the **HUD** frozen? `metrics.mode` and `metrics.keyName` are read but never
 *     assigned, so the readout may be showing hardcoded initial values regardless of
 *     what the engine is doing.
 *
 * So this samples the live page's *own* metrics and, separately, the engine's internal
 * harmony state, so the two can be compared.
 */
import { chromium } from "@playwright/test";

const BASE = process.env.SOK_BASE ?? "http://127.0.0.1:3000";

const main = async (): Promise<void> => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${BASE}/`); // the LIVE stream
  await page.getByTestId("enter-button").click({ timeout: 20_000 });
  await page.getByTestId("hud").waitFor({ timeout: 10_000 });

  console.log("sampling the live page every 2 s for 3 minutes:\n");
  console.log("   t     eps  energy   HUD mode      HUD key   harmony mode/key");

  const seenModes = new Set<string>();
  const seenKeys = new Set<string>();
  const seenHarmonyModes = new Set<string>();
  const seenHarmonyKeys = new Set<string>();
  const seenChords = new Set<string>();
  const energies: number[] = [];

  for (let t = 0; t <= 90; t++) {
    await page.waitForTimeout(2_000);
    const s = (await page.evaluate(
      `(() => {
        const m = window.__sok.metrics();
        const eng = window.__sok.engine;
        // The scheduler's OWN view of the harmony, straight from the source — the HUD
        // readout was frozen at placeholder values, so it could not be trusted to
        // answer this question.
        const h = eng.getHarmonyStats ? eng.getHarmonyStats() : null;
        return {
          eps: m.eps ?? null,
          energy: m.energy,
          mode: m.mode,
          keyName: m.keyName,
          hMode: h ? h.mode : "n/a",
          hKey: h ? h.keyName : "n/a",
          hChord: h ? h.chordName : "n/a",
          hEnergy: h ? h.energy : -1,
          hBar: h ? h.bar : -1,
        };
      })()`,
    )) as {
      eps: number | null;
      energy: number;
      mode: string;
      keyName: string;
      hMode: string;
      hKey: string;
      hChord: string;
      hEnergy: number;
      hBar: number;
    };

    seenModes.add(s.mode);
    seenKeys.add(s.keyName);
    seenHarmonyModes.add(String(s.hMode));
    seenHarmonyKeys.add(String(s.hKey));
    seenChords.add(String(s.hChord));
    energies.push(s.hEnergy);

    if (t % 5 === 0) {
      console.log(
        `  ${String(t * 2).padStart(4)}s  eps ${String(s.eps ?? "?").padStart(4)}  ` +
          `E=${s.hEnergy.toFixed(3)}  HUD ${s.mode.padEnd(11)} ${s.keyName.padEnd(4)}  ` +
          `HARMONY ${s.hMode.padEnd(11)} ${s.hKey.padEnd(4)} ${s.hChord.padEnd(10)} bar ${s.hBar}`,
      );
    }
  }

  const minE = Math.min(...energies);
  const maxE = Math.max(...energies);
  console.log(`\n  energy range over the run: ${minE.toFixed(3)} … ${maxE.toFixed(3)}`);
  console.log(`  distinct HUD modes:       ${[...seenModes].join(", ")}`);
  console.log(`  distinct HUD keys:        ${[...seenKeys].join(", ")}`);
  console.log(`  distinct HARMONY modes:   ${[...seenHarmonyModes].join(", ")}`);
  console.log(`  distinct HARMONY keys:    ${[...seenHarmonyKeys].join(", ")}`);
  console.log(`  distinct HARMONY chords:  ${[...seenChords].join(", ")}`);
  console.log(
    `\n  => the harmony ${seenHarmonyModes.size > 1 || seenHarmonyKeys.size > 1 ? "IS" : "is NOT"} drifting`,
  );
  console.log(
    `  => the HUD ${seenModes.size > 1 || seenKeys.size > 1 ? "IS" : "is NOT"} reflecting it`,
  );
  await browser.close();
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
