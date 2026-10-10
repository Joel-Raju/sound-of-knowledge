/**
 * Harmony state machine. Spec §7.4.
 *
 * One object owns "where are we in the piece": root pitch class, mode, current
 * chord, and bar counter. It advances on bar boundaries and emits
 * `HarmonyEvent`s stamped with **audio time**, which the pad layer (§8.8) and
 * the palette (§9.3) both consume.
 *
 * All randomness is injected, so the whole state machine is deterministic under
 * a seed — a requirement of §13.2 ("deterministic with seeded RNG").
 */
import {
  CHORD_BARS,
  KEY_CHANGE_BARS,
  KEY_WALK_OFFSETS,
  KEY_WALK_WEIGHTS,
  MODE_ENERGY_BOUNDS,
  MODE_HYSTERESIS,
  PHRASE_BARS,
  ROOT_MIDI_BASE,
  TONIC_RETURN_P,
} from "../config";
import { MODES, type ChordDef } from "./modes";
import { weighted, type Rng } from "../util/random";
import { keyName } from "../config";
import type { ModeId } from "../types";

export interface HarmonyState {
  /** absolute root pitch class, 0..11 */
  rootPc: number;
  mode: ModeId;
  chordIdx: number;
  barCounter: number;
}

export type HarmonyEventKind = "chord" | "mode" | "key";

export interface HarmonyEvent {
  kind: HarmonyEventKind;
  /** audio-clock time the change takes effect */
  at: number;
  state: HarmonyState;
  /** chord name, for the debug overlay */
  chordName: string;
}

/** C3 = 48 (spec §7.4). */
export function rootMidiOf(state: HarmonyState): number {
  return ROOT_MIDI_BASE + state.rootPc;
}

export function currentChord(state: HarmonyState): ChordDef {
  return MODES[state.mode].chords[state.chordIdx] ?? MODES[state.mode].chords[0]!;
}

export function isTonic(state: HarmonyState): boolean {
  return currentChord(state).tonic;
}

/**
 * Spec §7.4 — `modeForEnergy(E, current)`.
 *
 * Boundaries: E < 0.22 aeolian · < 0.45 dorian · < 0.70 mixolydian · else lydian.
 * Hysteresis: keep the current mode if E is within ±0.04 of the boundary that
 * separates it from the candidate, so a slowly drifting E cannot flip the mode
 * on every phrase boundary and produce audible seams.
 */
export function modeForEnergy(e: number, current: ModeId): ModeId {
  let candidate: ModeId = "lydian";
  for (let i = 0; i < MODE_ENERGY_BOUNDS.length; i++) {
    const b = MODE_ENERGY_BOUNDS[i]!;
    if (e < b.below) {
      candidate = b.mode;
      break;
    }
  }
  if (candidate === current) return current;

  // Only the boundary between the current mode and the candidate can veto.
  const boundary = boundaryBetween(current, candidate);
  if (boundary !== null && Math.abs(e - boundary) <= MODE_HYSTERESIS) return current;
  return candidate;
}

/** The energy value that separates two adjacent modes, or null if not adjacent. */
function boundaryBetween(a: ModeId, b: ModeId): number | null {
  const bounds = MODE_ENERGY_BOUNDS;
  for (let i = 0; i < bounds.length - 1; i++) {
    const lo = bounds[i]!;
    const hi = bounds[i + 1]!;
    if ((lo.mode === a && hi.mode === b) || (lo.mode === b && hi.mode === a)) {
      return lo.below;
    }
  }
  return null;
}

export class Harmony {
  private state: HarmonyState;
  private readonly rng: Rng;

  constructor(rng: Rng, initial?: Partial<HarmonyState>) {
    this.rng = rng;
    // Spec §7.4 initial state: C, dorian, tonic chord.
    this.state = {
      rootPc: 0,
      mode: "dorian",
      chordIdx: 0,
      barCounter: 0,
      ...initial,
    };
  }

  getState(): HarmonyState {
    return { ...this.state };
  }

  get chordName(): string {
    return currentChord(this.state).name;
  }

  get keyName(): string {
    return keyName(this.state.rootPc);
  }

  /**
   * Choose the next chord index. Spec §7.4:
   *  - from the tonic → uniform among the non-tonic chords
   *  - from a non-tonic → 45 % tonic, 55 % uniform among the other non-tonics
   *  - never the same chord twice in a row
   *
   * A **pure selector** — it does not mutate state; `onBar` applies the result.
   * Modelled on a ii–V–I–IV style pop: the occasional tonic return gives the
   * phrase a resting point, but making it automatic yields predictable
   * four-on-the-floor harmony, so it is a minority outcome.
   */
  chooseNextChordIdx(): number {
    const chords = MODES[this.state.mode].chords;
    const n = chords.length;
    const current = this.state.chordIdx;

    if (currentChord(this.state).tonic) {
      const pool: number[] = [];
      for (let i = 0; i < n; i++) if (i !== current && !chords[i]!.tonic) pool.push(i);
      if (pool.length === 0) return current;
      return pool[Math.floor(this.rng() * pool.length) % pool.length]!;
    }

    if (this.rng() < TONIC_RETURN_P) {
      for (let i = 0; i < n; i++) if (chords[i]!.tonic) return i;
    }

    // Uniform among non-tonic chords other than the current one.
    const pool: number[] = [];
    for (let i = 0; i < n; i++) {
      if (i !== current && !chords[i]!.tonic) pool.push(i);
    }
    if (pool.length === 0) {
      for (let i = 0; i < n; i++) if (i !== current) pool.push(i);
    }
    if (pool.length === 0) return current;
    return pool[Math.floor(this.rng() * pool.length) % pool.length]!;
  }

  /**
   * The pitch class the key would walk to. Spec §7.4 weights: +7, +5, +2, −3.
   * A **pure selector** — `onBar` applies the result.
   */
  chooseNextRootPc(): number {
    const offset = weighted(this.rng, KEY_WALK_OFFSETS, KEY_WALK_WEIGHTS) ?? 7;
    return (((this.state.rootPc + offset) % 12) + 12) % 12;
  }

  /**
   * Advance to bar `bar` at audio time `at`, using the current energy `e`.
   * Returns any harmony events produced (chord, mode and/or key).
   *
   * Call once per bar at `stepInBar === 0` (spec §7.7).
   */
  onBar(bar: number, e: number, at: number): HarmonyEvent[] {
    const events: HarmonyEvent[] = [];
    const previousMode = this.state.mode;
    this.state.barCounter = bar;

    // --- Mode change: phrase boundaries only (§7.4) ----------------------
    if (bar % PHRASE_BARS === 0) {
      const m = modeForEnergy(e, this.state.mode);
      if (m !== this.state.mode) {
        this.state.mode = m;
        this.state.chordIdx = 0; // return to the new mode's tonic
        events.push({ kind: "mode", at, state: this.getState(), chordName: this.chordName });
      } else if (previousMode !== m) {
        // unreachable, but keeps the invariant explicit
        events.push({ kind: "mode", at, state: this.getState(), chordName: this.chordName });
      }
    }

    // --- Key change: every 32 bars, never at bar 0 (§7.4) ---------------
    if (bar % KEY_CHANGE_BARS === 0 && bar > 0) {
      this.state.rootPc = this.chooseNextRootPc();
      events.push({ kind: "key", at, state: this.getState(), chordName: this.chordName });
    }

    // --- Chord change: every 4 bars (§7.4) -------------------------------
    if (bar % CHORD_BARS === 0) {
      this.state.chordIdx = this.chooseNextChordIdx();
      events.push({ kind: "chord", at, state: this.getState(), chordName: this.chordName });
    }

    return events;
  }
}
