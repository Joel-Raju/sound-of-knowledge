/**
 * Mix chain: reverb, ping-pong delay, pad ducking, master limiter. Spec §8.3,
 * §8.7.
 *
 * Graph (from spec §8.3, with the parts T3.2 stubbed now filled in):
 *
 *   voiceBus ─┬─> voiceBus direct ──────────────────────────> mixBus
 *             ├─> reverbSend ─> Convolver ─> reverbReturn ─────> mixBus
 *             └─> delaySend  ─> ping-pong L/R ────────────────> mixBus
 *   padBus ───┬─> mixBus
 *             └─> padReverbSend ─> Convolver ────────────────> mixBus
 *   drone ────────> mixBus
 *   air   ────────> mixBus
 *   mixBus ─> Compressor ─> SoftClip ─┬─> analyserTap
 *                                      └─> masterGain ─> destination
 *
 * Note the analyser taps **before** `masterGain`, so muting the output does not
 * blank the visuals — a lesson carried over from v1 (`LEGACY-NOTES.md` §3.8).
 */
import {
  COMP_ATTACK,
  COMP_KNEE,
  COMP_RATIO,
  COMP_RELEASE,
  COMP_THRESHOLD_DB,
  DELAY_FEEDBACK,
  DELAY_LP_HZ,
  DELAY_STEPS_A,
  DELAY_STEPS_B,
  DRONE_BUS_GAIN,
  MIX_BUS_GAIN,
  PAD_BUS_GAIN,
  PAD_DUCK_ATTACK_TC,
  PAD_DUCK_GAIN,
  PAD_DUCK_RELEASE_AT,
  PAD_DUCK_RELEASE_TC,
  REVERB_SEND,
  VOICE_BUS_GAIN,
  DELAY_SEND,
  PAD_REVERB_SEND,
  STEP_SEC,
} from "../config";
import { irToBuffer, renderIr } from "./reverb-ir";
import type { Tier } from "../types";

export interface FxChainOptions {
  tier: Tier;
  seed?: number;
}

/** One automation point: `[time, value, timeConstant]`. */
export type AutomationPoint = [number, number, number];

/**
 * Spec §8.7 ducking, as a **pure function** so it can be tested without a
 * Web Audio context:
 *   `padDuck.gain.cancelScheduledValues(T); setTargetAtTime(0.65, T, 0.02);
 *    setTargetAtTime(1.0, T + 0.12, 0.45)`
 */
export function padDuckAutomation(at: number): AutomationPoint[] {
  return [
    [at, PAD_DUCK_GAIN, PAD_DUCK_ATTACK_TC],
    [at + PAD_DUCK_RELEASE_AT, 1, PAD_DUCK_RELEASE_TC],
  ];
}

/** Ping-pong delay times, derived from the musical grid (spec §8.7). */
export function pingPongTimes(): [number, number] {
  return [STEP_SEC * DELAY_STEPS_A, STEP_SEC * DELAY_STEPS_B];
}

export interface FxChain {
  voiceBus: GainNode;
  mixBus: GainNode;
  reverbSend: GainNode;
  delaySend: GainNode;
  padBus: GainNode;
  padDuck: GainNode;
  padReverbSend: GainNode;
  droneBus: GainNode;
  airBus: GainNode;
  reverbConvolver: ConvolverNode;
  delayL: DelayNode;
  delayR: DelayNode;
  dispose(): void;
}

/**
 * Build the mix chain and return handles for the continuous layers to attach to.
 * The engine owns the master chain itself; this owns everything feeding it.
 */
export function buildFxChain(ctx: BaseAudioContext, opts: FxChainOptions): FxChain {
  const rt60 = opts.tier === "high" ? 3.5 : opts.tier === "medium" ? 2.5 : 1.5;
  const ir = renderIr({ rt60, sampleRate: ctx.sampleRate, seed: opts.seed ?? 0x5eed });

  // --- Buses --------------------------------------------------------------
  const voiceBus = ctx.createGain();
  const padBus = ctx.createGain();
  const padDuck = ctx.createGain();
  const mixBus = ctx.createGain();
  const droneBus = ctx.createGain();
  const airBus = ctx.createGain();

  // Explicit rather than left at Web Audio's default of 1.0. See the bus-gain
  // constants in `config.ts`: the pad/notes balance is a tuning decision, and it
  // cannot be one while it is an accident of the voice implementations.
  voiceBus.gain.value = VOICE_BUS_GAIN;
  padBus.gain.value = PAD_BUS_GAIN;
  droneBus.gain.value = DRONE_BUS_GAIN;
  mixBus.gain.value = MIX_BUS_GAIN;

  padBus.connect(padDuck);
  padDuck.connect(mixBus);
  droneBus.connect(mixBus);
  airBus.connect(mixBus);

  // --- Reverb (§8.3) ------------------------------------------------------
  const convolver = ctx.createConvolver();
  // §8.7: normalize = true, so RT60 is independent of IR absolute level.
  convolver.normalize = true;
  convolver.buffer = irToBuffer(ctx, ir);

  const reverbSend = ctx.createGain();
  reverbSend.gain.value = REVERB_SEND;
  const reverbReturn = ctx.createGain();
  reverbReturn.gain.value = 1;

  // The pad gets its own, wetter send (§8.3).
  const padReverbSend = ctx.createGain();
  padReverbSend.gain.value = PAD_REVERB_SEND;

  voiceBus.connect(mixBus); // dry
  voiceBus.connect(reverbSend);
  reverbSend.connect(convolver);
  convolver.connect(reverbReturn);
  reverbReturn.connect(mixBus);

  padDuck.connect(padReverbSend);
  padReverbSend.connect(convolver);

  // --- Ping-pong delay (§8.7) --------------------------------------------
  const delaySend = ctx.createGain();
  delaySend.gain.value = DELAY_SEND;
  const [tL, tR] = pingPongTimes();

  const delayL = ctx.createDelay(2);
  const delayR = ctx.createDelay(2);
  delayL.delayTime.value = tL;
  delayR.delayTime.value = tR;

  const fb = ctx.createGain();
  fb.gain.value = DELAY_FEEDBACK;
  const fbFilter = ctx.createBiquadFilter();
  fbFilter.type = "lowpass";
  fbFilter.frequency.value = DELAY_LP_HZ;

  // Cross-feedback in opposite directions is what makes it "ping-pong".
  voiceBus.connect(delaySend);
  delaySend.connect(delayL);
  delayL.connect(delayR);
  delayR.connect(fb);
  fb.connect(fbFilter);
  fbFilter.connect(delayL);
  delayL.connect(mixBus);
  delayR.connect(mixBus);

  const nodes: AudioNode[] = [
    voiceBus,
    mixBus,
    reverbSend,
    reverbReturn,
    padBus,
    padDuck,
    padReverbSend,
    droneBus,
    convolver,
    delaySend,
    delayL,
    delayR,
    fb,
    fbFilter,
  ];

  return {
    voiceBus,
    mixBus,
    reverbSend,
    delaySend,
    padBus,
    padDuck,
    padReverbSend,
    droneBus,
    airBus,
    reverbConvolver: convolver,
    delayL,
    delayR,
    dispose(): void {
      for (let i = 0; i < nodes.length; i++) {
        try {
          nodes[i]!.disconnect();
        } catch {
          /* already detached */
        }
      }
    },
  };
}

/** Compressor + soft clipper settings shared by the engine and the tests. */
export const MASTER_COMP_SETTINGS = {
  threshold: COMP_THRESHOLD_DB,
  knee: COMP_KNEE,
  ratio: COMP_RATIO,
  attack: COMP_ATTACK,
  release: COMP_RELEASE,
} as const;
