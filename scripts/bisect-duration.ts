/**
 * Bisect the render's duration-dependence.
 *
 * **The finding being chased.** `renderOffline` with seed 20 261 010 and
 * rateMul 0.306 produces different audio for the same first 120 seconds depending
 * on whether the buffer is 120 s or 600 s long:
 *
 *     120 s render, whole file      sub 22.4  bass 23.3  mid 51.7  high 2.4
 *     600 s render, FIRST 120 s     sub 40.6  bass 43.4  mid 16.0  high 0.1
 *
 * Same seed, same virtual clock, same first 120 s of events. The only differing
 * input is `seconds`. Mid collapsing and high nearly vanishing is a spectral-shape
 * change, not a level one, so the suspects are filters and delay lines rather than
 * gain stages.
 *
 * Both durations are rendered **in one page session** so there is no cross-process
 * state to confound the comparison — and so the cost is one browser launch rather
 * than two, which matters when each render is ~2 minutes.
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { bandShare, type BandShare } from "../engine/audio/mix-analysis";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.SOK_PORT ?? 4316);
const SEED = 20_261_010;
const RATE_MUL = 0.3056; // rateMulForEnergy(0.6)

interface Case {
  label: string;
  seconds: number;
  scenario?: "full" | "notes-only" | "pad-only";
}

interface Payload {
  report: {
    bandShare: BandShare;
    attemptedNotes: number;
    sampleRate: number;
  };
  wav: string;
}

/** Decode a 32-bit-float WAV to mono, for analysing a window of it. */
function monoFromWav(b64: string, windowSec: number, sampleRate: number): Float32Array {
  const b = Buffer.from(b64, "base64");
  let off = 12;
  let dataOff = 0;
  let dataLen = 0;
  let channels = 2;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    if (id === "fmt ") channels = b.readUInt16LE(off + 10);
    else if (id === "data") {
      dataOff = off + 8;
      dataLen = sz;
    }
    off += 8 + sz + (sz % 2);
  }
  const frames = Math.floor(dataLen / (4 * channels));
  const n = Math.min(frames, Math.round(windowSec * sampleRate));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) acc += b.readFloatLE(dataOff + (i * channels + c) * 4);
    out[i] = acc / channels;
  }
  return out;
}

const CASES: Case[] = [
  { label: "full/120", seconds: 120 },
  { label: "full/600", seconds: 600 },
  { label: "notes-only/120", seconds: 120, scenario: "notes-only" },
  { label: "notes-only/600", seconds: 600, scenario: "notes-only" },
  { label: "pad-only/120", seconds: 120, scenario: "pad-only" },
  { label: "pad-only/600", seconds: 600, scenario: "pad-only" },
];

function fmt(b: BandShare): string {
  const p = (v: number): string => `${(v * 100).toFixed(1)}%`.padStart(6);
  return `sub${p(b.sub)} bass${p(b.bass)} mid${p(b.mid)} high${p(b.high)} air${p(b.air)}`;
}

/** Band share of the first `windowSec` only, so durations are comparable. */
function firstWindow(p: Payload, windowSec: number): BandShare {
  return bandShare(monoFromWav(p.wav, windowSec, p.report.sampleRate), p.report.sampleRate);
}

async function isUp(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/?debug=1`)).ok;
  } catch {
    return false;
  }
}

async function ensureServer(port: number): Promise<() => void> {
  if (await isUp(port)) return () => {};
  const child = spawn("npm", ["run", "start", "--", "--port", String(port)], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let log = "";
  child.stderr?.on("data", (d: Buffer) => (log += d.toString()));
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await isUp(port)) return () => child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill("SIGKILL");
  throw new Error(`server did not start\n${log.slice(-1500)}`);
}

async function main(): Promise<void> {
const stop = await ensureServer(PORT);
try {
  const browser = await chromium.launch({
    args: [
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/?debug=1`);
  await page.waitForFunction(() => (window as unknown as { __sokReady?: boolean }).__sokReady === true, {
    timeout: 60_000,
  });

  const results: { label: string; window: BandShare; full: BandShare; notes: number }[] = [];
  for (const c of CASES) {
    const p = (await page.evaluate(
      async (o) => {
        const sok = (
          window as unknown as { __sok: { renderOffline: (x: unknown) => Promise<unknown> } }
        ).__sok;
        return (await sok.renderOffline(o)) as unknown;
      },
      { seconds: c.seconds, rateMul: RATE_MUL, seed: SEED, scenario: c.scenario },
    )) as Payload;
    results.push({
      label: c.label,
      window: firstWindow(p, 120),
      full: p.report.bandShare,
      notes: p.report.attemptedNotes,
    });
    console.log(`rendered ${c.label.padEnd(18)} notes=${p.report.attemptedNotes}`);
  }
  await browser.close();

  console.log(`\n--- first 120 s of each (E=0.6) ---`);
  for (const r of results) {
    console.log(`${r.label.padEnd(18)} ${fmt(r.window)}`);
  }
  console.log(`\n--- whole file (shows which are self-consistent) ---`);
  for (const r of results) {
    console.log(`${r.label.padEnd(18)} ${fmt(r.full)}`);
  }

  console.log(`\n--- verdict: does the first 120 s depend on total duration? ---`);
  for (const name of ["full", "notes-only", "pad-only"]) {
    const a = results.find((x) => x.label === `${name}/120`);
    const b = results.find((x) => x.label === `${name}/600`);
    if (!a || !b) continue;
    const dMid = Math.abs(a.window.mid - b.window.mid) * 100;
    const dHigh = Math.abs(a.window.high - b.window.high) * 100;
    const same = dMid < 1.0 && dHigh < 0.2;
    console.log(
      `${same ? "✓ same   " : "✗ DIFFERS"}  ${name.padEnd(12)} ` +
        `Δmid ${dMid.toFixed(2)}pp  Δhigh ${dHigh.toFixed(2)}pp  ` +
        `(notes ${a.notes} vs ${b.notes})`,
    );
  }
} finally {
  stop();
}
}

void main();