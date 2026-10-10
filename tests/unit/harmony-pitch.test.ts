import { describe, expect, it } from "vitest";
import { MODES, chordPitchClasses, inScale } from "@/engine/music/modes";
import { Harmony, modeForEnergy, rootMidiOf } from "@/engine/music/harmony";
import {
  bellCandidates,
  birthPitches,
  chordMidi,
  chordPitchClassSet,
  chordTonesInRange,
  gongPitch,
  midiToFreq,
  padVoicing,
  pickPitch,
  pluckCandidates,
  subPitch,
} from "@/engine/music/pitch";
import { mulberry32 } from "@/engine/util/random";
import { MODE_NAMES, ROOT_MIDI_BASE, keyName } from "@/engine/config";
import {
  BELL_MIDI_HI,
  BELL_MIDI_LO,
  PAD_MAX_NOTES,
  PAD_MIDI_HI,
  PAD_MIDI_LO,
} from "@/engine/config";
import type { ModeId } from "@/engine/types";

// spec §13.2 row `modes`
describe("MODES tables (spec §7.2, verbatim)", () => {
  it("has all four modes with 7-note scales and 5 chords", () => {
    expect(Object.keys(MODES).sort()).toEqual(["aeolian", "dorian", "lydian", "mixolydian"]);
    for (const id of MODE_NAMES) {
      expect(MODES[id].scale.length).toBe(7);
      expect(MODES[id].chords.length).toBe(5);
    }
  });

  it("every chord's pitch classes lie inside its mode's scale", () => {
    for (const id of MODE_NAMES) {
      const mode = MODES[id];
      for (const chord of mode.chords) {
        for (const off of chord.offsets) {
          const pc = ((off % 12) + 12) % 12;
          expect(inScale(id, pc), `${id} ${chord.name} offset ${off} (pc ${pc})`).toBe(true);
        }
      }
    }
  });

  it("chord offsets are strictly ascending", () => {
    for (const id of MODE_NAMES) {
      for (const chord of MODES[id].chords) {
        for (let i = 1; i < chord.offsets.length; i++) {
          expect(chord.offsets[i]!).toBeGreaterThan(chord.offsets[i - 1]!);
        }
      }
    }
  });

  it("each mode has exactly one tonic chord, and it is the first", () => {
    for (const id of MODE_NAMES) {
      const tonics = MODES[id].chords.filter((c) => c.tonic);
      expect(tonics.length).toBe(1);
      expect(tonics[0]).toBe(MODES[id].chords[0]);
      // The tonic chord must be rooted on the scale's first degree (0).
      expect(MODES[id].chords[0]!.offsets[0]).toBe(0);
    }
  });

  it("scales contain 7 distinct pitch classes", () => {
    for (const id of MODE_NAMES) {
      const set = new Set(MODES[id].scale);
      expect(set.size).toBe(7);
    }
  });

  it("chordPitchClasses dedupes and sorts", () => {
    // aeolian bVIIadd9 [10,14,17,24] → pcs 10,2,5,0
    expect(chordPitchClasses([10, 14, 17, 24])).toEqual([0, 2, 5, 10]);
    expect(chordPitchClasses([0, 0, 0])).toEqual([0]);
  });

  it("inScale handles negatives and >11", () => {
    expect(inScale("dorian", 0)).toBe(true);
    expect(inScale("dorian", 14)).toBe(true); // 14 % 12 = 2, dorian ✓
    expect(inScale("dorian", -2)).toBe(true); // -2 % 12 = 10, dorian ✓
    expect(inScale("dorian", 1)).toBe(false); // 1 is not in dorian
  });
});

// spec §13.2 row `harmony`
describe("Harmony — chord selection (§7.4)", () => {
  it("never repeats a chord", () => {
    const h = new Harmony(mulberry32(7));
    let prev = h.getState().chordIdx;
    for (let bar = 0; bar < 4000; bar++) {
      h.onBar(bar, 0.5, bar);
      const now = h.getState().chordIdx;
      // Only compare when a chord change actually happened (every 4 bars).
      if (bar % 4 === 0) expect(now).not.toBe(prev);
      prev = now;
    }
  });

  it("tonic-return probability is ≈ 0.45 ± 0.03 over 10 000 trials", () => {
    // Start each trial on a known non-tonic chord, cycling through all modes.
    let returns = 0;
    const trials = 10000;
    for (let i = 0; i < trials; i++) {
      const mode = MODE_NAMES[i % MODE_NAMES.length]!;
      const nonTonic = MODES[mode].chords.findIndex((c) => !c.tonic);
      const hh = new Harmony(mulberry32(i + 1), {
        rootPc: 0,
        mode,
        chordIdx: nonTonic,
        barCounter: 0,
      });
      if (MODES[mode].chords[hh.chooseNextChordIdx()]!.tonic) returns++;
    }
    expect(Math.abs(returns / trials - 0.45)).toBeLessThan(0.03);
  });

  it("from the tonic it never immediately returns to the tonic", () => {
    for (let i = 0; i < 500; i++) {
      // chordIdx 0 is the tonic in every mode.
      const hh = new Harmony(mulberry32(i + 100), {
        rootPc: 0,
        mode: "dorian",
        chordIdx: 0,
        barCounter: 0,
      });
      const idx = hh.chooseNextChordIdx();
      expect(MODES.dorian.chords[idx]!.tonic).toBe(false);
    }
  });

  it("changes the chord every 4 bars and not before", () => {
    const h = new Harmony(mulberry32(11));
    let changes = 0;
    for (let bar = 0; bar < 400; bar++) {
      const ev = h.onBar(bar, 0.5, bar);
      const chordEvents = ev.filter((e) => e.kind === "chord");
      if (bar % 4 === 0) expect(chordEvents.length).toBe(1);
      else expect(chordEvents.length).toBe(0);
      changes += chordEvents.length;
    }
    expect(changes).toBe(100); // 400 bars / 4
  });
});

describe("Harmony — mode selection (§7.4)", () => {
  it("follows the energy bands", () => {
    expect(modeForEnergy(0.0, "lydian")).toBe("aeolian");
    expect(modeForEnergy(0.2, "lydian")).toBe("aeolian");
    expect(modeForEnergy(0.3, "lydian")).toBe("dorian");
    expect(modeForEnergy(0.6, "aeolian")).toBe("mixolydian");
    expect(modeForEnergy(0.8, "aeolian")).toBe("lydian");
    expect(modeForEnergy(1.0, "aeolian")).toBe("lydian");
  });

  it("is hysteretic near boundaries (±0.04)", () => {
    // Spec §7.4 bands: <0.22 aeolian, <0.45 dorian, <0.70 mixolydian, else
    // lydian. So the dorian/mixolydian boundary is **0.45**, not 0.70 —
    // `below` on a mode is the energy at which the *next* mode takes over.
    // Coming from dorian, the candidate only becomes mixolydian at E ≥ 0.45,
    // and hysteresis then holds the current mode within ±0.04 of 0.45.
    expect(modeForEnergy(0.46, "dorian")).toBe("dorian"); // 0.01 from boundary
    expect(modeForEnergy(0.49, "dorian")).toBe("dorian"); // 0.04 — edge of band
    expect(modeForEnergy(0.55, "dorian")).toBe("mixolydian"); // 0.10 — clear
    // Symmetrically from the other side of the same boundary.
    expect(modeForEnergy(0.44, "mixolydian")).toBe("mixolydian");
    // And across the mixolydian/lydian boundary at 0.70.
    expect(modeForEnergy(0.69, "mixolydian")).toBe("mixolydian");
    expect(modeForEnergy(0.75, "mixolydian")).toBe("lydian");
  });

  it("only changes mode at bars % 8 === 0", () => {
    const h = new Harmony(mulberry32(5));
    for (let bar = 0; bar < 800; bar++) {
      // Alternate extreme energies so a mode change is always tempting.
      const e = bar % 2 === 0 ? 0.05 : 0.95;
      const ev = h.onBar(bar, e, bar);
      const modeEvents = ev.filter((x) => x.kind === "mode");
      if (bar % 8 === 0) expect(modeEvents.length).toBeLessThanOrEqual(1);
      else expect(modeEvents.length).toBe(0);
    }
  });

  it("resets to the new mode's tonic on a mode change", () => {
    const h = new Harmony(mulberry32(9), { mode: "dorian", chordIdx: 3 });
    const ev = h.onBar(8, 0.9, 8); // lydian territory
    const modeEv = ev.find((e) => e.kind === "mode");
    expect(modeEv).toBeDefined();
    // The mode event itself must carry the reset-to-tonic state. Bar 8 is also
    // a chord boundary, so a 'chord' event follows immediately and advances the
    // chord again — hence inspecting the mode event rather than final state.
    expect(modeEv!.state.chordIdx).toBe(0);
    expect(MODES[modeEv!.state.mode].chords[0]!.tonic).toBe(true);
  });
});

describe("Harmony — key walk (§7.4)", () => {
  it("walks by +7, +5, +2 or −3", () => {
    const h = new Harmony(mulberry32(13));
    // `chooseNextRootPc` is a pure selector, so assert on its return value.
    const before = h.getState().rootPc;
    const after = h.chooseNextRootPc();
    expect(after).toBeGreaterThanOrEqual(0);
    expect(after).toBeLessThanOrEqual(11);
    const delta = (((after - before) % 12) + 12) % 12;
    expect([7, 5, 2, 9]).toContain(delta); // 9 ≡ −3 (mod 12)
  });

  it("changes the key every 32 bars and never at bar 0", () => {
    const h = new Harmony(mulberry32(17));
    let keyChanges = 0;
    for (let bar = 0; bar < 320; bar++) {
      const ev = h.onBar(bar, 0.5, bar);
      const keys = ev.filter((e) => e.kind === "key");
      if (bar % 32 === 0 && bar > 0) expect(keys.length).toBe(1);
      else expect(keys.length).toBe(0);
      keyChanges += keys.length;
    }
    expect(keyChanges).toBe(9); // bars 32..288
  });

  it("rootMidi is C3 + pitch class", () => {
    expect(ROOT_MIDI_BASE).toBe(48);
    const h = new Harmony(mulberry32(1), { rootPc: 0 });
    expect(rootMidiOf(h.getState())).toBe(48);
    const h2 = new Harmony(mulberry32(1), { rootPc: 7 });
    expect(rootMidiOf(h2.getState())).toBe(55); // G3
  });

  it("keyName reflects the root", () => {
    expect(keyName(0)).toBe("C");
    const h = new Harmony(mulberry32(1), { rootPc: 9 });
    expect(h.keyName).toBe("A");
  });
});

describe("Harmony — determinism", () => {
  it("identical seeds produce identical timelines", () => {
    const run = (): string => {
      const h = new Harmony(mulberry32(4242));
      const evs = h.onBar(0, 0.5, 0);
      for (let bar = 1; bar < 500; bar++) {
        const e = 0.3 + 0.5 * Math.sin(bar / 40);
        for (const ev of h.onBar(bar, e, bar)) evs.push(ev);
      }
      return JSON.stringify(evs);
    };
    expect(run()).toBe(run());
  });

  it("emits events stamped with the audio time they were given", () => {
    const h = new Harmony(mulberry32(2));
    const ev = h.onBar(4, 0.5, 12.5);
    for (const e of ev) expect(e.at).toBe(12.5);
  });
});

// spec §13.2 row `pitch`
describe("pitch — chord tones in range (§7.4)", () => {
  const state = { rootPc: 0, mode: "dorian" as ModeId, chordIdx: 0, barCounter: 0 };

  it("returns ascending, in-range, in-chord pitches", () => {
    const tones = chordTonesInRange(state, 60, 84);
    expect(tones.length).toBeGreaterThan(0);
    for (let i = 1; i < tones.length; i++) {
      expect(tones[i]!).toBeGreaterThan(tones[i - 1]!);
    }
    for (const t of tones) {
      expect(t).toBeGreaterThanOrEqual(60);
      expect(t).toBeLessThanOrEqual(84);
      expect(chordPitchClassSet(state)).toContain(((t % 12) + 12) % 12);
    }
  });

  it("dedupes and never repeats a pitch class twice in an octave", () => {
    const tones = chordTonesInRange(state, 48, 96);
    const seen = new Set(tones);
    expect(seen.size).toBe(tones.length);
    // Within one octave span (12 semitones) each pc appears at most once.
    for (let base = 48; base <= 84; base += 12) {
      const inOct = tones.filter((t) => t >= base && t < base + 12).map((t) => t % 12);
      expect(new Set(inOct).size).toBe(inOct.length);
    }
  });

  it("is empty for an inverted range", () => {
    expect(chordTonesInRange(state, 84, 60)).toEqual([]);
  });

  it("works for every mode and every chord", () => {
    for (const id of MODE_NAMES) {
      for (let ci = 0; ci < MODES[id].chords.length; ci++) {
        const s = { rootPc: 5, mode: id, chordIdx: ci, barCounter: 0 };
        const tones = chordTonesInRange(s, 48, 96);
        expect(tones.length, `${id}/${ci}`).toBeGreaterThan(3);
      }
    }
  });
});

describe("pitch — pad voicing (§7.4)", () => {
  it("stays within [52, 79], deduped, at most 5 notes", () => {
    for (const id of MODE_NAMES) {
      for (let ci = 0; ci < MODES[id].chords.length; ci++) {
        for (const rootPc of [0, 3, 7, 11]) {
          const v = padVoicing({ rootPc, mode: id, chordIdx: ci, barCounter: 0 });
          expect(v.length).toBeLessThanOrEqual(PAD_MAX_NOTES);
          expect(new Set(v).size).toBe(v.length);
          for (const n of v) {
            expect(n).toBeGreaterThanOrEqual(PAD_MIDI_LO);
            expect(n).toBeLessThanOrEqual(PAD_MIDI_HI);
          }
        }
      }
    }
  });

  it("is ascending", () => {
    const v = padVoicing({ rootPc: 0, mode: "lydian", chordIdx: 0, barCounter: 0 });
    for (let i = 1; i < v.length; i++) expect(v[i]!).toBeGreaterThan(v[i - 1]!);
  });
});

describe("pitch — selection (§7.6)", () => {
  const candidates = [60, 62, 64, 66, 68, 70, 72, 74];

  it("small edits are higher, large edits are lower (monotonic in magnitude)", () => {
    const zero = () => 0; // no jitter
    const small = pickPitch(candidates, 0.0, zero);
    const mid = pickPitch(candidates, 0.5, zero);
    const large = pickPitch(candidates, 1.0, zero);
    expect(small).toBe(candidates[candidates.length - 1]!); // highest
    expect(large).toBe(candidates[0]!); // lowest
    expect(small).toBeGreaterThan(mid!);
    expect(mid).toBeGreaterThan(large!);
  });

  it("clamps into range despite jitter", () => {
    for (let i = 0; i < 1000; i++) {
      const v = pickPitch(candidates, 0.5, mulberry32(i), 8); // huge sigma
      expect(candidates).toContain(v);
    }
  });

  it("handles empty and single-element candidate sets", () => {
    expect(pickPitch([], 0.5, () => 0)).toBe(0);
    expect(pickPitch([64], 0.5, () => 0)).toBe(64);
  });

  it("stays in the documented registers for bell and pluck", () => {
    const s = { rootPc: 0, mode: "aeolian" as ModeId, chordIdx: 0, barCounter: 0 };
    for (const t of bellCandidates(s)) {
      expect(t).toBeGreaterThanOrEqual(BELL_MIDI_LO);
      expect(t).toBeLessThanOrEqual(BELL_MIDI_HI);
    }
    for (const t of pluckCandidates(s)) expect(t).toBeGreaterThanOrEqual(64);
  });
});

describe("pitch — sub, gong, birth (§7.6)", () => {
  it("sub pitch is the chord bass in [28, 40]", () => {
    for (const id of MODE_NAMES) {
      for (let ci = 0; ci < MODES[id].chords.length; ci++) {
        const s = { rootPc: 0, mode: id, chordIdx: ci, barCounter: 0 };
        const p = subPitch(s);
        expect(p).toBeGreaterThanOrEqual(28);
        expect(p).toBeLessThanOrEqual(40);
        const bassPc = MODES[id].chords[ci]!.offsets[0]! % 12;
        expect(p % 12).toBe(bassPc);
      }
    }
  });

  it("gong pitch is the key root in [36, 48]", () => {
    for (let rootPc = 0; rootPc < 12; rootPc++) {
      const p = gongPitch({ rootPc, mode: "dorian", chordIdx: 0, barCounter: 0 });
      expect(p).toBeGreaterThanOrEqual(36);
      expect(p).toBeLessThanOrEqual(48);
      expect(p % 12).toBe(rootPc);
    }
  });

  it("birth arpeggio returns 4 notes in [64, 88]", () => {
    for (const id of MODE_NAMES) {
      for (let ci = 0; ci < MODES[id].chords.length; ci++) {
        const p = birthPitches({ rootPc: 0, mode: id, chordIdx: ci, barCounter: 0 });
        expect(p.length).toBe(4);
        for (const n of p) {
          expect(n).toBeGreaterThanOrEqual(64);
          expect(n).toBeLessThanOrEqual(88);
        }
      }
    }
  });

  it("chordMidi spells the chord as absolute notes", () => {
    const m = chordMidi({ rootPc: 0, mode: "dorian", chordIdx: 0, barCounter: 0 });
    expect(m).toEqual([48, 51, 55, 58, 62]); // i9 = 0,3,7,10,14 over C3
  });

  it("midiToFreq matches the spec formula", () => {
    expect(midiToFreq(69)).toBeCloseTo(440, 6);
  });
});
