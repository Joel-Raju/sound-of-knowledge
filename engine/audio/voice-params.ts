/**
 * Voice parameter construction. Spec §8.11 step 1 and §8.6.
 *
 * A pure function: `(NoteEvent) → { kind, dur, p }`. Kept out of
 * `audio-engine.ts` so the mapping from *musical intent* to *DSP parameters* is
 * unit-testable in Node without an AudioContext — the same reason the DSP
 * classes themselves are pure.
 *
 * Like `engine/audio/allocator.ts` (which the spec explicitly adds to the
 * §5.3 layout), this is a sibling module rather than a listed file.
 */
import {
  MELODIC_DUR_TAU,
  BELL_I0_HI,
  BELL_I0_LO,
  BELL_PITCH_LO_MIDI,
  BELL_PITCH_SPAN_MIDI,
  BELL_RATIOS,
  BELL_TAU_A_HI,
  BELL_TAU_A_LO,
  BELL_TAU_I_RATIO,
  GONG_DURATION,
  GONG_SHIMMER_HZ,
  GONG_TAU0,
  PLUCK_PITCH_LO_MIDI,
  PLUCK_PITCH_SPAN_MIDI,
  PLUCK_TAU_HI,
  PLUCK_TAU_LO,
  SUB_DURATION,
  THUD_DURATION,
  TICK_DURATION,
  VOICE_KINDS,
} from "../config";
import { clamp, lerp } from "../util/math";
import type { NoteEvent } from "../types";

/** Wire encoding of voice kind (§8.5): 0 bell … 5 tick. */
export type VoiceKind = 0 | 1 | 2 | 3 | 4 | 5;

export interface VoiceParams {
  kind: VoiceKind;
  dur: number;
  /** Voice-specific parameters, laid out exactly as §8.6 specifies. */
  p: Float64Array;
}

export function kindOf(voice: NoteEvent["voice"]): VoiceKind {
  const i = VOICE_KINDS.indexOf(voice);
  return (i < 0 ? 0 : i) as VoiceKind;
}

/**
 * Spec §8.6 — derive `dur` and the parameter vector for one note.
 *
 * Durations are deterministic functions of the note alone. That matters
 * beyond tidiness: the main-thread slot allocator (§8.5) needs to know a
 * voice's end time *before* scheduling it, so it can decide whether a slot is
 * free — which is only possible because `dur` is predictable here rather than
 * discovered later from the worklet.
 */
export function buildVoiceParams(note: NoteEvent): VoiceParams {
  const kind = kindOf(note.voice);
  const p = new Float64Array(8);

  switch (note.voice) {
    case "bell": {
      // ratio = [3.5, 3.99, 2.76][edit.id % 3] — three inharmonic ratios so
      // consecutive removals of similar size still differ.
      const idx = Math.abs(Math.floor(note.edit.id)) % BELL_RATIOS.length;
      const ratio = BELL_RATIOS[idx] ?? 3.5;
      const pitchNorm = clamp((note.midi - BELL_PITCH_LO_MIDI) / BELL_PITCH_SPAN_MIDI, 0, 1);
      const tauA = lerp(BELL_TAU_A_LO, BELL_TAU_A_HI, pitchNorm);
      const tauI = BELL_TAU_I_RATIO * tauA;
      // Large removals are less metallic, more pure — I0 falls with magnitude.
      const i0 = lerp(BELL_I0_LO, BELL_I0_HI, 1 - note.edit.magnitude);
      p[0] = ratio;
      p[1] = i0;
      p[2] = tauA;
      p[3] = tauI;
      return { kind, dur: MELODIC_DUR_TAU * tauA, p };
    }
    case "pluck": {
      const t = clamp((note.midi - PLUCK_PITCH_LO_MIDI) / PLUCK_PITCH_SPAN_MIDI, 0, 1);
      const tau1 = lerp(PLUCK_TAU_LO, PLUCK_TAU_HI, t);
      p[0] = tau1;
      return { kind, dur: MELODIC_DUR_TAU * tau1, p };
    }
    case "sub": {
      return { kind, dur: SUB_DURATION, p };
    }
    case "gong": {
      p[0] = GONG_TAU0;
      p[1] = GONG_SHIMMER_HZ;
      return { kind, dur: GONG_DURATION, p };
    }
    case "thud": {
      return { kind, dur: THUD_DURATION, p };
    }
    case "tick": {
      return { kind, dur: TICK_DURATION, p };
    }
  }
}

/** Convert a MIDI note to Hz (spec §7.6). */
export function noteFreq(note: NoteEvent): number {
  return note.midi > 0 ? 440 * Math.pow(2, (note.midi - 69) / 12) : 0;
}
