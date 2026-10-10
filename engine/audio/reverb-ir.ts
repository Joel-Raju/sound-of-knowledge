/**
 * Procedural reverb impulse response. Spec §8.7.
 *
 * Generated rather than shipped as an audio file: the spec forbids audio
 * samples (§3.2), and it keeps the bundle free of a binary asset.
 *
 * **Deterministic** — the PRNG is seeded, so the offline render harness (§13.3)
 * and the unit tests produce bit-identical IRs. A random IR would make every
 * test run measure a slightly different reverb.
 *
 * The shape is the important part: a short pre-delay, a low-pass that closes
 * over time (so the tail is darker than the attack, as in a real room), and a
 * handful of discrete early reflections in front of the diffuse tail. Those
 * early reflections are what make the space legible as *large* rather than just
 * wet.
 */
import {
  IR_EARLY_AMP_HI,
  IR_EARLY_AMP_LO,
  IR_EARLY_COUNT,
  IR_EARLY_HI,
  IR_EARLY_LO,
  IR_LP_HI,
  IR_LP_LO,
  IR_PRE_DELAY_SEC,
  TIER_PARAMS,
} from "../config";
import { mulberry32 } from "../util/random";
import { lerp } from "../util/math";

/** exp(-6.9078) ≈ 1/1000, so the tail is −60 dB at RT60 (spec §8.7). */
const RT60_DECAY = 6.9078;

export interface IrOptions {
  /** RT60 in seconds — 3.5 / 2.5 / 1.5 by tier (spec §8.12) */
  rt60: number;
  sampleRate: number;
  seed?: number;
}

/**
 * Render a stereo impulse response.
 *
 * `ir[0]` is the left channel, `ir[1]` the right — interleaved so it can be
 * handed straight to `AudioBuffer.copyToChannel` per channel.
 */
export function renderIr(opts: IrOptions): Float32Array[] {
  const { rt60, sampleRate } = opts;
  const seed = opts.seed ?? 0x5eed;
  const n = Math.max(1, Math.round(rt60 * sampleRate));
  const left = new Float32Array(n);
  const right = new Float32Array(n);

  renderChannel(left, rt60, sampleRate, mulberry32(seed));
  // A different seed per channel: correlated noise would collapse the stereo
  // image to a point source.
  renderChannel(right, rt60, sampleRate, mulberry32(seed ^ 0x9e3779b9));

  addEarlyReflections(left, sampleRate, mulberry32(seed ^ 0x1234567));
  addEarlyReflections(right, sampleRate, mulberry32(seed ^ 0x7654321));

  return [left, right];
}

function renderChannel(out: Float32Array, rt60: number, sr: number, rnd: () => number): void {
  let lp = 0;
  const preDelay = Math.round(IR_PRE_DELAY_SEC * sr);

  for (let i = 0; i < out.length; i++) {
    if (i < preDelay) {
      out[i] = 0;
      continue;
    }
    const t = i / sr;
    // -60 dB at RT60.
    const env = Math.exp((-RT60_DECAY * t) / rt60);
    // One-pole low-pass whose coefficient closes over the tail, so late
    // reflections are darker than early ones.
    const a = lerp(IR_LP_LO, IR_LP_HI, Math.min(1, t / rt60));
    const x = rnd() * 2 - 1;
    lp = a * lp + (1 - a) * x;
    out[i] = lp * env;
  }
}

function addEarlyReflections(out: Float32Array, sr: number, rnd: () => number): void {
  for (let k = 0; k < IR_EARLY_COUNT; k++) {
    const t = IR_EARLY_LO + rnd() * (IR_EARLY_HI - IR_EARLY_LO);
    const idx = Math.round(t * sr);
    if (idx <= 0 || idx >= out.length) continue;
    // Amplitude decays across the sequence, as spec §8.7 states (0.5 … 0.15).
    const fall = 1 - k / IR_EARLY_COUNT;
    const amp = lerp(IR_EARLY_AMP_LO, IR_EARLY_AMP_HI, fall) * (rnd() < 0.5 ? -1 : 1);
    out[idx] = (out[idx] ?? 0) + amp;
  }
}

/** Tier-appropriate IR length (spec §8.12). */
export function irLengthFor(tier: keyof typeof TIER_PARAMS): number {
  return TIER_PARAMS[tier].reverbIrSec;
}

/** Pack a stereo IR into an `AudioBuffer`. */
export function irToBuffer(ctx: BaseAudioContext, channels: Float32Array[]): AudioBuffer {
  const buf = ctx.createBuffer(channels.length, channels[0]!.length, ctx.sampleRate);
  for (let c = 0; c < channels.length; c++) {
    buf.copyToChannel(channels[c]! as Float32Array<ArrayBuffer>, c);
  }
  return buf;
}
