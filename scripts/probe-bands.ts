/**
 * Band-energy attribution probe (T3.5 tuning aid).
 *
 * Renders the mix with individual layers disabled so a missed §8.4 target can
 * be attributed to a source instead of guessed at. Not part of `audio:check`.
 *
 * Usage: npx tsx scripts/probe-bands.ts [seconds]
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.SOK_PORT ?? 4319);
const seconds = Number(process.argv[2] ?? 30);

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
      /* not up */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("server did not start");
}

interface Share {
  sub: number;
  bass: number;
  mid: number;
  high: number;
  air: number;
}
interface R {
  bandShare: Share;
  rmsDb: number;
  peakDb: number;
  voiceCounts: Record<string, number>;
}

async function main(): Promise<void> {
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
  for (const [label, scenario] of [
    ["full", "full"],
    ["notes only", "notes-only"],
    ["pad only", "pad-only"],
  ] as const) {
    const out = (await page.evaluate(
      async (o) => {
        const sok = (
          window as unknown as { __sok: { renderOffline: (x: unknown) => Promise<unknown> } }
        ).__sok;
        return (await sok.renderOffline(o)) as unknown;
      },
      { seconds, rateMul: 0.306, seed: 20261010, scenario, returnAudio: false },
    )) as { report: R };
    rows.push([label, out.report]);
  }
  await browser.close();

  console.log(`\nband shares at E≈0.6, ${seconds}s`);
  console.log("layer        sub    bass     mid    high    air   rms dB  peak dB");
  for (const [label, r] of rows) {
    const b = r.bandShare;
    const pct = (v: number): string => (v * 100).toFixed(1).padStart(6);
    console.log(
      `${label.padEnd(11)} ${pct(b.sub)} ${pct(b.bass)} ${pct(b.mid)} ${pct(b.high)} ${pct(b.air)} ${r.rmsDb.toFixed(1).padStart(7)} ${r.peakDb.toFixed(1).padStart(8)}`,
    );
  }
  const counts = rows[0]![1].voiceCounts;
  console.log(
    `\nvoice counts: ${Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")}`,
  );
}

main()
  .then(() => done(0))
  .catch((e: unknown) => {
    console.error(e);
    done(1);
  });
