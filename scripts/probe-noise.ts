/**
 * Noise-source isolation probe.
 *
 * Renders the same music once per mix-chain component, with that component
 * muted, so a persistent hiss can be attributed **by ear in a single pass**
 * instead of by guesswork.
 *
 * This exists because three rounds of guessing picked the wrong layer: the air
 * noise layer was blamed, tuned four times, and finally deleted — after which
 * the measurements changed by 0.0 points and the hiss remained. Guessing costs
 * a render cycle each time and got the answer wrong each time; asking the human
 * to compare five labelled clips costs one.
 *
 * Usage: npx tsx scripts/probe-noise.ts [seconds] [rateMul]
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "artifacts/audio");
const PORT = Number(process.env.SOK_PORT ?? 4323);
const seconds = Number(process.argv[2] ?? 30);
const rateMul = Number(process.argv[3] ?? 0.306);

type Part = "reverb" | "delay" | "softclip" | "hrtf" | "air";

const VARIANTS: { name: string; bypass: Part[]; what: string }[] = [
  { name: "0-baseline", bypass: [], what: "everything on — the reference" },
  { name: "0b-air-off", bypass: ["air"], what: "air layer muted (§8.8 restored)" },
  { name: "1-no-reverb", bypass: ["reverb"], what: "convolver + both reverb sends muted" },
  {
    name: "2-no-softclip",
    bypass: ["softclip"],
    what: "WaveShaper curve set to null (pass-through)",
  },
  { name: "3-no-hrtf", bypass: ["hrtf"], what: "panners switched to equalpower" },
  { name: "4-no-delay", bypass: ["delay"], what: "ping-pong send muted" },
  {
    name: "5-no-all-fx",
    bypass: ["reverb", "softclip", "hrtf", "delay"],
    what: "every candidate off at once",
  },
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
  rmsDb: number;
  peakDb: number;
  crestDb: number;
  clippedSamples: number;
  nonFinite: number;
  bandShare: { sub: number; bass: number; mid: number; high: number; air: number };
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

  const rows: [string, R][] = [];
  for (const v of VARIANTS) {
    const payload = (await page.evaluate(
      async (o) => {
        const sok = (
          window as unknown as { __sok: { renderOffline: (x: unknown) => Promise<unknown> } }
        ).__sok;
        return (await sok.renderOffline(o)) as unknown;
      },
      { seconds, rateMul, seed: 20261010, bypass: v.bypass },
    )) as { report: R; wav: string };

    writeFileSync(resolve(OUT, `probe-noise-${v.name}.wav`), Buffer.from(payload.wav, "base64"));
    rows.push([v.name, payload.report]);
    process.stdout.write(`  rendered ${v.name}\n`);
  }
  await browser.close();

  console.log(`\nNoise probe — ${seconds}s at E≈0.6. Files in artifacts/audio/probe-noise-*.wav\n`);
  for (const v of VARIANTS) console.log(`  ${v.name.padEnd(16)} ${v.what}`);
  console.log("\nMeasurements (these will NOT move much — the hiss is not in the bands):");
  console.log("\nfile              rms dB  peak dB  crest dB  clipped  nonFinite  high %");
  for (const [name, r] of rows) {
    console.log(
      `${name.padEnd(16)} ${r.rmsDb.toFixed(1).padStart(6)} ${r.peakDb.toFixed(1).padStart(8)} ${r.crestDb
        .toFixed(1)
        .padStart(
          9,
        )} ${String(r.clippedSamples).padStart(8)} ${String(r.nonFinite).padStart(10)} ${(
        r.bandShare.high * 100
      )
        .toFixed(2)
        .padStart(7)}`,
    );
  }
  console.log("\nListen for which clip the hiss disappears from. That is the source.");
  console.log("If it is in all of them, the source is the voice path itself, not the FX chain.");
}

main()
  .then(() => done(0))
  .catch((e: unknown) => {
    console.error(e);
    done(1);
  });
