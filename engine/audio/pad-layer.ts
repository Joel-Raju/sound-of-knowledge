/**
 * Continuous layers: chord pad, drone, and air. Spec §8.8.
 *
 * These are the only long-lived voices, and the oscillator budget is tight by
 * design — spec §8.8 caps them at 22 total. Two pad banks × 5 pitches × 2
 * oscillators = 20, plus 2 drone = 22 exactly. The air layer reuses a single
 * noise buffer and costs no oscillator.
 *
 * Cross-fading rather than retriggering is what keeps the pad from clicking and
 * lets the harmony drift underneath a continuous bed (§2.2.6).
 *
 * The air layer was deleted for one commit (918d6f6) on the strength of hiss
 * reports that later turned out to describe a cached file rather than the
 * render. It is restored here at §8.8's exact values. See `DECISIONS.md`.
 */
import {
  AIR_BANDPASS_HZ,
  AIR_BANDPASS_Q,
  AIR_GAIN_MAX,
  AIR_GAIN_MIN,
  AIR_HIGHPASS_HZ,
  AIR_LOOP_SEC,
  DRONE_ROOT_GAIN,
  DRONE_GLIDE_TC,
  DRONE_SUB_GAIN,
  PAD_CUTOFF_BASE_HZ,
  PAD_CUTOFF_ENERGY_HZ,
  PAD_CUTOFF_WOBBLE_HZ,
  PAD_FADE_IN_TC,
  PAD_FADE_OUT_TC,
  PAD_LOWPASS_Q,
  PAD_MAX_OSCILLATORS,
  PAD_OSC_DETUNE_CENTS,
  PAD_OSC_SAW_GAIN,
  PAD_OSC_TRI_GAIN,
  PAD_STOP_AFTER_SEC,
  ROOT_MIDI_BASE,
  TIER_PARAMS,
} from "../config";
import type { HarmonyState } from "../music/harmony";
import { padVoicing } from "../music/pitch";
import type { Tier } from "../types";
import { mulberry32 } from "../util/random";
import { lerp } from "../util/math";

/** Fixed seed for the air buffer so the offline render is reproducible. */
const NOISE_SEED = 1;

export interface PadLayerOptions {
  tier: Tier;
  /** where the pad, drone and air connect (the FX chain's buses) */
  padBus: AudioNode;
  droneBus: AudioNode;
  airBus: AudioNode;
}

interface PadBank {
  gain: GainNode;
  filter: BiquadFilterNode;
  oscs: OscillatorNode[];
  /** true once the bank has been scheduled to stop */
  retiring: boolean;
}

/**
 * Paul Kellet's pink-noise approximation. Pink rather than white because white
 * reads as hiss, while pink's ~1/f slope sits under music without drawing
 * attention to itself — the reason §8.8 specifies it.
 *
 * Pure and unit-testable: returns the samples, no Web Audio involved.
 */
export function pinkNoise(length: number, seed = 1): Float32Array {
  const out = new Float32Array(length);
  const rnd = mulberry32(seed);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < length; i++) {
    const white = rnd() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
    b6 = white * 0.115926;
  }
  return out;
}

/** Air gain for a given energy (spec §8.8). */
export function airGain(energy: number): number {
  return lerp(AIR_GAIN_MIN, AIR_GAIN_MAX, energy);
}

/** Pad cutoff in Hz for a given energy and time (spec §8.8). */
export function padCutoffHz(energy: number, t: number): number {
  return (
    PAD_CUTOFF_BASE_HZ + PAD_CUTOFF_ENERGY_HZ * energy + PAD_CUTOFF_WOBBLE_HZ * Math.sin(0.2 * t)
  );
}

/**
 * Oscillators a bank needs for a voicing (spec §8.8): two per pitch on
 * high/medium tiers, one (triangle) on low.
 */
export function oscillatorsForVoicing(tier: Tier, voicing: readonly number[]): number {
  return TIER_PARAMS[tier].padOscPerNote * voicing.length;
}

/**
 * Total continuous oscillators for a two-bank pad plus the drone. Spec §8.8
 * caps this at 22 — exposed so a test can assert we are not silently over.
 */
export function plannedOscillators(tier: Tier, voicing: readonly number[]): number {
  return oscillatorsForVoicing(tier, voicing) * 2 + 2;
}

export class PadLayer {
  private banks: PadBank[] = [];
  private droneOscs: OscillatorNode[] = [];
  private droneGains: GainNode[] = [];
  private airSource: AudioBufferSourceNode | null = null;
  private airGainNode: GainNode | null = null;
  private airFilterLp: BiquadFilterNode | null = null;
  private airFilterBp: BiquadFilterNode | null = null;
  private lastCutoffAt = -1;
  private lastEnergy = 0;

  private readonly tier: Tier;
  private readonly buses: { pad: AudioNode; drone: AudioNode; air: AudioNode };
  private state: HarmonyState | null = null;
  private started = false;

  constructor(opts: PadLayerOptions) {
    this.tier = opts.tier;
    this.buses = { pad: opts.padBus, drone: opts.droneBus, air: opts.airBus };
  }

  /**
   * Mute the air layer without tearing it down, so a probe can A/B it from a
   * single build. `false` restores the energy-driven curve on the next
   * `setEnergy` call.
   */
  setAirMuted(muted: boolean): void {
    if (!this.airGainNode) return;
    if (muted) {
      this.lastEnergy = -1; // mark for immediate refresh
      try {
        this.airGainNode.gain.cancelScheduledValues(this.lastCutoffAt);
        this.airGainNode.gain.setTargetAtTime(0, this.lastCutoffAt, 0.05);
      } catch {
        /* node gone */
      }
    } else {
      try {
        this.airGainNode.gain.cancelScheduledValues(this.lastCutoffAt);
        this.airGainNode.gain.setTargetAtTime(airGain(this.lastEnergy), this.lastCutoffAt, 0.1);
      } catch {
        /* node gone */
      }
    }
  }

  /** The air layer's output gain, for tests and probes. */
  get airOutput(): GainNode | null {
    return this.airGainNode;
  }

  get oscillatorCount(): number {
    let n = 0;
    for (const b of this.banks) n += b.oscs.length;
    return n + this.droneOscs.length;
  }

  get budget(): number {
    return PAD_MAX_OSCILLATORS;
  }

  /**
   * Start the continuous layers (spec §8.13). Called once, after the context
   * exists — never before a user gesture.
   */
  start(state: HarmonyState, ctx: BaseAudioContext): void {
    if (this.started) return;
    this.started = true;
    this.state = state;

    // Pad bank A immediately, so the bed is present from the first frame.
    this.createBank(state, ctx, ctx.currentTime);

    // --- Drone (§8.8) -----------------------------------------------------
    const now = ctx.currentTime;
    for (const [semi, gainValue] of [
      [-12, DRONE_SUB_GAIN],
      [0, DRONE_ROOT_GAIN],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = midiToHz(ROOT_MIDI_BASE + state.rootPc + semi);
      const g = ctx.createGain();
      g.gain.value = gainValue;
      osc.connect(g);
      g.connect(this.buses.drone);
      osc.start(now);
      this.droneOscs.push(osc);
      this.droneGains.push(g);
    }

    // --- Air (§8.8) -------------------------------------------------------
    const len = Math.round(AIR_LOOP_SEC * ctx.sampleRate);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    buf.copyToChannel(pinkNoise(len, NOISE_SEED) as Float32Array<ArrayBuffer>, 0);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;

    const lp = ctx.createBiquadFilter();
    lp.type = "highpass";
    lp.frequency.value = AIR_HIGHPASS_HZ;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = AIR_BANDPASS_HZ;
    bp.Q.value = AIR_BANDPASS_Q;

    const g = ctx.createGain();
    g.gain.value = AIR_GAIN_MIN;

    src.connect(lp);
    lp.connect(bp);
    bp.connect(g);
    g.connect(this.buses.air);
    src.start(now);

    this.airSource = src;
    this.airGainNode = g;
    this.airFilterLp = lp;
    this.airFilterBp = bp;
  }

  /**
   * Spec §8.8 — react to a harmony event at audio time `at`.
   *
   * Cross-fades a fresh bank in over the old one and retires the old bank
   * 9 s later. On low tier the bank uses triangle only, halving the
   * oscillator count so the pad stays inside the §8.8 budget.
   */
  onHarmony(state: HarmonyState, ctx: BaseAudioContext, at: number): void {
    this.state = state;
    if (!this.started) return;

    const fresh = this.createBank(state, ctx, at);
    for (const b of this.banks) {
      if (b === fresh || b.retiring) continue;
      b.retiring = true;
      b.gain.gain.cancelScheduledValues(at);
      b.gain.gain.setTargetAtTime(0, at, PAD_FADE_OUT_TC);
      for (const o of b.oscs) {
        try {
          o.stop(at + PAD_STOP_AFTER_SEC);
          o.onended = () => {
            try {
              o.disconnect();
            } catch {
              /* already detached */
            }
          };
        } catch {
          /* already stopped */
        }
      }
      const drop = b;
      b.oscs.length = 0;
      this.banks = this.banks.filter((x) => x !== drop);
    }

    // Drone glides to the new root (§8.8).
    for (let i = 0; i < this.droneOscs.length; i++) {
      const semi = i === 0 ? -12 : 0;
      const f = midiToHz(ROOT_MIDI_BASE + state.rootPc + semi);
      try {
        const p = this.droneOscs[i]!.frequency;
        p.cancelScheduledValues(at);
        p.setTargetAtTime(f, at, DRONE_GLIDE_TC);
      } catch {
        /* node gone */
      }
    }
  }

  /**
   * Spec §8.8 — once-per-second smoothing of the pad cutoff and the air gain.
   * Called from the frame loop; internally rate-limited to 1 Hz so the
   * AudioParam writes do not become a per-frame cost.
   */
  setEnergy(energy: number, now: number): void {
    this.lastEnergy = energy;
    if (!this.started) return;
    if (this.lastCutoffAt >= 0 && now - this.lastCutoffAt < 1) return;
    this.lastCutoffAt = now;

    const cutoff = padCutoffHz(energy, now);
    for (const b of this.banks) {
      try {
        b.filter.frequency.setTargetAtTime(cutoff, now, 1.5);
      } catch {
        /* node gone */
      }
    }
    if (this.airGainNode) {
      try {
        this.airGainNode.gain.setTargetAtTime(airGain(energy), now, 1.0);
      } catch {
        /* node gone */
      }
    }
  }

  private createBank(state: HarmonyState, ctx: BaseAudioContext, at: number): PadBank {
    const voicing = padVoicing(state);
    const gain = ctx.createGain();
    // Start closed; §8.8 cross-fades in with setTargetAtTime(1, T, 1.4).
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(1, at, PAD_FADE_IN_TC);

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = PAD_LOWPASS_Q;
    filter.frequency.value = PAD_CUTOFF_BASE_HZ;
    filter.connect(gain);
    gain.connect(this.buses.pad);

    const oscs: OscillatorNode[] = [];
    const perNote = TIER_PARAMS[this.tier].padOscPerNote;
    // Oscillators start a hair early so the cross-fade has something to fade
    // *in* from, rather than an abrupt onset (§8.8: start(T − 0.01)).
    const startAt = Math.max(ctx.currentTime, at - 0.01);

    for (const midi of voicing) {
      const freq = midiToHz(midi);
      // Two detuned oscillators per note; a single one sounds synthetic.
      const defs: { type: OscillatorType; gain: number; detune: number }[] =
        perNote >= 2
          ? [
              { type: "sawtooth", gain: PAD_OSC_SAW_GAIN, detune: -PAD_OSC_DETUNE_CENTS },
              { type: "triangle", gain: PAD_OSC_TRI_GAIN, detune: PAD_OSC_DETUNE_CENTS },
            ]
          : [{ type: "triangle", gain: PAD_OSC_TRI_GAIN, detune: 0 }];

      for (const d of defs) {
        const osc = ctx.createOscillator();
        osc.type = d.type;
        osc.frequency.value = freq;
        osc.detune.value = d.detune;
        const g = ctx.createGain();
        g.gain.value = d.gain;
        osc.connect(g);
        g.connect(filter);
        osc.start(startAt);
        oscs.push(osc);
      }
    }

    const bank: PadBank = { gain, filter, oscs, retiring: false };
    this.banks.push(bank);
    return bank;
  }

  dispose(): void {
    for (const b of this.banks) {
      for (const o of b.oscs) {
        try {
          o.stop();
          o.disconnect();
        } catch {
          /* already gone */
        }
      }
      try {
        b.gain.disconnect();
        b.filter.disconnect();
      } catch {
        /* already gone */
      }
    }
    this.banks.length = 0;
    for (const o of this.droneOscs) {
      try {
        o.stop();
        o.disconnect();
      } catch {
        /* already gone */
      }
    }
    this.droneOscs.length = 0;
    this.droneGains.length = 0;
    for (const n of [this.airSource, this.airGainNode, this.airFilterLp, this.airFilterBp]) {
      try {
        if (n && "stop" in n) (n as AudioBufferSourceNode).stop();
        n?.disconnect();
      } catch {
        /* already gone */
      }
    }
    this.airSource = null;
    this.airGainNode = null;
    this.started = false;
  }
}

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}
