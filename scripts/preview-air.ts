/**
 * Air-layer A/B preview. Tuning aid, not a gate.
 *
 * Renders short clips at several air levels from a single build and prints the
 * §8.4 high-band share for each, so the level can be chosen **by ear** rather
 * than by arithmetic. This exists because the previous tuning decision — meet
 * §8.4's 5–25 % high-band target — produced a mix a human reported as "strong
 * hiss". The numbers were green; the ears were not. This is how to avoid
 * repeating that.
 *
 * Usage: npx tsx scripts/preview-air.ts [seconds] [rateMul]
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "artifacts/audio");
const PORT = Number(process.env.SOK_PORT ?? 4321);
const seconds = Number(process.argv[2] ?? 25);
const rateMul = Number(process.argv[3] ?? 0.306);

/**
 * Levels to compare, chosen around the configured `AIR_GAIN_MAX`.
 * 0.15 is the shipped value; 0.55 is the pre-fix level that read as hiss.
 */
const LEVELS: [string, number][] = [
  ["a-none", 0.0],
  ["b-subtle", 0.06],
  ["c-shipped", 0.15],
  ["d-warmer", 0.3],
  ["e-hiss", 0.55],
];

const server = spawn("npm", ["run", "start", "--", "--port", String(PORT)], {
  cwd: ROOT,
  stdio: "ignore",
});
const done = (c: number): never => {
  server.kill("SIGTERM");
  process.exit(c);
};

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/?debug=1`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("server did not start");
}

interface R {
  bandShare: { sub: number; bass: number; mid: number; high: number; air: number };
  rmsDb: number;
  peakDb: number;
  crestDb: number;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await waitForServer();
  const browser = await chromium.launch({
    args: ["--use-angle=swiftshader", "--autoplay-policy=no-user-gesture-required"],
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/?debug=1&source=synthetic`);
  await page.waitForFunction(
    () => (window as unknown as { __sokReady?: boolean }).__sokReady === true,
    {
      timeout: 60_000,
    },
  );

  const rows: [string, number, R][] = [];
  for (const [label, gain] of LEVELS) {
    const payload = (await page.evaluate(
      async (o) => {
        const sok = (
          window as unknown as { __sok: { renderOffline: (x: unknown) => Promise<unknown> } }
        ).__sok;
        return (await sok.renderOffline(o)) as unknown;
      },
      { seconds, rateMul, seed: 20261010, airGainMax: gain },
    )) as { report: R; wav: string };

    writeFileSync(resolve(OUT, `preview-air-${label}.wav`), Buffer.from(payload.wav, "base64"));
    rows.push([label, gain, payload.report]);
  }
  await browser.close();

  console.log(`\nAir A/B — ${seconds}s at E≈0.6, files in artifacts/audio/preview-air-*.wav\n`);
  console.log("preset      gain    high    air     sub   bass    mid   rms dB  crest dB");
  for (const [label, gain, r] of rows) {
    const b = r.bandShare;
    const p = (v: number): string => (v * 100).toFixed(1).padStart(6);
    console.log(
      `${label.padEnd(10)} ${gain.toFixed(2)}  ${p(b.high)} ${p(b.air)} ${p(b.sub)} ${p(b.bass)} ${p(b.mid)}  ${r.rmsDb.toFixed(1).padStart(6)}  ${r.crestDb.toFixed(1).padStart(8)}`,
    );
  }
  console.log("\n§8.4 wants high in 5–25 %. `e-hiss` is the level that was reported as hiss.");
  console.log("Pick the quietest preset that still reads as 'air' rather than 'nothing'.");
}

main()
  .then(() => done(0))
  .catch((e: unknown) => {
    console.error(e);
    done(1);
  });
