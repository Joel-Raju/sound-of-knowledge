/**
 * Mix measurement. Spec §8.4 / §13.3.
 *
 * Pure functions over finished PCM — no Web Audio, no DOM — so the thresholds
 * can be unit-tested directly and the same code runs in the browser (producing
 * `report.json`) and in Node (checking it).
 *
 * The band-share figure uses an 8192-point Hann-windowed FFT averaged across
 * the whole file, exactly as §13.3 specifies. Averaging *power* rather than
 * averaging dB matters: averaging dB biases the result downward and would make
 * the numbers look worse than the mix really is.
 */

/** In-place iterative radix-2 FFT. `re`/`im` must be a power-of-two length. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n <= 1) return;
  if ((n & (n - 1)) !== 0) throw new Error(`fft length must be a power of two, got ${n}`);

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k]!;
        const ai = im[i + k]!;
        const br = re[i + k + len / 2]!;
        const bi = im[i + k + len / 2]!;
        const tr = br * cr - bi * ci;
        const ti = br * ci + bi * cr;
        re[i + k] = ar + tr;
        im[i + k] = ai + ti;
        re[i + k + len / 2] = ar - tr;
        im[i + k + len / 2] = ai - ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Periodic Hann window (the correct variant for STFT analysis). */
export function hannWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  return w;
}

/** Spectral power shares, summing to 1. */
export interface BandShare {
  sub: number;
  bass: number;
  mid: number;
  high: number;
  air: number;
}

/** §8.4 band edges, in Hz. */
export const SHARE_BANDS: readonly [keyof BandShare, number, number][] = [
  ["sub", 20, 80],
  ["bass", 80, 250],
  ["mid", 250, 2000],
  ["high", 2000, 8000],
  ["air", 8000, 20000],
];

/**
 * Spectral power share of a mono signal, averaged over 8192-sample
 * Hann-windowed frames with 50 % overlap.
 *
 * Mono because §8.4's targets describe the mix as a whole, and the file is
 * near-identical in both channels anyway; summing channels would only add
 * noise if the channels were ever decorrelated.
 */
export function bandShare(samples: Float32Array, sampleRate: number, fftSize = 8192): BandShare {
  if ((fftSize & (fftSize - 1)) !== 0) throw new Error("fftSize must be a power of two");
  const win = hannWindow(fftSize);
  const hop = fftSize >> 1;
  const binHz = sampleRate / fftSize;
  const acc = { sub: 0, bass: 0, mid: 0, high: 0, air: 0 };
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  let frames = 0;

  const toBin = (hz: number): number => Math.round(hz / binHz);
  const edges = SHARE_BANDS.map(([k, lo, hi]) => [k, toBin(lo), toBin(hi)] as const);

  for (let off = 0; off + fftSize <= samples.length; off += hop) {
    for (let i = 0; i < fftSize; i++) {
      re[i] = (samples[off + i] ?? 0) * win[i]!;
      im[i] = 0;
    }
    fft(re, im);

    // Power per band: |X|² summed over the band. Below 20 Hz is excluded from
    // every band, so DC and rumble do not inflate `sub`.
    for (const [key, lo, hi] of edges) {
      const a = Math.max(0, lo);
      const b = Math.min(fftSize / 2 - 1, hi);
      let p = 0;
      for (let i = a; i <= b; i++) {
        p += re[i]! * re[i]! + im[i]! * im[i]!;
      }
      acc[key] += p;
    }
    frames++;
  }

  const out = { sub: 0, bass: 0, mid: 0, high: 0, air: 0 };
  if (frames === 0) return out;
  let total = 0;
  for (const k of Object.keys(acc) as (keyof BandShare)[]) {
    total += acc[k];
  }
  if (total <= 0) return out;
  for (const k of Object.keys(acc) as (keyof BandShare)[]) out[k] = acc[k] / total;
  return out;
}

/** Peak and RMS of the interleaved-free stereo pair, plus integrity counters. */
export interface Levels {
  peak: number;
  peakDb: number;
  rms: number;
  rmsDb: number;
  crestDb: number;
  clippedSamples: number;
  nonFinite: number;
}

/**
 * §8.4 levels. `peak` is over both channels; `rms` is the integrated RMS of
 * the two channels pooled.
 */
export function levels(left: Float32Array, right: Float32Array): Levels {
  let peak = 0;
  let sumSq = 0;
  let clipped = 0;
  let nonFinite = 0;
  const n = Math.min(left.length, right.length);
  for (let i = 0; i < n; i++) {
    for (const v of [left[i]!, right[i]!]) {
      if (!Number.isFinite(v)) {
        nonFinite++;
        continue;
      }
      const a = Math.abs(v);
      if (a > peak) peak = a;
      if (a >= 0.999) clipped++;
      sumSq += v * v;
    }
  }
  const rms = n > 0 ? Math.sqrt(sumSq / (n * 2)) : 0;
  const peakDb = toDb(peak);
  const rmsDb = toDb(rms);
  return {
    peak,
    peakDb,
    rms,
    rmsDb,
    // Crest is undefined when there is no signal; 0 dB is the honest answer.
    crestDb: rms > 0 ? peakDb - rmsDb : 0,
    clippedSamples: clipped,
    nonFinite,
  };
}

export function toDb(v: number): number {
  return v > 0 ? 20 * Math.log10(v) : -Infinity;
}

/** Mix mono for spectral analysis. */
export function toMono(left: Float32Array, right: Float32Array): Float32Array {
  const n = Math.min(left.length, right.length);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (left[i]! + right[i]!) * 0.5;
  return out;
}

/** The §8.4 thresholds, verbatim, as data so the report and the tests agree. */
export const MIX_TARGETS = {
  peakMaxDb: -1.0,
  clippedMax: 0,
  rmsDb: { min: -24, max: -16 },
  crestDb: { min: 10, max: 22 },
  share: {
    sub: { min: 0.08, max: 0.3 },
    bass: { min: 0.1, max: 0.3 },
    mid: { min: 0.25, max: 0.5 },
    high: { min: 0.05, max: 0.25 },
    air: { min: 0, max: 0.08 },
  },
  stress: { droppedRatioMax: 0.35 },
} as const;

export interface ThresholdResult {
  ok: boolean;
  failures: string[];
}

/** Check one render against §8.4. Returns the failures rather than throwing. */
export function checkMixTargets(lv: Levels, share: BandShare): ThresholdResult {
  const failures: string[] = [];
  const T = MIX_TARGETS;

  if (!(lv.peakDb <= T.peakMaxDb)) {
    failures.push(`peak ${lv.peakDb.toFixed(2)} dBFS > ${T.peakMaxDb} dBFS`);
  }
  if (lv.clippedSamples > T.clippedMax) {
    failures.push(`${lv.clippedSamples} samples with |x| >= 0.999`);
  }
  if (lv.nonFinite > 0) failures.push(`${lv.nonFinite} non-finite samples`);
  if (!(lv.rmsDb >= T.rmsDb.min && lv.rmsDb <= T.rmsDb.max)) {
    failures.push(`rms ${lv.rmsDb.toFixed(2)} dBFS outside ${T.rmsDb.min}…${T.rmsDb.max}`);
  }
  if (!(lv.crestDb >= T.crestDb.min && lv.crestDb <= T.crestDb.max)) {
    failures.push(`crest ${lv.crestDb.toFixed(2)} dB outside ${T.crestDb.min}…${T.crestDb.max}`);
  }
  for (const k of Object.keys(T.share) as (keyof BandShare)[]) {
    const r = T.share[k];
    const v = share[k];
    if (!(v >= r.min && v <= r.max)) {
      failures.push(
        `share.${k} ${(v * 100).toFixed(1)}% outside ${(r.min * 100).toFixed(0)}…${(r.max * 100).toFixed(0)}%`,
      );
    }
  }

  return { ok: failures.length === 0, failures };
}
