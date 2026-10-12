/**
 * Continuous layers: chord pad and drone. Spec §8.8.
 *
 * These are the only long-lived voices, and the oscillator budget is tight by
 * design — spec §8.8 caps them at 22 total. Two pad banks × 5 pitches × 2
 * oscillators = 20, plus 2 drone = 22 exactly.
 *
 * Cross-fading rather than retriggering is what keeps the pad from clicking and
 * lets the harmony drift underneath a continuous bed (§2.2.6).
 *
 * **The air layer specified in §8.8 has been removed.** It was a 4 s looped
 * pink-noise buffer through a highpass and bandpass. Human review reported the
 * result as hiss at three successively quieter levels, including at §8.8's own
 * values, which put it ~40 dB below the mix. Removing it was an explicit
 * instruction, given twice. See `DECISIONS.md`.
 */
import {
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

export interface PadLayerOptions {
  tier: Tier;
  /** where the pad and drone connect (the FX chain's buses) */
  padBus: AudioNode;
  droneBus: AudioNode;
}

interface PadBank {
  gain: GainNode;
  filter: BiquadFilterNode;
  oscs: OscillatorNode[];
  /** true once the bank has been scheduled to stop */
  retiring: boolean;
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
  private lastCutoffAt = -1;

  private readonly tier: Tier;
  private readonly buses: { pad: AudioNode; drone: AudioNode };
  private state: HarmonyState | null = null;
  private started = false;

  constructor(opts: PadLayerOptions) {
    this.tier = opts.tier;
    this.buses = { pad: opts.padBus, drone: opts.droneBus };
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
   * Spec §8.8 — once-per-second smoothing of the pad cutoff.
   * Called from the frame loop; internally rate-limited to 1 Hz so the
   * AudioParam writes do not become a per-frame cost.
   */
  setEnergy(energy: number, now: number): void {
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
    this.started = false;
  }
}

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}
