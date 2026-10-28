/**
 * Is "ABOVE sounds duller" true in the signal, and is BELOW really identical to FRONT?
 *
 * The human's report:
 *   FRONTs -> identical          (the control — so the test is sensitive)
 *   ABOVE  -> slightly different, duller
 *   BELOW  -> same
 *
 * "Duller" is a **spectral** claim: a source overhead is shadowed by the head, so it
 * should carry less high frequency. That is directly measurable.
 *
 * And BELOW is the interesting one: the platform measurement said BELOW differs from
 * FRONT *more* than ABOVE does (correlation 0.84 vs 0.96), and the human heard no
 * difference at all. Either the BELOW note is not where it should be, or the human's
 * threshold is above it, or my platform measurement does not carry over to the live
 * graph.
 *
 * So: capture the actual signal of each step of the matched sequence and compare the
 * spectra.
 */
import { chromium } from "@playwright/test";

const BASE = process.env.SOK_BASE ?? "http://127.0.0.1:3000";

const INSTALL = `(() => {
  const eng = window.__sok.engine;
  const ctx = eng.audioEngine.context;
  const master = eng.audioEngine.outputNode;
  const an = ctx.createAnalyser();
  an.fftSize = 32768;
  an.smoothingTimeConstant = 0;
  master.connect(an);
  window.__a4cap = { an, buf: new Float32Array(an.fftSize) };
})()`;

/** The window with the most energy seen so far for the current step. */
const READ = `(() => {
  const c = window.__a4cap;
  c.an.getFloatTimeDomainData(c.buf);
  let e = 0;
  for (let i = 0; i < c.buf.length; i++) e += c.buf[i] * c.buf[i];
  const rms = Math.sqrt(e / c.buf.length);
  if (!c.best || rms > c.best.rms) {
    c.best = { rms, buf: Float32Array.from(c.buf) };
  }
  return { rms, bestRms: c.best ? c.best.rms : 0 };
})()`;

const RESET = `(() => { window.__a4cap.best = null; return true; })()`;

/** Goertzel magnitude of one frequency in a captured window. */
const goertzel = (sig: Float32Array, freq: number, rate: number): number => {
  const n = sig.length;
  const w = (2 * Math.PI * freq) / rate;
  const coeff = 2 * Math.cos(w);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    s0 = (sig[i] ?? 0) + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / n;
};

const db = (v: number): number => (v > 0 ? 20 * Math.log10(v) : -999);

const main = async (): Promise<void> => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${BASE}/?source=synthetic&density=sparse`);
  await page.getByTestId("enter-button").click({ timeout: 20_000 });
  await page.getByTestId("hud").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(800);
  await page.evaluate(INSTALL);

  const rate = (await page.evaluate(
    `(() => window.__sok.engine.audioEngine.context.sampleRate)()`,
  )) as number;

  await page.evaluate(`(() => { window.__sok.playA4Timbres(1.8); return true; })()`);

  const windows: Array<{ label: string; buf: Float32Array }> = [];
  let cur: { label: string; buf: Float32Array } | null = null;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const label = (await page.evaluate(
      `(() => {
        const el = document.querySelector('[data-testid="a4-readout"]');
        return el ? el.getAttribute('data-a4-label') : null;
      })()`,
    )) as string | null;
    if (label && (!cur || cur.label !== label)) {
      if (cur) windows.push(cur);
      cur = { label, buf: new Float32Array(0) };
      await page.evaluate(RESET);
    }
    const r = (await page.evaluate(READ)) as { rms: number; bestRms: number };
    if (cur && r.bestRms > 0) {
      const b = (await page.evaluate(
        `(() => Array.from(window.__a4cap.best.buf))()`,
      )) as number[];
      if (b.length > 0) cur.buf = Float32Array.from(b);
    }
    await page.waitForTimeout(60);
  }
  if (cur) windows.push(cur);

  console.log(`captured ${windows.length} step windows at ${rate} Hz\n`);

  const fronts = windows.filter((w) => w.label === "FRONT" && w.buf.length > 0);
  const above = windows.find((w) => w.label === "ABOVE" && w.buf.length > 0);
  const below = windows.find((w) => w.label === "BELOW" && w.buf.length > 0);

  const freqs = [200, 500, 1000, 2000, 4000, 8000];
  const spectrum = (w: { buf: Float32Array }) =>
    freqs.map((f) => goertzel(w.buf, f, rate));

  // The reference: average the FRONT windows.
  const frontSpecs = fronts.map(spectrum);
  const ref = freqs.map((_, i) => {
    const vals = frontSpecs.map((s) => s[i]!);
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  });

  console.log("spectrum of each step, relative to the FRONT reference (dB):\n");
  const row = (name: string, w: { buf: Float32Array } | undefined) => {
    if (!w) {
      console.log(`  ${name.padEnd(6)} (not captured)`);
      return;
    }
    const s = spectrum(w);
    const rel = s.map((v, i) => db(v) - db(ref[i]!));
    console.log(
      `  ${name.padEnd(6)} ` +
        freqs
          .map((f, i) => {
            const v = rel[i] ?? 0;
            return `${f}Hz:${v >= 0 ? "+" : ""}${v.toFixed(1)}`;
          })
          .join("  "),
    );
  };
  row("FRONT", fronts[0]);
  row("ABOVE", above);
  row("BELOW", below);

  if (above) {
    const s = spectrum(above);
    const rel = s.map((v, i) => db(v) - db(ref[i] ?? 1));
    const hi = rel.slice(3).reduce((a, b) => a + b, 0) / rel.slice(3).length;
    const lo = rel.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
    console.log(
      `\n  ABOVE: low band (200-1000 Hz) ${lo >= 0 ? "+" : ""}${lo.toFixed(1)} dB, ` +
        `high band (2-8 kHz) ${hi >= 0 ? "+" : ""}${hi.toFixed(1)} dB`,
    );
    console.log(
      `  => ${hi < -1 ? "HIGH FREQUENCIES ARE ATTENUATED — 'duller' is confirmed in the signal" : "no high-frequency attenuation — 'duller' is not in the signal"}`,
    );
  }
  if (below) {
    const s = spectrum(below);
    const rel = s.map((v, i) => db(v) - db(ref[i] ?? 1));
    const hi = rel.slice(3).reduce((a, b) => a + b, 0) / rel.slice(3).length;
    console.log(
      `  BELOW: high band (2-8 kHz) ${hi >= 0 ? "+" : ""}${hi.toFixed(1)} dB  => ` +
        `${Math.abs(hi) < 1 ? "no significant change — 'same' is confirmed" : "there IS a change"}`,
    );
  }
  await browser.close();
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
