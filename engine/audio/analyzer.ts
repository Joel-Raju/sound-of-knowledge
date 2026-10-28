/**
 * FFT band analysis. Spec §8.10.
 *
 * This is the coupling between audio and visuals: the orb, bloom and dust all
 * breathe with these numbers (§10.3). It taps **before** `masterGain`, so
 * muting the output does not freeze the visuals — a lesson carried over from v1
 * (`LEGACY-NOTES.md` §3.8).
 *
 * The maths is split from the node wrapper. `bandLevels`, `smooth` and `flux`
 * are pure and unit-tested with synthetic dB arrays; `Analyzer` owns the
 * AnalyserNode and the preallocated buffers.
 */
import {
  ANALYSER_FFT_SIZE,
  ANALYSER_SMOOTHING,
  BAND_DB_FLOOR,
  BAND_DB_OFFSET,
  BAND_DB_SPAN,
  BAND_HZ,
  FEATURE_ATTACK_TAU,
  FEATURE_RELEASE_TAU,
  FLUX_TAU,
  RMS_DB_OFFSET,
  RMS_DB_SPAN,
} from "../config";
import { clamp01, smoothingCoefficient } from "../util/math";
import { createAudioFeatures, type AudioFeatures } from "../types";

/** Band edges resolved to FFT bin indices for a real sample rate. */
export interface BandRanges {
  sub: [number, number];
  bass: [number, number];
  mid: [number, number];
  high: [number, number];
  air: [number, number];
}

/** Precomputed bin ranges for a sample rate. */
export function bandRanges(sampleRate: number, fftSize: number = ANALYSER_FFT_SIZE): BandRanges {
  const binHz = sampleRate / fftSize;
  const toBin = (hz: number): number => {
    const b = Math.round(hz / binHz);
    const max = fftSize / 2 - 1;
    return b < 0 ? 0 : b > max ? max : b;
  };
  return {
    sub: [toBin(BAND_HZ[0]![0]), toBin(BAND_HZ[0]![1])],
    bass: [toBin(BAND_HZ[1]![0]), toBin(BAND_HZ[1]![1])],
    mid: [toBin(BAND_HZ[2]![0]), toBin(BAND_HZ[2]![1])],
    high: [toBin(BAND_HZ[3]![0]), toBin(BAND_HZ[3]![1])],
    air: [toBin(BAND_HZ[4]![0]), toBin(BAND_HZ[4]![1])],
  };
}

/**
 * Spec §8.10 — `level = clamp((meanDb(band) + 80) / 60, 0, 1)`, with the mean
 * clamped at −100 dB so a silent band does not read as −Infinity.
 *
 * Writes into `out` (no allocation). `out` is indexed by the `BandKeys` order.
 */
export function bandLevels(
  freqDb: Float32Array,
  ranges: BandRanges,
  out: Float32Array,
  bins: Float32Array,
): void {
  const keys: (keyof BandRanges)[] = ["sub", "bass", "mid", "high", "air"];
  for (let b = 0; b < keys.length; b++) {
    const r = ranges[keys[b]!];
    const lo = r[0];
    const hi = Math.max(r[1], r[0] + 1);
    let sum = 0;
    let n = 0;
    for (let i = lo; i < hi; i++) {
      const v = freqDb[i] ?? BAND_DB_FLOOR;
      sum += v < BAND_DB_FLOOR ? BAND_DB_FLOOR : v;
      n++;
    }
    const mean = n > 0 ? sum / n : BAND_DB_FLOOR;
    const level = (mean + BAND_DB_OFFSET) / BAND_DB_SPAN;
    out[b] = level < 0 ? 0 : level > 1 ? 1 : level;
    bins[b] = hi - lo;
  }
}

/**
 * Spec §8.10 — spectral flux over mid/high bins: the sum of positive dB
 * differences against the previous frame, normalised and decayed with τ.
 *
 * Flux is what makes transients (a gong strike, a bot thud) visibly punch, so
 * it is deliberately restricted to mid/high — sub-band flux would react to every
 * bass swell and wash out the effect.
 */
export function flux(
  freqDb: Float32Array,
  prevDb: Float32Array,
  ranges: BandRanges,
  dtSec: number,
  state: { v: number } = FLUX_STATE,
): number {
  let sum = 0;
  const lo = ranges.mid[0];
  const hi = ranges.high[1];
  for (let i = lo; i < hi; i++) {
    const d = freqDb[i]! - prevDb[i]!;
    if (d > 0) sum += d;
  }
  // Divide into a stable 0..1 range: a full-scale step across a few hundred
  const instant = clamp01(sum / 200);
  return decay(instant, dtSec, state);
}

/**
 * Default flux decay state for the pure helpers. An `Analyzer` always supplies
 * its own, so two analysers never share decay state — a module-level variable
 * here would let an offline render bleed into the live one.
 */
const FLUX_STATE = { v: 0 };

export function decay(instant: number, dtSec: number, state: { v: number } = FLUX_STATE): number {
  const k = smoothingCoefficient(dtSec, FLUX_TAU);
  state.v = instant + (state.v - instant) * (1 - k);
  return state.v;
}
/**
 * Spec §8.10 — attack 0.05 s / release 0.35 s smoothing, frame-rate
 * independent via `a = 1 − exp(−dt/τ)`.
 */
export function smooth(current: number, target: number, dtSec: number): number {
  const tau = target > current ? FEATURE_ATTACK_TAU : FEATURE_RELEASE_TAU;
  const k = smoothingCoefficient(dtSec, tau);
  return current + (target - current) * k;
}

/**
 * Spec §8.10 — `rms01 = clamp((20·log10(rms) + 50) / 40, 0, 1)`.
 */
export function rmsToUnit(rms: number): number {
  if (rms <= 1e-8) return 0;
  const db = 20 * Math.log10(rms);
  const v = (db + RMS_DB_OFFSET) / RMS_DB_SPAN;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Reads an AnalyserNode every frame and writes one shared `AudioFeatures`. */
export class Analyzer {
  private readonly node: AnalyserNode | null;
  private readonly freqDb: Float32Array;
  private readonly prevDb: Float32Array;
  private readonly timeBuf: Float32Array;
  private readonly levels: Float32Array;
  private readonly bins: Float32Array;
  private readonly ranges: BandRanges;
  /** Per-instance flux decay state: two analysers must not share it. */
  private readonly fluxState = { v: 0 };
  readonly features: AudioFeatures = createAudioFeatures();

  constructor(node: AnalyserNode | null, sampleRate: number) {
    this.node = node;
    const bins = node ? node.frequencyBinCount : ANALYSER_FFT_SIZE / 2;
    this.freqDb = new Float32Array(bins as number);
    this.prevDb = new Float32Array(bins);
    this.timeBuf = new Float32Array(node ? node.fftSize : ANALYSER_FFT_SIZE);
    this.levels = new Float32Array(5);
    this.bins = new Float32Array(5);
    this.ranges = bandRanges(sampleRate, node ? node.fftSize : ANALYSER_FFT_SIZE);
    if (node) {
      node.fftSize = ANALYSER_FFT_SIZE as number;
      // Spec §8.10: smoothingTimeConstant = 0, we smooth ourselves.
      node.smoothingTimeConstant = ANALYSER_SMOOTHING;
    }
  }

  get bandRanges(): BandRanges {
    return this.ranges;
  }

  /** Sample the node and update `features` in place. No allocation. */
  update(dtSec: number): AudioFeatures {
    const f = this.features;
    if (!this.node) {
      // No analyser (e.g. a stripped-down context): decay everything to rest
      // rather than leaving stale values driving the visuals.
      f.rms = smooth(f.rms, 0, dtSec);
      f.sub = smooth(f.sub, 0, dtSec);
      f.bass = smooth(f.bass, 0, dtSec);
      f.mid = smooth(f.mid, 0, dtSec);
      f.high = smooth(f.high, 0, dtSec);
      f.air = smooth(f.air, 0, dtSec);
      f.flux = decay(0, dtSec, this.fluxState);
      return f;
    }

    this.node.getFloatFrequencyData(this.freqDb as Float32Array<ArrayBuffer>);
    this.node.getFloatTimeDomainData(this.timeBuf as Float32Array<ArrayBuffer>);

    bandLevels(this.freqDb, this.ranges, this.levels, this.bins);

    f.sub = smooth(f.sub, this.levels[0]!, dtSec);
    f.bass = smooth(f.bass, this.levels[1]!, dtSec);
    f.mid = smooth(f.mid, this.levels[2]!, dtSec);
    f.high = smooth(f.high, this.levels[3]!, dtSec);
    f.air = smooth(f.air, this.levels[4]!, dtSec);

    let sumSq = 0;
    for (let i = 0; i < this.timeBuf.length; i++) {
      const v = this.timeBuf[i]!;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / this.timeBuf.length);
    f.rms = smooth(f.rms, rmsToUnit(rms), dtSec);

    f.flux = flux(this.freqDb, this.prevDb, this.ranges, dtSec, this.fluxState);

    // Copy for the next frame's flux calculation.
    for (let i = 0; i < this.freqDb.length; i++) this.prevDb[i] = this.freqDb[i]!;

    return f;
  }
}

void FLUX_TAU;
