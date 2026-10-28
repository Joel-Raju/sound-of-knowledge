/**
 * Pitch selection and voicing helpers. Spec §7.4, §7.6.
 *
 * The rule that makes the piece sound coherent (§2.3.1 "the data conducts"):
 * **every pitched note comes from the current chord.** The data chooses *which*
 * chord tone and *when*, never a pitch outside the harmony.
 */
import {
  BELL_MIDI_HI,
  BELL_MIDI_LO,
  PAD_MAX_NOTES,
  PAD_MIDI_HI,
  PAD_MIDI_LO,
  PLUCK_MIDI_HI,
  PLUCK_MIDI_LO,
  SUB_MIDI_HI,
  SUB_MIDI_LO,
} from "../config";
import { MODES, chordPitchClasses } from "./modes";
import { rootMidiOf, type HarmonyState } from "./harmony";
import { clamp, midiToFreq } from "../util/math";

/** Spec §7.4 — the chord spelled as absolute MIDI notes (may exceed C4). */
export function chordMidi(state: HarmonyState): number[] {
  const root = rootMidiOf(state);
  const chord = MODES[state.mode].chords[state.chordIdx] ?? MODES[state.mode].chords[0]!;
  const out: number[] = [];
  for (let i = 0; i < chord.offsets.length; i++) out.push(root + chord.offsets[i]!);
  return out;
}

/** The current chord's pitch classes, ascending. */
export function chordPitchClassSet(state: HarmonyState): number[] {
  const chord = MODES[state.mode].chords[state.chordIdx] ?? MODES[state.mode].chords[0]!;
  return chordPitchClasses(chord.offsets);
}

/**
 * Spec §7.4 — every pitch in `[lo, hi]` whose pitch class belongs to the
 * current chord, ascending and deduped.
 *
 * Iterates MIDI integers directly, so the result is naturally sorted and
 * duplicate-free without any extra work.
 */
export function chordTonesInRange(state: HarmonyState, lo: number, hi: number): number[] {
  const pcs = chordPitchClassSet(state);
  const out: number[] = [];
  const a = Math.ceil(lo);
  const b = Math.floor(hi);
  for (let m = a; m <= b; m++) {
    const pc = ((m % 12) + 12) % 12;
    for (let i = 0; i < pcs.length; i++) {
      if (pcs[i] === pc) {
        out.push(m);
        break;
      }
    }
  }
  return out;
}

/**
 * Spec §7.4 — pad voicing: the chord's pitches folded by octaves into
 * `[52, 79]`, deduped, at most 5 notes.
 *
 * Folding brings each distinct pitch class into the pad's register; deduping
 * then collapses the octaves, because a pad only needs each pitch class once —
 * the octave placement is a mixing decision, not a harmony one.
 */
export function padVoicing(state: HarmonyState): number[] {
  const pcs = chordPitchClassSet(state);
  const out: number[] = [];
  for (let i = 0; i < pcs.length; i++) {
    const pc = pcs[i]!;
    // Lowest MIDI note ≥ PAD_MIDI_LO with this pitch class.
    let m = PAD_MIDI_LO + ((((pc - PAD_MIDI_LO) % 12) + 12) % 12);
    while (m < PAD_MIDI_LO) m += 12;
    if (m > PAD_MIDI_HI) continue; // too high to fold into the pad range
    if (out.indexOf(m) < 0) out.push(m);
  }
  out.sort((a, b) => a - b);
  return out.slice(0, PAD_MAX_NOTES);
}

/**
 * Spec §7.6 — pitch index within a candidate set:
 *   `i = clamp(round((1 - magnitude) * (N-1) + gaussian(0, 0.8)), 0, N-1)`
 *
 * Small edits get **higher** pitches, large edits get lower — so a burst of
 * tiny edits sparkles upward and a big rewrite settles down. `gaussian` is
 * injected so this stays deterministic and testable.
 */
export function pickPitch(
  candidates: readonly number[],
  magnitude: number,
  gaussian: () => number,
  sigma = 0.8,
): number {
  const n = candidates.length;
  if (n === 0) return 0;
  if (n === 1) return candidates[0]!;
  const jitter = gaussian() * sigma;
  const raw = (1 - magnitude) * (n - 1) + jitter;
  const idx = clamp(Math.round(raw), 0, n - 1);
  return candidates[idx]!;
}

/** Bell candidates: upper register, cool glass (§7.6). */
export function bellCandidates(state: HarmonyState): number[] {
  return chordTonesInRange(state, BELL_MIDI_LO, BELL_MIDI_HI);
}

/** Pluck candidates: mid register, warm (§7.6). */
export function pluckCandidates(state: HarmonyState): number[] {
  return chordTonesInRange(state, PLUCK_MIDI_LO, PLUCK_MIDI_HI);
}

/**
 * Spec §7.6 — sub pitch: the chord's **bass** pitch class placed in MIDI
 * `[28, 40]`.
 */
export function subPitch(state: HarmonyState): number {
  const chord = MODES[state.mode].chords[state.chordIdx] ?? MODES[state.mode].chords[0]!;
  const bassPc = (((chord.offsets[0] ?? 0) % 12) + 12) % 12;
  let m = SUB_MIDI_LO + ((((bassPc - SUB_MIDI_LO) % 12) + 12) % 12);
  while (m < SUB_MIDI_LO) m += 12;
  while (m > SUB_MIDI_HI) m -= 12;
  return clamp(m, SUB_MIDI_LO, SUB_MIDI_HI);
}

/**
 * Spec §7.6 — gong pitch: the **key root** pitch class in MIDI `[36, 48]`.
 *
 * Deliberately root-only rather than chord-based: a revert is a statement about
 * the whole key, not about the chord currently under it.
 */
export function gongPitch(state: HarmonyState): number {
  const pc = ((state.rootPc % 12) + 12) % 12;
  let m = 36 + ((((pc - 36) % 12) + 12) % 12);
  while (m < 36) m += 12;
  while (m > 48) m -= 12;
  return clamp(m, 36, 48);
}

/**
 * Spec §7.6 — birth arpeggio pitches: chord tones in `[64, 88]` ascending,
 * starting from `floor(N × 0.2)`, taking every second tone (wrapping).
 */
export function birthPitches(state: HarmonyState): number[] {
  const pool = chordTonesInRange(state, 64, 88);
  if (pool.length === 0) return [];
  const start = Math.floor(pool.length * 0.2);
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    const idx = start + i * 2;
    out.push(pool[((idx % pool.length) + pool.length) % pool.length]!);
  }
  return out;
}

export { midiToFreq };
