/**
 * Calibrate `EPS_REF` against the live stream, as §7.3 says.
 *
 * §7.3: "`EPS_REF ≈ 1.5 × p95(eps)` measured over 60 s of live Wikipedias-only
 * traffic."
 *
 * The value in `engine/config.ts` is **15**, calibrated at T1.1 from the *raw* stream
 * probe (`scripts/probe-stream.ts`), which measured "Wikipedias + edit|new = mean
 * 5.9/s, p95 10/s" — a figure from a *different* filter and a different point in the
 * pipeline than the one the engine's own EnergyTracker sees.
 *
 * The consequence, now measured: the live stream's **accepted** rate saturates
 * `E = rateToEnergy(eps, 15)` at **1.000** within seconds, which pins the mode at
 * lydian and the note density at its maximum. The modes below lydian become
 * unreachable — which is exactly what B9 asks about.
 *
 * This measures what the *engine* sees, over 60 s, and computes p95 from it.
 */
import { chromium } from "@playwright/test";

const BASE = process.env.SOK_BASE ?? "http://127.0.0.1:3000";

const main = async (): Promise<void> => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${BASE}/`);
  await page.getByTestId("enter-button").click({ timeout: 20_000 });
  await page.getByTestId("hud").waitFor({ timeout: 10_000 });

  // 60 s of 1 s samples of the engine's own accepted-rate figure.
  const eps: number[] = [];
  console.log("sampling the engine's accepted edits/s for 60 s:\n");
  for (let t = 0; t < 60; t++) {
    await page.waitForTimeout(1_000);
    const s = (await page.evaluate(
      `(() => {
        const m = window.__sok.metrics();
        const h = window.__sok.engine.getHarmonyStats();
        return { eps: m.eps ?? 0, e: h ? h.energy : -1, mode: m.mode, notes: m.notesScheduled };
      })()`,
    )) as { eps: number; e: number; mode: string; notes: number };
    eps.push(s.eps);
    if (t % 10 === 0) {
      console.log(
        `  ${String(t).padStart(2)}s  eps=${s.eps.toFixed(1)}  E=${s.e.toFixed(3)}  ` +
          `mode=${s.mode.padEnd(11)} notes=${s.notes}`,
      );
    }
  }

  const sorted = [...eps].sort((a, b) => a - b);
  const p = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  const mean = eps.reduce((a, b) => a + b, 0) / eps.length;

  console.log("\n  the engine's accepted edits/s over 60 s:");
  console.log(`    mean ${mean.toFixed(2)}   p50 ${p(0.5).toFixed(2)}   p90 ${p(0.9).toFixed(2)}   p95 ${p(0.95).toFixed(2)}   max ${sorted[sorted.length - 1]!.toFixed(2)}`);

  const EPS_REF = 15;
  const rateToEnergy = (e: number, ref: number): number => {
    if (e <= 0) return 0;
    const d = Math.log10(1 + ref);
    if (d <= 0) return 0;
    const v = Math.log10(1 + e) / d;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  };

  console.log(`\n  with EPS_REF = ${EPS_REF} (the current value):`);
  for (const [name, v] of [
    ["p50", p(0.5)],
    ["p90", p(0.9)],
    ["p95", p(0.95)],
    ["mean", mean],
  ] as Array<[string, number]>) {
    console.log(`    E at ${name.padEnd(5)} (${v.toFixed(1)} eps) = ${rateToEnergy(v, EPS_REF).toFixed(3)}`);
  }
  const eMean = rateToEnergy(mean, EPS_REF);
  const eP95 = rateToEnergy(p(0.95), EPS_REF);
  console.log(
    `    => mean E is ${eMean.toFixed(3)} and p95 E is ${eP95.toFixed(3)}` +
      `${eP95 >= 1 ? "  — SATURATED" : ""}`,
  );

  console.log(`\n  §7.3's rule — EPS_REF = 1.5 × p95(eps) = ${(1.5 * p(0.95)).toFixed(1)}:`);
  const proposed = Math.max(15, Math.round(1.5 * p(0.95)));
  for (const [name, v] of [
    ["p50", p(0.5)],
    ["mean", mean],
    ["p95", p(0.95)],
  ] as Array<[string, number]>) {
    console.log(`    with EPS_REF = ${proposed}:  E at ${name.padEnd(5)} = ${rateToEnergy(v, proposed).toFixed(3)}`);
  }
  console.log(
    `\n  => the mode bands are aeolian E<0.22 | dorian E<0.45 | mixolydian E<0.70 | lydian else`,
  );
  console.log(
    `  => with EPS_REF = ${proposed}, the mean traffic sits at E = ` +
      `${rateToEnergy(mean, proposed).toFixed(3)} and the p95 at E = ` +
      `${rateToEnergy(p(0.95), proposed).toFixed(3)} — so the mode can move between bands.`,
  );
  console.log(`\n  B9's provisional value was 60: E at mean = ${rateToEnergy(mean, 60).toFixed(3)}`);
  await browser.close();
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
