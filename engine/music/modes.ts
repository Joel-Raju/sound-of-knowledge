/**
 * Mode and chord tables. Spec §7.2 — transcribed **verbatim**.
 *
 * Offsets are semitones above the key root, stacked, and may exceed 12 so that
 * a voicing like Lydian's `Imaj9#11` spells out its structure rather than
 * needing modular arithmetic at every use site. The first element is always the
 * chord's bass.
 *
 * Every chord's pitch classes are verified to lie inside its mode's scale by a
 * unit test (§13.2), so a future edit to these tables cannot silently break the
 * "always sounds like one piece" guarantee in spec §2.3.1.
 */
import type { ModeId } from "../types";

export interface ChordDef {
  name: string;
  /** semitones above the key root; must be strictly ascending */
  offsets: number[];
  /** exactly one chord per mode carries this */
  tonic: boolean;
}

export interface ModeDef {
  /** scale degrees as semitones above the root, 0..11 */
  scale: number[];
  chords: ChordDef[];
}

export const MODES: Record<ModeId, ModeDef> = {
  lydian: {
    scale: [0, 2, 4, 6, 7, 9, 11],
    chords: [
      { name: "Imaj9#11", offsets: [0, 7, 11, 14, 18], tonic: true },
      { name: "II", offsets: [2, 9, 14, 18, 21], tonic: false },
      { name: "iii7", offsets: [4, 11, 14, 19], tonic: false },
      { name: "Vmaj7", offsets: [7, 14, 19, 23], tonic: false },
      { name: "vi7", offsets: [9, 16, 19, 24], tonic: false },
    ],
  },
  mixolydian: {
    scale: [0, 2, 4, 5, 7, 9, 10],
    chords: [
      { name: "I9sus4", offsets: [0, 7, 10, 14, 17], tonic: true },
      { name: "ii7", offsets: [2, 9, 12, 17], tonic: false },
      { name: "IVmaj9", offsets: [5, 9, 12, 16, 19], tonic: false },
      { name: "v7", offsets: [7, 14, 17, 22], tonic: false },
      { name: "bVIImaj7", offsets: [10, 14, 17, 21], tonic: false },
    ],
  },
  dorian: {
    scale: [0, 2, 3, 5, 7, 9, 10],
    chords: [
      { name: "i9", offsets: [0, 3, 7, 10, 14], tonic: true },
      { name: "ii", offsets: [2, 5, 9, 12], tonic: false },
      { name: "IV7", offsets: [5, 9, 12, 15], tonic: false },
      { name: "v7", offsets: [7, 10, 14, 17], tonic: false },
      { name: "bVIImaj7", offsets: [10, 14, 17, 21], tonic: false },
    ],
  },
  aeolian: {
    scale: [0, 2, 3, 5, 7, 8, 10],
    chords: [
      { name: "i7add9", offsets: [0, 3, 7, 10, 14], tonic: true },
      { name: "bIIImaj7", offsets: [3, 7, 10, 14], tonic: false },
      { name: "bVImaj7", offsets: [8, 12, 15, 19], tonic: false },
      { name: "iv7", offsets: [5, 8, 12, 15], tonic: false },
      { name: "bVIIadd9", offsets: [10, 14, 17, 24], tonic: false },
    ],
  },
};

/** Pitch classes (0..11) spanned by a chord's offsets. Sorted ascending. */
export function chordPitchClasses(offsets: readonly number[]): number[] {
  const set = new Set<number>();
  for (let i = 0; i < offsets.length; i++) {
    const pc = ((offsets[i]! % 12) + 12) % 12;
    set.add(pc);
  }
  const out: number[] = [];
  for (const pc of set) out.push(pc);
  out.sort((a, b) => a - b);
  return out;
}

/** True if `pc` belongs to the mode's scale. */
export function inScale(mode: ModeId, pc: number): boolean {
  const scale = MODES[mode].scale;
  const p = ((pc % 12) + 12) % 12;
  for (let i = 0; i < scale.length; i++) if (scale[i] === p) return true;
  return false;
}
