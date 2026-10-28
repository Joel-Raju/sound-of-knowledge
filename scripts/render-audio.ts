/**
 * Offline mix verification. Spec §13.3, thresholds from §8.4.
 *
 * Renders the real audio graph offline at E ≈ 0.3 / 0.6 / 0.9, writes three
 * 32-bit float WAVs plus `report.json`, prints a summary table, and **exits
 * non-zero if any §8.4 threshold fails**. `npm run audio:check` runs it.
 *
 * The WAVs exist for a human to listen to; the thresholds exist because an
 * agent cannot. Between them they cover the two failure modes that matter —
 * "the numbers are wrong" and "the numbers are right but it sounds awful".
 *
 * Usage: npx tsx scripts/render-audio.ts [--seconds 120] [--keep]
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MIX_TARGETS,
  MIX_TARGETS_ORIGINAL,
  checkMixTargets,
  type BandShare,
  type Levels,
} from "../engine/audio/mix-analysis";
import { isExpectedLocalNoise } from "../tests/e2e/helpers";
import { analyseDrift, formatDrift, type DriftReport } from "./drift-analysis";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACTS = resolve(ROOT, "artifacts/audio");

const args = process.argv.slice(2);
const seconds = Number(args[args.indexOf("--seconds") + 1]) || 120;
const PORT = Number(process.env.SOK_PORT ?? 4317);

/**
 * `eps = (1 + EPS_REF)^E − 1` (§13.3) converted to the synthetic source's
 * `rateMul`. `EPS_REF = 15` was calibrated at T1.1 against a real 180 s
 * capture; see `DECISIONS.md`.
 */
const EPS_REF = 15;
const SYNTH_BASE_RATE = 14;

function rateMulForEnergy(e: number): number {
  const eps = Math.pow(1 + EPS_REF, e) - 1;
  return eps / SYNTH_BASE_RATE;
}

interface RenderPayload {
  report: Report;
  wav: string;
}

interface Report extends Levels {
  seconds: number;
  seed: number;
  rateMul: number;
  sampleRate: number;
  bandShare: BandShare;
  voiceCounts: Record<string, number>;
  attemptedNotes: number;
  droppedNotes: number;
  maxConcurrentVoices: number;
  scheduledNotes: number;
  harmonyTimeline: unknown[];
  peak: number;
  rms: number;
  crestDb: number;
  clippedSamples: number;
  nonFinite: number;
}

/**
 * `--soak` renders D4's 10-minute case *instead of* the three stress levels.
 *
 * D4 is listed as "produced by T6.3", but it depends on nothing T6.3 builds — it is
 * the same offline render at a longer duration, and the interesting part (drift) is a
 * measurement rather than a listener's judgement. So it is available now, and this
 * flag exists because running a 600 s render for every routine `audio:check` would
 * make the fast path slow for no benefit.
 */
const SOAK = args.includes("--soak");

const CASES = SOAK
  ? ([{ e: 0.6, label: "soak" }] as const)
  : ([
      { e: 0.3, label: "E30" },
      { e: 0.6, label: "E60" },
      { e: 0.9, label: "E90" },
    ] as const);

/** D4 — 10 minutes at E ≈ 0.6. Overridden by `--seconds` for a quicker rehearsal. */
const SOAK_SECONDS = 600;

// --- server ---------------------------------------------------------------
const server = spawn("npm", ["run", "start", "--", "--port", String(PORT)], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
  detached: false,
});
let serverLog = "";
server.stdout?.on("data", (d: Buffer) => (serverLog += d.toString()));
server.stderr?.on("data", (d: Buffer) => (serverLog += d.toString()));

function shutdown(code: number): void {
  try {
    server.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  process.exit(code);
}

async function waitForServer(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/?debug=1`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`server did not start within ${timeoutMs}ms\n${serverLog.slice(-2000)}`);
}

// --- main -----------------------------------------------------------------
interface Outcome {
  label: string;
  e: number;
  rateMul: number;
  report: Report;
  failures: string[];
}

/** Page-level errors, hoisted so the exit-code path can see them. */
const pageErrorList: string[] = [];

async function main(): Promise<void> {
  mkdirSync(ARTIFACTS, { recursive: true });
  await waitForServer();

  const browser = await chromium.launch({
    args: [
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      // No user gesture exists in a Playwright run; without this the
      // AudioContext stays suspended and every render is silence.
      "--autoplay-policy=no-user-gesture-required",
    ],
  });

  const outcomes: Outcome[] = [];
  /** D4 only — one entry, from the soak case. */
  const drifts: DriftReport[] = [];
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => {
      if (!isExpectedLocalNoise(e.message)) pageErrorList.push(e.message);
    });
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      // The Vercel analytics scripts 404 outside Vercel — same exclusion the
      // e2e suite applies, so `audio:check` reports only real errors.
      if (isExpectedLocalNoise(m.text()) || isExpectedLocalNoise(m.location()?.url ?? "")) return;
      pageErrorList.push(m.text());
    });

    await page.goto(`http://127.0.0.1:${PORT}/?debug=1&source=synthetic`, {
      waitUntil: "load",
    });

    // The harness is behind a dynamic import; wait for it rather than racing.
    await page.waitForFunction(
      () => (window as unknown as { __sokReady?: boolean }).__sokReady === true,
      {
        timeout: 60_000,
      },
    );
    const harnessError = await page.evaluate(
      () => (window as unknown as { __sokError?: string }).__sokError ?? null,
    );
    if (harnessError) throw new Error(`debug harness failed to load: ${harnessError}`);

    for (const c of CASES) {
      const rateMul = rateMulForEnergy(c.e);
      process.stdout.write(`rendering ${c.label} (E=${c.e}, rateMul=${rateMul.toFixed(3)}) … `);
      const started = Date.now();

      const payload = (await page.evaluate(
        async (o) => {
          const sok = (
            window as unknown as { __sok: { renderOffline: (x: unknown) => Promise<unknown> } }
          ).__sok;
          return (await sok.renderOffline(o)) as unknown;
        },
        {
          seconds: SOAK ? SOAK_SECONDS : seconds,
          rateMul,
          seed: 20_261_010,
        },
      )) as RenderPayload;

      const report = payload.report;
      const wav = Buffer.from(payload.wav, "base64");
      const wavPath = resolve(ARTIFACTS, `render-${c.label}.wav`);
      writeFileSync(wavPath, wav);
      process.stdout.write(
        `${((Date.now() - started) / 1000).toFixed(1)}s, ${(wav.length / 1e6).toFixed(1)} MB\n`,
      );

      // D4's soak gets the drift analysis. "No drift, no runaway resonance, no
      // patchy silence" are all measurable, and a listener is a poor instrument for
      // the first two across ten minutes — a slow level ramp is exactly what you
      // stop noticing after the first minute. The numbers are there so the ear
      // confirms something rather than searching for it.
      if (SOAK) {
        const drift = analyseDrift(wavPath);
        drifts.push(drift);
        writeFileSync(
          resolve(ARTIFACTS, "drift.json"),
          `${JSON.stringify(drift, null, 2)}\n`,
        );
        process.stdout.write(`\n${formatDrift(drift)}\n`);
      }

      // §8.4 states the loudness, crest and band-share targets "for a 120 s
      // synthetic render at steady E ≈ 0.6", and adds a separate stress clause
      // for E ≈ 0.9. We apply the *full* set at every energy rather than
      // exempting E90: a mix whose spectrum only holds at one density is not a
      // mix, and the exemption would have silently hidden E90 running at 30 %
      // high-band. E90 additionally gets the drop-rate and concurrency checks
      // below.
      const check = checkMixTargets(report, report.bandShare);
      outcomes.push({ label: c.label, e: c.e, rateMul, report, failures: check.failures });
    }

    // §8.4 stress requirement, checked at E ≈ 0.9. Skipped under `--soak`, which
    // renders only E ≈ 0.6 — the `!` here would hand back `undefined` and the
    // next line would throw on a soak run rather than simply skipping.
    const stress = outcomes.find((o) => o.e === 0.9);
    if (stress) {
      const dropRatio =
        stress.report.attemptedNotes > 0
          ? stress.report.droppedNotes / stress.report.attemptedNotes
          : 0;
      if (dropRatio > MIX_TARGETS.stress.droppedRatioMax) {
        stress.failures.push(
          `dropped/attempted ${(dropRatio * 100).toFixed(1)}% > ${(MIX_TARGETS.stress.droppedRatioMax * 100).toFixed(0)}%`,
        );
      }
      const budget = 16; // TIER_PARAMS.high.voices
      if (stress.report.maxConcurrentVoices > budget) {
        stress.failures.push(
          `max concurrent ${stress.report.maxConcurrentVoices} > budget ${budget}`,
        );
      }
    }

    writeFileSync(
      resolve(ARTIFACTS, "report.json"),
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          seconds,
          epsRef: EPS_REF,
          targets: MIX_TARGETS,
          // §8.4 as originally written, kept so the amendment is auditable.
          targetsOriginalSpec: MIX_TARGETS_ORIGINAL,
          cases: outcomes.map((o) => ({
            label: o.label,
            energy: o.e,
            rateMul: o.rateMul,
            report: o.report,
            failures: o.failures,
          })),
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await browser.close();
  }

  printTable(outcomes);
  if (pageErrorList.length > 0) {
    console.error("\nPage errors:");
    for (const e of pageErrorList) console.error(`  ${e}`);
  }
}

function printTable(outcomes: Outcome[]): void {
  console.log("\n─── Mix report (§8.4) ─────────────────────────────────────");
  const header = ["case", "peak", "rms", "crest", "sub", "bass", "mid", "high", "air", "drop%"];
  const rows = outcomes.map((o) => {
    const r = o.report;
    const dropRatio = r.attemptedNotes > 0 ? (r.droppedNotes / r.attemptedNotes) * 100 : 0;
    return [
      o.label,
      `${r.peakDb.toFixed(1)}`,
      `${r.rmsDb.toFixed(1)}`,
      `${r.crestDb.toFixed(1)}`,
      `${(r.bandShare.sub * 100).toFixed(1)}`,
      `${(r.bandShare.bass * 100).toFixed(1)}`,
      `${(r.bandShare.mid * 100).toFixed(1)}`,
      `${(r.bandShare.high * 100).toFixed(1)}`,
      `${(r.bandShare.air * 100).toFixed(1)}`,
      `${dropRatio.toFixed(1)}`,
    ];
  });
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padStart(widths[i]!)).join("  ");
  console.log(line(header));
  console.log(widths.map((w) => "─".repeat(w)).join("  "));
  for (const r of rows) console.log(line(r));

  console.log(
    `\ntargets: peak ≤ ${MIX_TARGETS.peakMaxDb} dBFS · rms ${MIX_TARGETS.rmsDb.min}…${MIX_TARGETS.rmsDb.max} dBFS · crest ${MIX_TARGETS.crestDb.min}…${MIX_TARGETS.crestDb.max} dB · drop ≤ ${(MIX_TARGETS.stress.droppedRatioMax * 100).toFixed(0)}%`,
  );

  console.log("\nVoices per kind:");
  for (const o of outcomes) {
    const counts = Object.entries(o.report.voiceCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`)
      .join(" ");
    console.log(`  ${o.label.padEnd(4)} ${counts || "(none)"}`);
  }
  for (const o of outcomes) {
    console.log(
      `  ${o.label.padEnd(4)} notes ${o.report.scheduledNotes}, max concurrent ${o.report.maxConcurrentVoices}, harmony ${o.report.harmonyTimeline.length}`,
    );
  }

  let failed = false;
  console.log("\nAcceptance:");
  for (const o of outcomes) {
    if (o.failures.length === 0) {
      console.log(`  ✓ ${o.label}`);
    } else {
      failed = true;
      console.log(`  ✗ ${o.label}`);
      for (const f of o.failures) console.log(`      ${f}`);
    }
  }
  if (failed) console.log("\nFAIL — see violations above.");
  else console.log("  all checks passed");
}

main()
  .then(() => {
    // Re-derive pass/fail from the artefact on disk, so the exit code is
    // decided by what was actually written rather than by in-memory state.
    const report = JSON.parse(readFileSync(resolve(ARTIFACTS, "report.json"), "utf8")) as {
      cases: { label: string; failures: string[] }[];
    };
    const bad = report.cases.filter((c) => c.failures.length > 0);
    if (pageErrorList.length > 0) bad.push({ label: "page", failures: pageErrorList });
    if (bad.length > 0) {
      console.error("");
      shutdown(1);
    }
    shutdown(0);
  })
  .catch((err: unknown) => {
    console.error(`\nrender-audio failed: ${(err as Error).message}`);
    if (serverLog) console.error(serverLog.slice(-3000));
    shutdown(1);
  });
