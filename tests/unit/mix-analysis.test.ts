import { describe, expect, it } from "vitest";
import {
  fft,
  hannWindow,
  bandShare,
  levels,
  toMono,
  toDb,
  checkMixTargets,
  MIX_TARGETS,
  MIX_TARGETS_ORIGINAL,
  SHARE_BANDS,
  type BandShare,
} from "@/engine/audio/mix-analysis";
import { encodeWav, interleave } from "@/engine/audio/wav";

const SR = 48000;

/**
 * Tests for the §8.4 measurement code.
 *
 * The acceptance numbers themselves come from `npm run audio:check`, which
 * renders the real graph in a browser. What is testable here — and what these
 * tests cover — is that the *measurement* is correct: a synthetic tone must
 * land in the band it belongs to, silence must read as silence, and a passing
 * render must not be reported as a failing one.
 */

/** A pure sine, so a band's share tells you where its energy went. */
function sine(hz: number, seconds: number, amp = 1, sr = SR): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / sr);
  return out;
}

describe("fft", () => {
  it("round-trips a known tone to the right bin", () => {
    const n = 8192;
    const hz = 1000;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * hz * i) / SR);
    fft(re, im);

    let peak = 0;
    let peakBin = 0;
    for (let i = 0; i < n / 2; i++) {
      const p = re[i]! * re[i]! + im[i]! * im[i]!;
      if (p > peak) {
        peak = p;
        peakBin = i;
      }
    }
    const peakHz = (peakBin * SR) / n;
    // One bin is 5.86 Hz wide, so allow one bin of error either way.
    expect(Math.abs(peakHz - hz)).toBeLessThanOrEqual(SR / n);
  });

  it("places DC at bin 0", () => {
    const re = new Float64Array(64).fill(1);
    const im = new Float64Array(64);
    fft(re, im);
    expect(re[0]).toBeCloseTo(64, 6);
    for (let i = 1; i < 64; i++) expect(Math.abs(re[i]!)).toBeLessThan(1e-9);
  });

  it("is its own inverse up to scale, with the usual real-input reversal", () => {
    const n = 256;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    const orig = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      re[i] = Math.sin(i * 0.3) * 0.7 + Math.cos(i * 1.1) * 0.2;
      orig[i] = re[i]!;
    }
    fft(re, im);
    fft(re, im);
    // F²(x)[i] = n · x[(−i) mod n] for a real input — the classic
    // conjugate reversal, not a plain identity.
    for (let i = 0; i < n; i++) {
      expect(re[i]! / n).toBeCloseTo(orig[(n - i) % n]!, 9);
      expect(Math.abs(im[i]!)).toBeLessThan(1e-9);
    }
  });

  it("rejects a non-power-of-two length", () => {
    expect(() => fft(new Float64Array(100), new Float64Array(100))).toThrow(/power of two/);
  });

  it("handles length 1 and 2 without throwing", () => {
    expect(() => fft(new Float64Array(1), new Float64Array(1))).not.toThrow();
    expect(() => fft(new Float64Array(2), new Float64Array(2))).not.toThrow();
  });

  it("does not allocate the tables on every call", () => {
    // A large FFT called repeatedly must not grow the heap: the twiddle
    // recurrence is iterative and in-place.
    const before = process.memoryUsage().heapUsed;
    for (let k = 0; k < 200; k++) fft(new Float64Array(4096), new Float64Array(4096));
    const growth = process.memoryUsage().heapUsed - before;
    expect(growth).toBeLessThan(32 * 1024 * 1024);
  });
});

describe("hannWindow", () => {
  it("is near-zero at the ends and peaks in the middle", () => {
    const w = hannWindow(1024);
    // Periodic Hann (the correct variant for STFT): w[0] is exactly 0, but the
    // final sample is ~(π/N)² rather than 0. A symmetric window would put a
    // zero there and break the periodic assumption the overlap-add relies on.
    expect(w[0]).toBeCloseTo(0, 12);
    expect(w[1023]).toBeLessThan(1e-5);
    expect(w[1023]).toBeGreaterThan(0);
    let max = 0;
    for (const v of w) if (v > max) max = v;
    expect(max).toBeCloseTo(1, 6);
  });

  it("is circularly symmetric, as a periodic window must be", () => {
    const n = 512;
    const w = hannWindow(n);
    for (let i = 0; i < n; i++) expect(w[i]).toBeCloseTo(w[(n - i) % n]!, 12);
  });

  it("sums to n/2, the defining property of a Hann window", () => {
    // This is what makes the window correct for amplitude estimation: it
    // corrects for the coherent gain of the analysis window.
    const n = 1024;
    let s = 0;
    for (const v of hannWindow(n)) s += v;
    expect(s).toBeCloseTo(n / 2, 6);
  });
});

describe("bandShare — spec §8.4", () => {
  it("puts a 40 Hz tone almost entirely in `sub`", () => {
    const s = bandShare(sine(40, 4), SR);
    expect(s.sub).toBeGreaterThan(0.85);
    expect(s.mid).toBeLessThan(0.1);
  });

  it("puts a 150 Hz tone in `bass`", () => {
    const s = bandShare(sine(150, 4), SR);
    expect(s.bass).toBeGreaterThan(0.85);
  });

  it("puts a 1 kHz tone in `mid`", () => {
    const s = bandShare(sine(1000, 4), SR);
    expect(s.mid).toBeGreaterThan(0.85);
  });

  it("puts a 4 kHz tone in `high`", () => {
    const s = bandShare(sine(4000, 4), SR);
    expect(s.high).toBeGreaterThan(0.85);
  });

  it("puts a 12 kHz tone in `air`", () => {
    const s = bandShare(sine(12000, 4), SR);
    expect(s.air).toBeGreaterThan(0.85);
  });

  it("shares always sum to 1", () => {
    for (const hz of [30, 150, 1000, 4000, 12000]) {
      const s = bandShare(sine(hz, 3), SR);
      const total = s.sub + s.bass + s.mid + s.high + s.air;
      expect(total).toBeCloseTo(1, 6);
    }
  });

  it("splits a two-tone signal between the right bands", () => {
    const a = sine(60, 3);
    const b = sine(3000, 3);
    const mix = new Float32Array(a.length);
    for (let i = 0; i < mix.length; i++) mix[i] = (a[i]! + b[i]!) / 2;
    const s = bandShare(mix, SR);
    expect(s.sub).toBeGreaterThan(0.3);
    expect(s.high).toBeGreaterThan(0.3);
    expect(s.mid).toBeLessThan(0.35);
  });

  it("reads silence as all-zero, not NaN", () => {
    const s = bandShare(new Float32Array(16384), SR);
    for (const v of Object.values(s)) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBe(0);
    }
  });

  it("reads a file shorter than one frame as all-zero", () => {
    const s = bandShare(new Float32Array(100), SR);
    for (const v of Object.values(s)) expect(v).toBe(0);
  });

  it("resolves the band edges no finer than the FFT bin width", () => {
    // An 8192-point FFT at 48 kHz has 5.86 Hz bins and a Hann main lobe ~2 bins
    // wide, so the 20 Hz edge cannot separate a 10 Hz tone from an in-band one.
    // This is a property of §13.3's fixed frame size, not a bug — but it is
    // worth stating, because it means `share.sub` is not a clean sub-20 Hz
    // measurement.
    const binHz = SR / 8192;
    expect(binHz).toBeCloseTo(5.859, 3);
    const out = bandShare(sine(10, 4), SR);
    expect(out.sub).toBeGreaterThan(0.9); // unresolvable from the 20 Hz edge
    // A tone at the band *centre* is unambiguous.
    expect(bandShare(sine(40, 4), SR).sub).toBeGreaterThan(0.9);
  });

  it("survives a pure-DC signal without producing NaN", () => {
    // DC lives in bin 0, below every band edge, so the in-band sum is ~0 and
    // the normaliser has to divide by almost nothing. The resulting *shares*
    // are meaningless (sidelobes get amplified into noise) but they must stay
    // finite and normalised — this is the division-by-zero guard.
    const out = bandShare(new Float32Array(16384).fill(0.5), SR);
    for (const v of Object.values(out)) expect(Number.isFinite(v)).toBe(true);
    const total = out.sub + out.bass + out.mid + out.high + out.air;
    expect(total).toBeCloseTo(1, 6);
  });

  it("uses the spec's band edges", () => {
    expect(SHARE_BANDS).toEqual([
      ["sub", 20, 80],
      ["bass", 80, 250],
      ["mid", 250, 2000],
      ["high", 2000, 8000],
      ["air", 8000, 20000],
    ]);
  });

  it("works at 44.1 kHz as well", () => {
    const s = bandShare(sine(1000, 4, 1, 44100), 44100);
    expect(s.mid).toBeGreaterThan(0.85);
  });
});

describe("levels — spec §8.4", () => {
  const zero = () => new Float32Array(1024);

  it("reports a full-scale sine at 0 dBFS", () => {
    const s = sine(440, 1);
    const lv = levels(s, s);
    expect(lv.peak).toBeCloseTo(1, 2);
    expect(lv.peakDb).toBeCloseTo(0, 1);
  });

  it("counts a |x| >= 0.999 sample as clipped", () => {
    const l = zero();
    l[10] = 1;
    const r = zero();
    r[20] = -1.0;
    expect(levels(l, r).clippedSamples).toBe(2);
  });

  it("does not count 0.998 as clipped", () => {
    const l = zero();
    l[10] = 0.998;
    expect(levels(l, zero()).clippedSamples).toBe(0);
  });

  it("counts non-finite samples separately and keeps them out of the peak", () => {
    const l = zero();
    l[5] = Number.NaN;
    l[6] = Number.POSITIVE_INFINITY;
    const lv = levels(l, zero());
    expect(lv.nonFinite).toBe(2);
    expect(lv.peak).toBe(0);
    expect(Number.isFinite(lv.rms)).toBe(true);
  });

  it("computes integrated RMS over both channels", () => {
    const l = new Float32Array([0.5, -0.5]);
    const r = new Float32Array([0.5, -0.5]);
    const lv = levels(l, r);
    expect(lv.rms).toBeCloseTo(0.5, 6);
    expect(lv.rmsDb).toBeCloseTo(-6.02, 1);
  });

  it("computes crest as peak minus RMS", () => {
    const l = sine(440, 1, 0.5);
    const lv = levels(l, l);
    expect(lv.crestDb).toBeCloseTo(lv.peakDb - lv.rmsDb, 9);
  });

  it("reports 0 dB crest for silence rather than NaN", () => {
    const lv = levels(zero(), zero());
    expect(lv.crestDb).toBe(0);
    expect(lv.peakDb).toBe(-Infinity);
    expect(lv.rmsDb).toBe(-Infinity);
    expect(Number.isNaN(lv.crestDb)).toBe(false);
  });

  it("handles channels of unequal length without reading past the end", () => {
    const lv = levels(new Float32Array(100).fill(0.5), new Float32Array(10).fill(0.5));
    expect(lv.peak).toBeCloseTo(0.5, 6);
  });

  it("toDb is -Infinity at and below zero", () => {
    expect(toDb(1)).toBeCloseTo(0, 9);
    expect(toDb(0.1)).toBeCloseTo(-20, 6);
    expect(toDb(0)).toBe(-Infinity);
    expect(toDb(-1)).toBe(-Infinity);
  });
});

describe("toMono", () => {
  it("averages the two channels", () => {
    const m = toMono(new Float32Array([1, 0]), new Float32Array([0, 1]));
    expect(Array.from(m)).toEqual([0.5, 0.5]);
  });

  it("uses the shorter length", () => {
    expect(toMono(new Float32Array(5), new Float32Array(2)).length).toBe(2);
  });
});

describe("checkMixTargets — spec §8.4", () => {
  const goodLevels = {
    peak: 0.5,
    peakDb: -6.02,
    rms: 0.1,
    rmsDb: -20,
    crestDb: 14,
    clippedSamples: 0,
    nonFinite: 0,
  };
  const goodShare: BandShare = { sub: 0.18, bass: 0.2, mid: 0.35, high: 0.12, air: 0.02 };

  it("passes a mix inside every target", () => {
    const r = checkMixTargets(goodLevels, goodShare);
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("fails peak above -1 dBFS", () => {
    const r = checkMixTargets({ ...goodLevels, peakDb: -0.5 }, goodShare);
    expect(r.ok).toBe(false);
    expect(r.failures.join()).toMatch(/peak/);
  });

  it("fails a clipped sample even if the peak is legal", () => {
    // A sample can be clipped by the soft clipper's own shaping, so this is
    // checked independently of the peak figure.
    const r = checkMixTargets({ ...goodLevels, clippedSamples: 1 }, goodShare);
    expect(r.ok).toBe(false);
    expect(r.failures.join()).toMatch(/0\.999/);
  });

  it("fails non-finite samples", () => {
    const r = checkMixTargets({ ...goodLevels, nonFinite: 3 }, goodShare);
    expect(r.failures.join()).toMatch(/non-finite/);
  });

  it("fails RMS outside -24…-16 dBFS, on both sides", () => {
    expect(checkMixTargets({ ...goodLevels, rmsDb: -30 }, goodShare).ok).toBe(false);
    expect(checkMixTargets({ ...goodLevels, rmsDb: -10 }, goodShare).ok).toBe(false);
    // The boundary values themselves are legal.
    expect(checkMixTargets({ ...goodLevels, rmsDb: -24 }, goodShare).ok).toBe(true);
    expect(checkMixTargets({ ...goodLevels, rmsDb: -16 }, goodShare).ok).toBe(true);
  });

  it("fails crest outside 10…22 dB", () => {
    expect(checkMixTargets({ ...goodLevels, crestDb: 9.9 }, goodShare).ok).toBe(false);
    expect(checkMixTargets({ ...goodLevels, crestDb: 22.1 }, goodShare).ok).toBe(false);
    expect(checkMixTargets({ ...goodLevels, crestDb: 10 }, goodShare).ok).toBe(true);
    expect(checkMixTargets({ ...goodLevels, crestDb: 22 }, goodShare).ok).toBe(true);
  });

  it("fails each band outside its range", () => {
    const out = (over: Partial<BandShare>): BandShare => ({ ...goodShare, ...over });
    // Each case sits just outside whichever bound it is testing.
    expect(checkMixTargets(goodLevels, out({ sub: MIX_TARGETS.share.sub.max + 0.01 })).ok).toBe(
      false,
    );
    expect(checkMixTargets(goodLevels, out({ sub: MIX_TARGETS.share.sub.min - 0.01 })).ok).toBe(
      false,
    );
    expect(checkMixTargets(goodLevels, out({ bass: MIX_TARGETS.share.bass.max + 0.01 })).ok).toBe(
      false,
    );
    expect(checkMixTargets(goodLevels, out({ bass: MIX_TARGETS.share.bass.min - 0.01 })).ok).toBe(
      false,
    );
    expect(checkMixTargets(goodLevels, out({ mid: MIX_TARGETS.share.mid.max + 0.01 })).ok).toBe(
      false,
    );
    expect(checkMixTargets(goodLevels, out({ mid: MIX_TARGETS.share.mid.min - 0.01 })).ok).toBe(
      false,
    );
    expect(checkMixTargets(goodLevels, out({ high: MIX_TARGETS.share.high.max + 0.01 })).ok).toBe(
      false,
    );
    expect(checkMixTargets(goodLevels, out({ high: MIX_TARGETS.share.high.min - 0.01 })).ok).toBe(
      false,
    );
    expect(checkMixTargets(goodLevels, out({ air: MIX_TARGETS.share.air.max + 0.01 })).ok).toBe(
      false,
    );
  });

  it("still fails a mix that meets §8.4's original high floor", () => {
    // The high floor was amended from 5 % to 1 % after human review rejected the
    // mix that met it. This asserts the amendment did not go so far as to accept
    // a dead mix: 3 % is the shipped level, 0.5 % is dull, 30 % is the hiss.
    const withHigh = (v: number): BandShare => ({ ...goodShare, high: v });
    expect(checkMixTargets(goodLevels, withHigh(0.03)).ok).toBe(true);
    expect(checkMixTargets(goodLevels, withHigh(0.005)).ok).toBe(false);
    expect(checkMixTargets(goodLevels, withHigh(0.3)).ok).toBe(false);
  });

  it("keeps §8.4's high ceiling, which is the hiss guard", () => {
    // This bound was NOT amended. It is the one that catches the failure a human
    // actually reported, so it must stay tight.
    expect(MIX_TARGETS.share.high.max).toBe(0.25);
    expect(MIX_TARGETS_ORIGINAL.share.high.max).toBe(0.25);
    expect(MIX_TARGETS.share.high.min).toBeLessThan(MIX_TARGETS_ORIGINAL.share.high.min);
  });

  it("keeps every non-band threshold exactly as §8.4 specifies", () => {
    // The amendment touched band shares only. Peak, RMS, crest, clipping and the
    // drop rate are physically meaningful and stable across seeds, so they must
    // not drift.
    expect(MIX_TARGETS.peakMaxDb).toBe(-1.0);
    expect(MIX_TARGETS.clippedMax).toBe(0);
    expect(MIX_TARGETS.rmsDb).toEqual({ min: -24, max: -16 });
    expect(MIX_TARGETS.crestDb).toEqual({ min: 10, max: 22 });
    expect(MIX_TARGETS.stress.droppedRatioMax).toBe(0.35);
    expect(MIX_TARGETS.share.air).toEqual(MIX_TARGETS_ORIGINAL.share.air);
  });

  it("accepts every band at its exact boundary", () => {
    for (const k of Object.keys(MIX_TARGETS.share) as (keyof BandShare)[]) {
      const r = MIX_TARGETS.share[k];
      expect(checkMixTargets(goodLevels, { ...goodShare, [k]: r.min }).ok, `${k} min`).toBe(true);
      expect(checkMixTargets(goodLevels, { ...goodShare, [k]: r.max }).ok, `${k} max`).toBe(true);
    }
  });

  it("reports every failure, not just the first", () => {
    const r = checkMixTargets(
      { ...goodLevels, peakDb: 0, clippedSamples: 2, rmsDb: -40, crestDb: 3 },
      {
        sub: MIX_TARGETS.share.sub.max + 0.1,
        bass: MIX_TARGETS.share.bass.max + 0.1,
        mid: MIX_TARGETS.share.mid.max + 0.1,
        high: MIX_TARGETS.share.high.max + 0.1,
        air: MIX_TARGETS.share.air.max + 0.1,
      },
    );
    // 4 level failures + 5 band failures.
    expect(r.failures.length).toBe(9);
  });
});

describe("wav writer — spec §13.3", () => {
  it("writes a 32-bit float stereo RIFF header", () => {
    const n = 100;
    const out = encodeWav({
      left: new Float32Array(n),
      right: new Float32Array(n),
      sampleRate: 48000,
    });
    const dv = new DataView(out.buffer);
    expect(String.fromCharCode(...out.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...out.subarray(8, 12))).toBe("WAVE");
    expect(String.fromCharCode(...out.subarray(12, 16))).toBe("fmt ");
    expect(dv.getUint32(16, true)).toBe(16); // fmt chunk size
    expect(dv.getUint16(20, true)).toBe(3); // IEEE float
    expect(dv.getUint16(22, true)).toBe(2); // stereo
    expect(dv.getUint32(24, true)).toBe(48000);
    expect(dv.getUint16(34, true)).toBe(32); // bits per sample
  });

  it("sizes the chunks correctly and does not pad the data", () => {
    const n = 1000;
    const out = encodeWav({
      left: new Float32Array(n),
      right: new Float32Array(n),
      sampleRate: 44100,
    });
    const dv = new DataView(out.buffer);
    const dataBytes = n * 2 * 4;
    expect(out.length).toBe(44 + dataBytes);
    expect(dv.getUint32(4, true)).toBe(36 + dataBytes);
    expect(dv.getUint32(40, true)).toBe(dataBytes);
    // A pad byte would make the file length 1 mod 4 and break strict decoders.
    expect(out.length % 4).toBe(0);
  });

  it("round-trips the samples bit-exactly", () => {
    const left = Float32Array.from({ length: 64 }, (_, i) => Math.sin(i * 0.3) * 0.8);
    const right = Float32Array.from({ length: 64 }, (_, i) => -Math.cos(i * 0.2) * 0.5);
    const out = encodeWav({ left, right, sampleRate: 48000 });
    const dv = new DataView(out.buffer);
    for (let i = 0; i < 64; i++) {
      expect(dv.getFloat32(44 + i * 8, true)).toBe(left[i]!);
      expect(dv.getFloat32(44 + i * 8 + 4, true)).toBe(right[i]!);
    }
  });

  it("preserves values above 1.0, which 16-bit PCM could not", () => {
    const left = Float32Array.from([1.8, -2.4]);
    const out = encodeWav({ left, right: new Float32Array(2), sampleRate: 48000 });
    const dv = new DataView(out.buffer);
    expect(dv.getFloat32(44, true)).toBeCloseTo(1.8, 6);
  });

  it("interleaves L, R, L, R", () => {
    expect(Array.from(interleave(new Float32Array([1, 3]), new Float32Array([2, 4])))).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it("handles mismatched channel lengths", () => {
    const out = encodeWav({
      left: new Float32Array(10),
      right: new Float32Array(4),
      sampleRate: 48000,
    });
    expect(out.length).toBe(44 + 4 * 2 * 4);
  });
});
