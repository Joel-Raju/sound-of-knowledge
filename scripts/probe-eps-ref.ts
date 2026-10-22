/**
 * §7.3's calibration, from the engine's own numbers.
 *
 * §7.3: "`EPS_REF ≈ 1.5 × p95(eps)` measured over 60 s of live Wikipedias-only
 * traffic."
 *
 * The value in `engine/config.ts` is 15, calibrated at T1.1 from the *raw* stream probe
 * (`scripts/probe-stream.ts`) — a different filter and a different point in the pipeline
 * than the one the engine's `EnergyTracker` sees. Now that the tracker is actually
 * wired, the engine's own accepted rate is the right thing to calibrate against.
 *
 * The earlier attempt at this probe read `metrics.eps`, which **does not exist on the
 * Metrics interface** — it is on the `stats` event. So it printed zeros and measured
 * nothing. This one reads the HUD's own readout, which is the number a human sees.
 */
import { chromium } from "@playwright/test";

const BASE = process.env.SOK_BASE ?? "http://127.0.0.1:3000";

const main = async (): Promise<void> => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${BASE}/`);
  await page.getByTestId("enter-button").click({ timeout: 20_000 });
  await page.getByTestId("hud").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(3_000);

  const eps: number[] = [];
  const energies: number[] = [];
  console.log("reading the HUD's own edits/s for 60 s:\n");
  for (let t = 0; t < 60; t++) {
    await page.waitForTimeout(1_000);
    const s = (await page.evaluate(
      `(() => {
        const el = document.querySelector('[data-testid="hud-status"]');
        const h = window.__sok.engine.getHarmonyStats();
        const m = /·\\s*([\\d.]+)\\s*edits\\/s/.exec(el ? el.textContent || "" : "");
        return { eps: m ? parseFloat(m[1]) : NaN, e: h ? h.energy : -1 };
      })()`,
    )) as { eps: number; e: number };
    if (Number.isFinite(s.eps)) {
      eps.push(s.eps);
      energies.push(s.e);
    }
    if (t % 10 === 0) {
      console.log(`  ${String(t).padStart(2)}s  eps=${s.eps}  E=${s.e.toFixed(3)}`);
    }
  }

  if (eps.length < 30) {
    console.log(`\n  only ${eps.length} samples — the HUD's readout was not parseable.`);
    await browser.close();
    return;
  }

  const sorted = [...eps].sort((a, b) => a - b);
  const q = (p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
  const mean = eps.reduce((a, b) => a + b, 0) / eps.length;

  console.log(`\n  the engine's accepted edits/s over ${eps.length} s:`);
  console.log(
    `    mean ${mean.toFixed(2)}  p50 ${q(0.5).toFixed(2)}  p90 ${q(0.9).toFixed(2)}  ` +
      `p95 ${q(0.95).toFixed(2)}  max ${sorted[sorted.length - 1]!.toFixed(2)}`,
  );
  console.log(`    measured E: min ${Math.min(...energies).toFixed(3)}  max ${Math.max(...energies).toFixed(3)}`);

  const rateToEnergy = (e: number, ref: number): number => {
    if (e <= 0) return 0;
    const d = Math.log10(1 + ref);
    if (d <= 0) return 0;
    const v = Math.log10(1 + e) / d;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  };

  console.log(`\n  §7.3's rule — EPS_REF = 1.5 × p95(eps) = ${(1.5 * q(0.95)).toFixed(1)}:`);
  const proposed = Math.max(15, Math.round(1.5 * q(0.95)));
  for (const ref of [15, proposed, 60]) {
    const atMean = rateToEnergy(mean, ref);
    const atP95 = rateToEnergy(q(0.95), ref);
    const atP50 = rateToEnergy(q(0.5), ref);
    const band = (e: number): string =>
      e < 0.22 ? "aeolian" : e < 0.45 ? "dorian" : e < 0.7 ? "mixolydian" : "lydian";
    console.log(
      `    EPS_REF ${String(ref).padStart(3)}:  E(p50)=${atP50.toFixed(2)} ${band(atP50).padEnd(11)}` +
        ` E(mean)=${atMean.toFixed(2)} ${band(atMean).padEnd(11)} E(p95)=${atP95.toFixed(2)} ${band(atP95)}`,
    );
  }
  console.log(`\n  => the mode bands are aeolian E<0.22 | dorian E<0.45 | mixolydian E<0.70 | lydian else`);
  await browser.close();
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
