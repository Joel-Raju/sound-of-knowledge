/**
 * Air-layer A/B. Two files, one build, cache-proof filenames.
 *
 * §8.8's air layer was briefly raised +37 dB to chase §8.4's high-band target,
 * then deleted entirely after four rounds of "hiss" reports — which turned out
 * to describe a *cached file* rather than the render (see `DECISIONS.md`). It is
 * restored at §8.8's exact values. This script exists so its level can be judged
 * by ear in one pass, with filenames that cannot be served from a cache.
 *
 * Every render in this project is exactly 46,080,044 bytes, which is what made
 * the Quick Look cache indistinguishable from a fresh file. Both outputs here
 * carry a timestamp in the name.
 *
 * Usage: npx tsx scripts/probe-air-ab.ts [seconds]
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "artifacts/audio");
const PORT = Number(process.env.SOK_PORT ?? 4327);
const seconds = Number(process.argv[2] ?? 120);
const STAMP = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");

const VARIANTS = [
  { name: "air-ON", bypass: [] as string[], what: "§8.8 air layer at spec values" },
  { name: "air-OFF", bypass: ["air"], what: "air layer muted" },
];

async function isUp(): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${PORT}/?debug=1`)).ok;
  } catch {
    return false;
  }
}

/**
 * Reuse a server if one is already listening, else start one.
 *
 * Spawning blindly is fragile: run under `&` the child does not always survive,
 * and the failure surfaces as an unhelpful "server did not start" two minutes
 * later.
 */
async function ensureServer(): Promise<() => void> {
  if (await isUp()) {
    console.log(`reusing the server already listening on ${PORT}`);
    return () => {};
  }
  const child = spawn("npm", ["run", "start", "--", "--port", String(PORT)], {
    cwd: ROOT,
    stdio: "ignore",
  });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await isUp()) return () => child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 400));
  }
  child.kill("SIGTERM");
  throw new Error(`server did not start on ${PORT}`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const stopServer = await ensureServer();
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

  for (const v of VARIANTS) {
    const payload = (await page.evaluate(
      async (o) => {
        const sok = (
          window as unknown as { __sok: { renderOffline: (x: unknown) => Promise<unknown> } }
        ).__sok;
        return (await sok.renderOffline(o)) as unknown;
      },
      { seconds, rateMul: 0.305574, seed: 20261010, bypass: v.bypass },
    )) as { report: { rmsDb: number; peakDb: number; bandShare: { high: number } }; wav: string };

    const file = resolve(OUT, `airab-${v.name}-${STAMP}.wav`);
    writeFileSync(file, Buffer.from(payload.wav, "base64"));
    console.log(
      `${v.name.padEnd(8)} rms ${payload.report.rmsDb.toFixed(1)} dBFS  ` +
        `peak ${payload.report.peakDb.toFixed(1)} dBFS  ` +
        `high ${(payload.report.bandShare.high * 100).toFixed(2)} %`,
    );
    console.log(`         ${file}`);
  }
  await browser.close();
  stopServer();
  console.log(`\nPlay with afplay, not open — Quick Look cached a stale render for hours earlier:`);
  console.log(`  afplay artifacts/audio/airab-air-ON-${STAMP}.wav`);
  console.log(`  afplay artifacts/audio/airab-air-OFF-${STAMP}.wav`);
  console.log("\nIf both sound identical, §8.8's air is inaudible at spec level and stays as-is.");
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
