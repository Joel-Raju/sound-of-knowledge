import { describe, expect, it } from "vitest";
import {
  Analyzer,
  bandLevels,
  bandRanges,
  decay,
  flux,
  rmsToUnit,
  smooth,
} from "@/engine/audio/analyzer";
import {
  ANALYSER_FFT_SIZE,
  BAND_DB_FLOOR,
  BAND_DB_OFFSET,
  BAND_DB_SPAN,
  BAND_HZ,
  FEATURE_ATTACK_TAU,
  FEATURE_RELEASE_TAU,
  RMS_DB_OFFSET,
  RMS_DB_SPAN,
} from "@/engine/config";

const SR = 48000;
const BINS = ANALYSER_FFT_SIZE / 2;

/**
 * A dB array that is silent everywhere except one band, which is held **flat**
 * at `peakDb`.
 *
 * Flat, not a raised cosine: `bandLevels` measures the *mean* dB over the band,
 * so a cosine peak would make the band mean sit well below the peak and the
 * loud-tone assertion would be measuring the wrong thing.
 */
function toneIn(band: 0 | 1 | 2 | 3 | 4, peakDb = -6, sr = SR): Float32Array {
  const db = new Float32Array(BINS).fill(BAND_DB_FLOOR);
  const r = bandRanges(sr);
  const keys = ["sub", "bass", "mid", "high", "air"] as const;
  const range = r[keys[band]!];
  const lo = range[0];
  const hi = range[1];
  for (let i = lo; i <= hi; i++) db[i] = peakDb;
  return db;
}

function levelsOf(db: Float32Array, sr = SR): Float32Array {
  const out = new Float32Array(5);
  const bins = new Float32Array(5);
  bandLevels(db, bandRanges(sr), out, bins);
  return out;
}

// spec T3.4 tests: feed synthetic dB arrays (peak at 100 Hz → bass dominates;
// at 5 kHz → high), smoothing attack/release, flux decay.
describe("bandRanges", () => {
  it("maps the spec's band edges to bins", () => {
    const r = bandRanges(SR);
    const binHz = SR / ANALYSER_FFT_SIZE;
    // sub 20-80, bass 80-250, mid 250-2000, high 2000-8000, air 8000-16000
    expect(r.sub[0]).toBe(Math.round(20 / binHz));
    expect(r.bass[1]).toBe(Math.round(250 / binHz));
    expect(r.mid[0]).toBe(Math.round(250 / binHz));
    expect(r.high[1]).toBe(Math.round(8000 / binHz));
    expect(r.air[0]).toBe(Math.round(8000 / binHz));
  });

  it("is monotonic and non-overlapping across bands", () => {
    const r = bandRanges(SR);
    expect(r.sub[1]).toBeLessThanOrEqual(r.bass[0]);
    expect(r.bass[1]).toBeLessThanOrEqual(r.mid[0]);
    expect(r.mid[1]).toBeLessThanOrEqual(r.high[0]);
    expect(r.high[1]).toBeLessThanOrEqual(r.air[0]);
  });

  it("scales with the sample rate", () => {
    const a = bandRanges(48000);
    const b = bandRanges(44100);
    expect(b.bass[1]).toBeGreaterThanOrEqual(a.bass[1]); // narrower Hz per bin at 44.1k
  });

  it("covers the spec's five bands", () => {
    expect(BAND_HZ.length).toBe(5);
    expect(BAND_HZ.map((b) => b[0])).toEqual([20, 80, 250, 2000, 8000]);
    expect(BAND_HZ.map((b) => b[1])).toEqual([80, 250, 2000, 8000, 16000]);
  });
});

describe("bandLevels", () => {
  it("a peak at ~100 Hz makes bass dominate", () => {
    const lv = levelsOf(toneIn(1));
    expect(lv[1]!).toBeGreaterThan(0.6); // bass
    expect(lv[1]!).toBeGreaterThan(lv[2]!);
    expect(lv[1]!).toBeGreaterThan(lv[3]!);
  });

  it("a peak at ~5 kHz makes high dominate", () => {
    const lv = levelsOf(toneIn(3));
    expect(lv[3]!).toBeGreaterThan(0.6); // high
    expect(lv[3]!).toBeGreaterThan(lv[1]!);
    expect(lv[3]!).toBeGreaterThan(lv[2]!);
  });

  it("a peak in each band lights up that band", () => {
    for (let band = 0; band < 5; band++) {
      const lv = levelsOf(toneIn(band as 0 | 1 | 2 | 3 | 4));
      let best = 0;
      for (let i = 1; i < 5; i++) if (lv[i]! > lv[best]!) best = i;
      expect(best, `band ${band}`).toBe(band);
    }
  });

  it("silence reads as zero, not NaN", () => {
    const lv = levelsOf(new Float32Array(BINS).fill(BAND_DB_FLOOR));
    for (let i = 0; i < 5; i++) {
      expect(Number.isFinite(lv[i]!)).toBe(true);
      expect(lv[i]!).toBeGreaterThanOrEqual(0);
      expect(lv[i]!).toBeLessThanOrEqual(1);
    }
  });

  it("a full-scale tone approaches 1 and a quiet tone approaches 0", () => {
    const loud = levelsOf(toneIn(2, 0));
    const quiet = levelsOf(toneIn(2, -60));
    expect(loud[2]!).toBeGreaterThan(0.9);
    expect(quiet[2]!).toBeLessThan(0.4);
  });

  it("matches the spec's formula", () => {
    // level = clamp((meanDb + 80) / 60, 0, 1)
    const db = new Float32Array(BINS).fill(BAND_DB_FLOOR);
    const r = bandRanges(SR);
    for (let i = r.bass[0]; i <= r.bass[1]; i++) db[i] = -20;
    const lv = levelsOf(db);
    const n = r.bass[1] - r.bass[0] + 1;
    const expected = Math.min(1, Math.max(0, (-20 + BAND_DB_OFFSET) / BAND_DB_SPAN));
    expect(lv[1]!).toBeCloseTo(expected, 4);
    expect(n).toBeGreaterThan(0);
  });
});

describe("smoothing — spec §8.10 attack 0.05 / release 0.35", () => {
  it("rises faster than it falls", () => {
    // Same magnitude, one step up and one step down, from the same point.
    const up = smooth(0.5, 1.0, 0.016);
    const down = smooth(0.5, 0.0, 0.016);
    expect(up - 0.5).toBeGreaterThan(0.5 - down);
  });

  it("uses the spec's time constants", () => {
    expect(FEATURE_ATTACK_TAU).toBe(0.05);
    expect(FEATURE_RELEASE_TAU).toBe(0.35);
  });

  it("is frame-rate independent: same elapsed time, same result", () => {
    let a = 0;
    for (let i = 0; i < 60; i++) a = smooth(a, 1, 1 / 60);
    let b = 0;
    for (let i = 0; i < 6; i++) b = smooth(b, 1, 1 / 6);
    expect(a).toBeCloseTo(b, 3);
  });

  it("converges toward the target without overshooting", () => {
    let v = 0;
    for (let i = 0; i < 200; i++) v = smooth(v, 1, 0.016);
    expect(v).toBeGreaterThan(0.99);
    expect(v).toBeLessThanOrEqual(1);
  });

  it("is a no-op for dt = 0 and for an unchanged target", () => {
    expect(smooth(0.5, 1, 0)).toBe(0.5);
    expect(smooth(0.5, 0.5, 0.016)).toBe(0.5);
  });
});

describe("flux", () => {
  const r = bandRanges(SR);

  it("rises on a rising edge and decays afterwards", () => {
    const loud = toneIn(3, -6);
    const state = { v: 0 };

    // The previous frame sits at the floor, so the only rise is the band itself.
    const prev = new Float32Array(BINS).fill(BAND_DB_FLOOR);
    const jump = flux(loud, prev, r, 0.016, state);
    expect(jump).toBeGreaterThan(0);

    // No change on the next frame → flux should fall.
    const after = flux(loud, loud, r, 0.016, state);
    expect(after).toBeLessThan(jump);
  });

  it("ignores falling edges (only positive differences count)", () => {
    const loud = toneIn(3, -6);
    // Both frames must share the same floor, or the floor itself becomes a
    // *rising* edge outside the band and the test measures the wrong thing.
    const quiet = new Float32Array(BINS).fill(BAND_DB_FLOOR);
    const state = { v: 0 };
    const f = flux(quiet, loud, r, 0.016, state);
    expect(f).toBe(0);
  });

  it("decays toward zero with the spec's tau", () => {
    const loud = toneIn(3, -6);
    const prev = new Float32Array(BINS).fill(BAND_DB_FLOOR);
    const state = { v: 0 };
    flux(loud, prev, r, 0.016, state);
    let v = state.v;
    const first = v;
    for (let i = 0; i < 60; i++) v = decay(0, 0.016, state);
    expect(v).toBeLessThan(first);
    expect(v).toBeGreaterThan(0);
    // After ~1 s of decay at τ = 0.12 s it should be well under 1 % of start.
    for (let i = 0; i < 30; i++) decay(0, 0.016, state);
    expect(state.v / first).toBeLessThan(0.05);
  });

  it("stays within [0,1]", () => {
    const loud = toneIn(4, 0);
    const prev = new Float32Array(BINS).fill(BAND_DB_FLOOR);
    const state = { v: 0 };
    for (let i = 0; i < 50; i++) {
      const f = flux(loud, prev, r, 0.016, state);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
  });

  it("two analyzers do not share flux state", () => {
    // A module-level decay variable would let these interfere.
    const loud = toneIn(3, -6);
    const prev = new Float32Array(BINS).fill(-80);
    const a = { v: 0 };
    const b = { v: 0 };
    flux(loud, prev, r, 0.016, a);
    expect(b.v).toBe(0);
  });
});

describe("rmsToUnit — spec §8.10", () => {
  it("maps silence to 0 and full scale to ~1", () => {
    expect(rmsToUnit(0)).toBe(0);
    expect(rmsToUnit(1e-9)).toBe(0);
    expect(rmsToUnit(1)).toBeCloseTo(1, 6);
  });

  it("is monotonic", () => {
    let prev = -1;
    for (let r = 0.0001; r <= 1; r *= 1.1) {
      const v = rmsToUnit(r);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it("uses the spec's formula", () => {
    const rms = 0.1;
    const db = 20 * Math.log10(rms);
    expect(rmsToUnit(rms)).toBeCloseTo((db + RMS_DB_OFFSET) / RMS_DB_SPAN, 6);
    expect(RMS_DB_OFFSET).toBe(50);
    expect(RMS_DB_SPAN).toBe(40);
  });
});

describe("Analyzer — without a node", () => {
  it("decays to rest instead of leaving stale values (spec §11.8)", () => {
    const a = new Analyzer(null, SR);
    // Seed non-zero values as if it had been reading a loud signal.
    a.features.rms = 1;
    a.features.bass = 1;
    a.features.flux = 1;
    for (let i = 0; i < 200; i++) a.update(0.016);
    expect(a.features.rms).toBeLessThan(0.01);
    expect(a.features.bass).toBeLessThan(0.01);
    expect(a.features.flux).toBeLessThan(0.01);
  });

  it("always produces finite features in [0,1]", () => {
    const a = new Analyzer(null, SR);
    for (let i = 0; i < 100; i++) {
      const f = a.update(0.016);
      for (const k of ["rms", "sub", "bass", "mid", "high", "air", "flux"] as const) {
        expect(Number.isFinite(f[k])).toBe(true);
        expect(f[k]).toBeGreaterThanOrEqual(0);
        expect(f[k]).toBeLessThanOrEqual(1);
      }
    }
  });

  it("exposes usable band ranges", () => {
    const a = new Analyzer(null, SR);
    expect(a.bandRanges.mid[0]).toBeGreaterThan(0);
    expect(a.bandRanges.air[1]).toBeGreaterThan(a.bandRanges.sub[0]);
  });
});
