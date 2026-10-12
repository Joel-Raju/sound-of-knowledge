import { describe, expect, it } from "vitest";
import { renderIr, irLengthFor } from "@/engine/audio/reverb-ir";
import { padDuckAutomation, pingPongTimes, MASTER_COMP_SETTINGS } from "@/engine/audio/fx-chain";
import {
  pinkNoise,
  padCutoffHz,
  airGain,
  oscillatorsForVoicing,
  plannedOscillators,
} from "@/engine/audio/pad-layer";
import { padVoicing } from "@/engine/music/pitch";
import { MODES } from "@/engine/music/modes";
import {
  PAD_CUTOFF_BASE_HZ,
  PAD_CUTOFF_ENERGY_HZ,
  PAD_CUTOFF_WOBBLE_HZ,
  PAD_MAX_OSCILLATORS,
  REVERB_SEND,
  DELAY_SEND,
  PAD_REVERB_SEND,
  PAD_DUCK_GAIN,
  PAD_DUCK_ATTACK_TC,
  PAD_DUCK_RELEASE_AT,
  PAD_DUCK_RELEASE_TC,
  DELAY_STEPS_A,
  DELAY_STEPS_B,
  STEP_SEC,
  TIER_PARAMS,
  AIR_BANDPASS_HZ,
  AIR_BANDPASS_Q,
  AIR_GAIN_MIN,
  AIR_HIGHPASS_HZ,
  AIR_GAIN_MAX,
  IR_PRE_DELAY_SEC,
  MODE_NAMES,
} from "@/engine/config";

const SR = 48000;

function rms(buf: Float32Array, from: number, to: number): number {
  const a = Math.floor(buf.length * from);
  const b = Math.floor(buf.length * to);
  let s = 0;
  let n = 0;
  for (let i = a; i < b; i++) {
    s += buf[i]! * buf[i]!;
    n++;
  }
  return n > 0 ? Math.sqrt(s / n) : 0;
}

// spec T3.3 tests: reverb-ir determinism and decay, pad voicing → frequencies,
// padDuck automation helper.
describe("reverb IR — spec §8.7", () => {
  it("is deterministic for a fixed seed", () => {
    const a = renderIr({ rt60: 1.5, sampleRate: SR, seed: 7 });
    const b = renderIr({ rt60: 1.5, sampleRate: SR, seed: 7 });
    expect(a.length).toBe(2);
    for (let c = 0; c < 2; c++) {
      expect(a[c]!.length).toBe(b[c]!.length);
      for (let i = 0; i < a[c]!.length; i++) expect(a[c]![i]).toBe(b[c]![i]);
    }
  });

  it("differs for a different seed", () => {
    const a = renderIr({ rt60: 1.5, sampleRate: SR, seed: 1 })[0]!;
    const b = renderIr({ rt60: 1.5, sampleRate: SR, seed: 2 })[0]!;
    let same = 0;
    for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
    expect(same / a.length).toBeLessThan(0.5);
  });

  it("decays hard: tail energy is far below the head", () => {
    for (const rt60 of [1.5, 2.5, 3.5]) {
      const ch = renderIr({ rt60, sampleRate: SR })[0]!;
      const head = rms(ch, 0, 0.1);
      const tail = rms(ch, 0.9, 1);
      expect(head).toBeGreaterThan(0);
      expect(tail / head).toBeLessThan(0.05);
    }
  });

  it("has a silent pre-delay (spec §8.7)", () => {
    const ch = renderIr({ rt60: 2.5, sampleRate: SR })[0]!;
    const preSamples = Math.floor(IR_PRE_DELAY_SEC * SR);
    for (let i = 0; i < preSamples; i++) expect(ch[i]).toBe(0);
    // Energy begins right after it.
    let energy = 0;
    for (let i = preSamples; i < preSamples + 64; i++) energy += Math.abs(ch[i]!);
    expect(energy).toBeGreaterThan(0);
  });

  it("channels are independent, so the stereo image is not a point source", () => {
    const [l, r] = renderIr({ rt60: 2.5, sampleRate: SR });
    let same = 0;
    for (let i = 0; i < l!.length; i++) if (l![i] === r![i]) same++;
    // Independent noise agrees on almost nothing.
    expect(same / l!.length).toBeLessThan(0.2);
  });

  it("is finite and bounded everywhere", () => {
    const [l, r] = renderIr({ rt60: 3.5, sampleRate: SR });
    for (const ch of [l!, r!]) {
      for (let i = 0; i < ch.length; i++) {
        if (!Number.isFinite(ch[i]!)) throw new Error(`non-finite at ${i}`);
      }
      // ConvolverNode.normalize = true, so absolute level is not critical, but
      // it must not be wild.
      expect(rms(ch, 0, 1)).toBeLessThan(2);
    }
  });

  it("length matches the tier table (§8.12)", () => {
    for (const tier of ["high", "medium", "low"] as const) {
      expect(irLengthFor(tier)).toBe(TIER_PARAMS[tier].reverbIrSec);
    }
    expect(irLengthFor("high")).toBe(3.5);
    expect(irLengthFor("medium")).toBe(2.5);
    expect(irLengthFor("low")).toBe(1.5);
  });

  it("longer RT60 gives a longer buffer", () => {
    const short = renderIr({ rt60: 1.5, sampleRate: SR })[0]!;
    const long = renderIr({ rt60: 3.5, sampleRate: SR })[0]!;
    expect(long.length).toBeGreaterThan(short.length * 2);
  });
});

describe("pad duck automation — spec §8.7", () => {
  it("produces exactly the two points the spec states", () => {
    const pts = padDuckAutomation(10);
    expect(pts.length).toBe(2);
    expect(pts[0]![0]).toBe(10);
    expect(pts[0]![1]).toBe(PAD_DUCK_GAIN);
    expect(pts[0]![1]).toBe(0.65);
    expect(pts[0]![2]).toBe(PAD_DUCK_ATTACK_TC);
    expect(pts[0]![2]).toBe(0.02);
    expect(pts[1]![0]).toBe(10 + PAD_DUCK_RELEASE_AT);
    expect(pts[1]![1]).toBe(1);
    expect(pts[1]![2]).toBe(PAD_DUCK_RELEASE_TC);
    expect(pts[1]![2]).toBe(0.45);
  });

  it("is a pure function of the trigger time", () => {
    expect(padDuckAutomation(3.5)).toEqual(padDuckAutomation(3.5));
    expect(padDuckAutomation(4)[0]![0]).toBe(4);
  });

  it("is monotonic in time", () => {
    const pts = padDuckAutomation(2);
    expect(pts[1]![0]).toBeGreaterThan(pts[0]![0]);
  });

  it("ducks below unity and recovers to it", () => {
    const [, duckValue] = padDuckAutomation(0)[0]!;
    const [, backValue] = padDuckAutomation(0)[1]!;
    expect(duckValue).toBeLessThan(backValue);
    expect(backValue).toBe(1);
  });
});

describe("mix sends — spec §8.3", () => {
  it("matches the spec values", () => {
    expect(REVERB_SEND).toBe(0.3);
    expect(DELAY_SEND).toBe(0.12);
    expect(PAD_REVERB_SEND).toBe(0.45);
  });

  it("ping-pong times derive from the musical grid", () => {
    const [l, r] = pingPongTimes();
    expect(l).toBeCloseTo(STEP_SEC * DELAY_STEPS_A, 9);
    expect(r).toBeCloseTo(STEP_SEC * DELAY_STEPS_B, 9);
    expect(DELAY_STEPS_A).toBe(3);
    expect(DELAY_STEPS_B).toBe(4);
    // 3/16 and 4/16 notes — a dotted-eighth / quarter ping-pong.
    expect(l).toBeLessThan(r);
  });

  it("compressor settings match §8.7", () => {
    expect(MASTER_COMP_SETTINGS.threshold).toBe(-10);
    expect(MASTER_COMP_SETTINGS.knee).toBe(6);
    expect(MASTER_COMP_SETTINGS.ratio).toBe(8);
    expect(MASTER_COMP_SETTINGS.attack).toBe(0.004);
    expect(MASTER_COMP_SETTINGS.release).toBe(0.2);
  });
});

describe("pad voicing → oscillator plan — spec §8.8", () => {
  it("uses 2 oscillators per note on high/medium and 1 on low", () => {
    for (const tier of ["high", "medium"] as const) {
      expect(oscillatorsForVoicing(tier, [60, 64, 67])).toBe(6);
    }
    expect(oscillatorsForVoicing("low", [60, 64, 67])).toBe(3);
  });

  it("stays inside the 22-oscillator budget for every mode and tier", () => {
    for (const mode of MODE_NAMES) {
      for (let ci = 0; ci < MODES[mode].chords.length; ci++) {
        const voicing = padVoicing({ rootPc: 0, mode, chordIdx: ci, barCounter: 0 });
        for (const tier of ["high", "medium", "low"] as const) {
          const total = plannedOscillators(tier, voicing);
          expect(total, `${mode}/${ci}/${tier}`).toBeLessThanOrEqual(PAD_MAX_OSCILLATORS);
        }
      }
    }
  });

  it("the budget is exactly met at high tier with a 5-note voicing", () => {
    // 2 banks × 5 notes × 2 osc + 2 drone = 22, the §8.8 cap.
    expect(PAD_MAX_OSCILLATORS).toBe(22);
    expect(plannedOscillators("high", [52, 55, 59, 62, 66])).toBe(22);
  });

  it("voicings stay within the pad register for every chord", () => {
    for (const mode of MODE_NAMES) {
      for (let ci = 0; ci < MODES[mode].chords.length; ci++) {
        for (const rootPc of [0, 4, 7, 11]) {
          const v = padVoicing({ rootPc, mode, chordIdx: ci, barCounter: 0 });
          expect(v.length).toBeLessThanOrEqual(5);
          for (const m of v) {
            expect(m).toBeGreaterThanOrEqual(52);
            expect(m).toBeLessThanOrEqual(79);
          }
        }
      }
    }
  });
});

describe("pad cutoff and air gain — spec §8.8", () => {
  it("cutoff rises with energy and wobbles slowly", () => {
    const calm = padCutoffHz(0, 0);
    const busy = padCutoffHz(1, 0);
    expect(busy).toBeGreaterThan(calm);
    expect(calm).toBeCloseTo(PAD_CUTOFF_BASE_HZ, 6);
    expect(busy).toBeCloseTo(PAD_CUTOFF_BASE_HZ + PAD_CUTOFF_ENERGY_HZ, 6);
    // The energy coefficient is below §8.8's 2800 Hz: human review found the
    // melody indistinct against the pad (checklist D6), and the pad's
    // fundamentals sit at 130–392 Hz — right where the plucks' fundamentals
    // live. Darkening the pad moves its energy *below* the melody instead of
    // removing it, which a level cut could not do: the pad is also the mix's
    // only meaningful bass source, and cutting it 4 dB collapsed `bass` from
    // 30 % to 7 %. See `DECISIONS.md`.
    expect(PAD_CUTOFF_ENERGY_HZ).toBe(1400);
    // The wobble is small but present.
    expect(padCutoffHz(0, 0.5)).not.toBeCloseTo(padCutoffHz(0, 0), 3);
  });

  it("keeps the pad cutoff under §8.8's at every energy", () => {
    // §8.8 gives `500 + 2800·E + 120·sin(0.2t)`, which opens to ~3.4 kHz at
    // full energy. Human review found the melody indistinct (checklist D6), so
    // the coefficient is 1400 instead. This asserts the whole envelope sits
    // below the spec's — including the wobble — so the deviation cannot creep.
    const SPEC_ENERGY_HZ = 2800;
    for (let e = 0; e <= 1; e += 0.05) {
      for (let t = 0; t < 31.5; t += 1.7) {
        expect(padCutoffHz(e, t)).toBeLessThan(
          PAD_CUTOFF_BASE_HZ + SPEC_ENERGY_HZ * e + PAD_CUTOFF_WOBBLE_HZ + 1e-6,
        );
      }
    }
    // At the reference energy the pad sits an octave below §8.8's ceiling.
    expect(padCutoffHz(0.6, 0)).toBeCloseTo(500 + 840, 6);
  });

  it("cutoff stays in a sane filter range across the whole energy span", () => {
    for (let e = 0; e <= 1; e += 0.05) {
      for (let t = 0; t < 60; t += 7.3) {
        const f = padCutoffHz(e, t);
        expect(f).toBeGreaterThan(200);
        expect(f).toBeLessThan(4000);
      }
    }
  });

  it("air gain scales between its configured bounds", () => {
    expect(airGain(0)).toBeCloseTo(AIR_GAIN_MIN, 9);
    expect(airGain(1)).toBeCloseTo(AIR_GAIN_MAX, 9);
    expect(airGain(0.5)).toBeGreaterThan(airGain(0));
    expect(airGain(0.5)).toBeLessThan(airGain(1));

    // §8.8's values, unchanged. The air layer was raised to 0.30/0.55 at T3.5 to
    // reach §8.4's 5–25 % high band, and was reported as "strong hiss" — three
    // times, at three progressively quieter settings. Reverted to the spec's
    // own numbers.
    //
    // Two things this establishes, both measured:
    //   1. At the spec's level the air path sits ~40 dB below the mix and is
    //      inaudible, which is evidently the intent.
    //   2. It contributes **nothing** to the measured high band. With the air at
    //      0.025/0.05 `high` read 2.5 %; with it at 0.004/0.02 it still reads
    //      2.4 %. So the hiss bought no band share at all — the premise that
    //      "air is the only source of 2–8 kHz" was true only of the loud
    //      version, where it was the source because it was the only thing loud
    //      enough to measure. See `DECISIONS.md`.
    expect(AIR_BANDPASS_HZ).toBe(2500);
    expect(AIR_HIGHPASS_HZ).toBe(400);
    expect(AIR_GAIN_MIN).toBe(0.004);
    expect(AIR_GAIN_MAX).toBe(0.02);
    // The energy curve is §8.8's own 5x ratio, untouched.
    expect(AIR_GAIN_MAX / AIR_GAIN_MIN).toBeCloseTo(5, 6);
  });

  it("keeps the air layer inaudible relative to the mix", () => {
    // Measured, not asserted against a guessed threshold: run pink noise
    // through the same highpass → bandpass the graph uses, and compare the
    // in-band RMS with the mix (≈ -21 dBFS RMS, from `audio:check`).
    const sr = 48000;
    const n = 48000;
    const noise = pinkNoise(n, 1);

    // Transposed-direct-form II, matching Web Audio's BiquadFilter.
    const biquad = (
      type: "highpass" | "bandpass",
      freq: number,
      q: number,
    ): { process: (input: Float32Array) => Float32Array } => {
      const w0 = (2 * Math.PI * freq) / sr;
      const alpha = Math.sin(w0) / (2 * q);
      const cos = Math.cos(w0);
      const b0 = type === "highpass" ? (1 + cos) / 2 : alpha;
      const b1 = type === "highpass" ? -(1 + cos) : 0;
      const b2 = type === "highpass" ? (1 + cos) / 2 : -alpha;
      const a0 = 1 + alpha;
      const a1 = -2 * cos;
      const a2 = 1 - alpha;
      return {
        process: (input) => {
          const out = new Float32Array(input.length);
          let x1 = 0;
          let x2 = 0;
          let y1 = 0;
          let y2 = 0;
          for (let i = 0; i < input.length; i++) {
            const x0 = input[i]!;
            const y0 =
              (b0 / a0) * x0 + (b1 / a0) * x1 + (b2 / a0) * x2 - (a1 / a0) * y1 - (a2 / a0) * y2;
            x2 = x1;
            x1 = x0;
            y2 = y1;
            y1 = y0;
            out[i] = y0;
          }
          return out;
        },
      };
    };

    const scaled = new Float32Array(n);
    const g = airGain(0.6);
    for (let i = 0; i < n; i++) scaled[i] = noise[i]! * g;

    const filtered = biquad("bandpass", AIR_BANDPASS_HZ, AIR_BANDPASS_Q).process(
      biquad("highpass", AIR_HIGHPASS_HZ, 1).process(scaled),
    );
    let sum = 0;
    for (const v of filtered) sum += v * v;
    const inBandDb = 20 * Math.log10(Math.sqrt(sum / n));

    // The mix sits near -21 dBFS RMS. Human review confirmed the air is not
    // audible there; this test stops anyone raising the gain again without
    // repeating that review.
    expect(inBandDb).toBeLessThan(-55);
  });

  it("keeps the air filter chain exactly as §8.8 specifies", () => {
    // No deviation left here at all: highpass 400 → bandpass 2.5 kHz Q 0.7.
    // Any future change to this layer must be justified against the three
    // rounds of "still a hiss" human review that preceded the revert.
    expect(AIR_HIGHPASS_HZ).toBe(400);
    expect(AIR_BANDPASS_HZ).toBe(2500);
    expect(AIR_BANDPASS_Q).toBe(0.7);
  });
});

describe("pink noise — spec §8.8", () => {
  it("is deterministic and finite", () => {
    const a = pinkNoise(1024, 3);
    const b = pinkNoise(1024, 3);
    expect(Array.from(a)).toEqual(Array.from(b));
    for (const v of a) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(-2);
      expect(v).toBeLessThan(2);
    }
  });

  it("has near-zero mean", () => {
    const n = pinkNoise(48000, 5);
    let s = 0;
    for (const v of n) s += v;
    expect(Math.abs(s / n.length)).toBeLessThan(0.02);
  });

  it("has roughly 1/f slope: more low-frequency than high", () => {
    // Crude band-energy comparison via successive differences: a highpass would
    // amplify the high band, and pink noise should not have that property.
    const n = pinkNoise(65536, 9);
    let diffEnergy = 0;
    let energy = 0;
    for (let i = 1; i < n.length; i++) {
      const d = n[i]! - n[i - 1]!;
      diffEnergy += d * d;
      energy += n[i]! * n[i]!;
    }
    // Differentiating tilts +6 dB/oct; if pink noise were already flat to
    // high frequencies this ratio would approach 1.
    expect(diffEnergy / energy).toBeLessThan(1.2);
  });

  it("differs for a different seed", () => {
    const a = pinkNoise(512, 1);
    const b = pinkNoise(512, 2);
    let same = 0;
    for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
    expect(same / a.length).toBeLessThan(0.1);
  });
});
