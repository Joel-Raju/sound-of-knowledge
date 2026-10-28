/**
 * Drift analysis for D4's soak render.
 *
 * **Why this is a module and not a listen.** D4 asks for "no drift, no runaway
 * resonance, no patchy silence". All three are measurable, and a human ear is a poor
 * instrument for the first two across ten minutes — a slow level ramp or a filter
 * state creeping is exactly the kind of thing you stop noticing after the first
 * minute. The numbers give the ear something to confirm rather than to search for.
 *
 * Reads the WAV directly, independently of `report.json`. That independence is
 * deliberate and has been earned: the strided RMS check written earlier in this
 * project read 3 dB low by aliasing against a low-frequency-heavy mix, and the
 * report turned out to be right. Anything measured here is a full-rate scan.
 */
import { readFileSync } from "node:fs";

export interface DriftReport {
  /** seconds */
  duration: number;
  /** per-bucket RMS in dBFS */
  bucketsDb: number[];
  bucketSec: number;
  /** dB — max minus min across buckets. The headline number. */
  spreadDb: number;
  /**
   * dB per minute — **Theil–Sen** slope of bucket RMS over time (the median of all
   * pairwise slopes), not least-squares.
   *
   * Least squares was tried first and is wrong here: a single step change dominates
   * the regression and reports a large steady slope for what is really one event.
   * The median of pairwise slopes is unmoved by up to half the buckets, so one
   * loud passage does not read as drift.
   *
   * **This still cannot isolate engine drift, because the synthetic source is
   * non-stationary by design** — `SYNTH_RATE_PERIOD_SEC = 90` with ±60 % amplitude
   * makes arrival rate oscillate on a 90 s period, and bursts add more. Level
   * variation of a dB or three over minutes is the *source*, not the engine. See
   * `DECISIONS.md`; the honest statement is that this measures whether the mix holds
   * together, not whether the engine leaks state.
   */
  slopeDbPerMin: number;
  /** Longest run of consecutive buckets below `silenceDb`. "Patchy silence". */
  longestQuietRunSec: number;
  /** buckets quieter than this count as silence, not as a musical gap. */
  silenceDb: number;
  /** peak sample magnitude across the whole file — runaway resonance check. */
  peak: number;
  clippedSamples: number;
  nonFinite: number;
}

/** Below this, a bucket is a musical gap. ~6 dB under the file's own median. */
const SILENCE_MARGIN_DB = 12;

export function analyseDrift(path: string, bucketSec = 30): DriftReport {
  const b = readFileSync(path);

  if (b.toString("ascii", 0, 4) !== "RIFF") throw new Error("not a RIFF file");

  let off = 12;
  let dataOff = 0;
  let dataLen = 0;
  let channels = 2;
  let rate = 48_000;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    if (id === "fmt ") {
      channels = b.readUInt16LE(off + 10);
      rate = b.readUInt32LE(off + 12);
    } else if (id === "data") {
      dataOff = off + 8;
      dataLen = sz;
    }
    off += 8 + sz + (sz % 2);
  }
  if (dataLen === 0) throw new Error("no data chunk");

  const bytesPerSample = 4; // 32-bit float, per the render harness
  const frames = Math.floor(dataLen / (bytesPerSample * channels));
  const duration = frames / rate;
  const framesPerBucket = Math.max(1, Math.floor(bucketSec * rate));

  const buckets: number[] = [];
  let peak = 0;
  let clipped = 0;
  let nonFinite = 0;

  // Full-rate scan of both channels. No striding: see the module comment.
  for (let f = 0; f < frames; f++) {
    const base = dataOff + f * bytesPerSample * channels;
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const v = b.readFloatLE(base + c * bytesPerSample);
      if (!Number.isFinite(v)) {
        nonFinite++;
        continue;
      }
      const a = Math.abs(v);
      if (a > peak) peak = a;
      if (a >= 1) clipped++;
      acc += v * v;
    }
    const inBucket = Math.floor(f / framesPerBucket);
    if (inBucket >= buckets.length) buckets.push(0);
    buckets[inBucket] = (buckets[inBucket] ?? 0) + acc / channels;
  }

  const nBuckets = buckets.length;
  const rms = buckets.map((s, i) => {
    const count = Math.min(framesPerBucket, frames - i * framesPerBucket);
    return Math.sqrt(Math.max(0, s) / Math.max(1, count));
  });
  const toDb = (x: number): number => (x > 0 ? 20 * Math.log10(x) : -Infinity);
  const bucketsDb = rms.map(toDb);

  const finite = bucketsDb.filter((d) => Number.isFinite(d));
  const median = [...finite].sort((a, b) => a - b)[Math.floor(finite.length / 2)] ?? -100;
  const spreadDb =
    finite.length > 0 ? Math.max(...finite) - Math.min(...finite) : 0;

  // Theil–Sen: the median of every pairwise slope. Robust to a minority of
  // buckets behaving differently, which a least-squares fit is not.
  let slopeDbPerMin = 0;
  {
    const pts: [number, number][] = [];
    for (let i = 0; i < nBuckets; i++) {
      const y = bucketsDb[i] ?? -Infinity;
      if (Number.isFinite(y)) pts.push([i, y]);
    }
    const slopes: number[] = [];
    for (let a = 0; a < pts.length; a++) {
      for (let b = a + 1; b < pts.length; b++) {
        const [xa, ya] = pts[a] as [number, number];
        const [xb, yb] = pts[b] as [number, number];
        const dx = xb - xa;
        if (dx !== 0) slopes.push((yb - ya) / dx);
      }
    }
    if (slopes.length > 0) {
      slopes.sort((p, q) => p - q);
      const med = slopes[Math.floor(slopes.length / 2)] as number;
      slopeDbPerMin = med * (60 / bucketSec);
    }
  }

  const silenceDb = median - SILENCE_MARGIN_DB;
  let run = 0;
  let longestQuietRunSec = 0;
  for (const d of bucketsDb) {
    if (Number.isFinite(d) && d < silenceDb) {
      run += bucketSec;
      if (run > longestQuietRunSec) longestQuietRunSec = run;
    } else {
      run = 0;
    }
  }

  return {
    duration,
    bucketsDb,
    bucketSec,
    spreadDb,
    slopeDbPerMin,
    longestQuietRunSec,
    silenceDb,
    peak,
    clippedSamples: clipped,
    nonFinite,
  };
}

/**
 * Format for the console. Kept beside the analysis so the thresholds and the prose
 * that explains them cannot drift apart.
 */
export function formatDrift(d: DriftReport): string {
  const perMin = d.bucketsDb
    .map((v, i) => `${String(Math.round(i * d.bucketSec)).padStart(4)}s ${v.toFixed(1).padStart(6)}`)
    .join("  ");
  const lines = [
    `duration          ${d.duration.toFixed(1)} s   ${d.bucketsDb.length} buckets of ${d.bucketSec}s`,
    `peak              ${(20 * Math.log10(Math.max(d.peak, 1e-12))).toFixed(2)} dBFS   ` +
      `clipped ${d.clippedSamples}   non-finite ${d.nonFinite}`,
    `spread            ${d.spreadDb.toFixed(2)} dB   (max − min across buckets)`,
    `slope             ${d.slopeDbPerMin >= 0 ? "+" : ""}${d.slopeDbPerMin.toFixed(3)} dB/min   ` +
      `(Theil-Sen; robust to a step. NOTE: the synthetic source's rate oscillates on a` +
      ` 90 s period by design, so this is not an isolated measure of engine drift)`,
    `longest silence   ${d.longestQuietRunSec} s   (threshold ${d.silenceDb.toFixed(1)} dBFS)`,
    "",
    `per bucket:  ${perMin}`,
  ];
  return lines.join("\n");
}