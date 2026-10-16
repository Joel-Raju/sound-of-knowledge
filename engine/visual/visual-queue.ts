/**
 * §9.9's visual queue — time-ordered notes waiting to become visuals.
 *
 * **Why a queue at all.** A note is *scheduled* ahead of when it is *heard*. The
 * scheduler runs on a 25 ms tick and looks `LOOKAHEAD_SEC` (0.15 s) into the future —
 * or `LOOKAHEAD_HIDDEN_SEC` (1.25 s) when the tab is hidden. If a visual fired the
 * instant a note was emitted it would lead the audio by up to 1.25 s, and the whole
 * point of the piece is that what you see is what you hear. So notes wait here and
 * are released at *heard-time*: `now >= note.when`.
 *
 * Kept free of DOM, three.js and the clock so §13.2's four properties — ordering,
 * stale drop, capacity overflow, heard-time gating — are testable directly.
 */
import type { NoteEvent } from "../types";

/**
 * §10.1 — "Queue: fixed-capacity (256) array kept sorted by `when`".
 *
 * This was 64 until T5.3. The derivation behind it — that a label lives 3.2 s and `≤ 1`
 * per 1.2 s, so more than ~3 is invisible — was true and was the wrong question: the
 * cap is not there to hide notes, it is there to bound the array, and §10.1 names the
 * number. At 4.81 notes/s a second of headroom is under five entries; 64 is 13 seconds
 * of notes, which is a lot of memory to hold for events that can no longer be shown.
 */
export const DEFAULT_CAPACITY = 256;

/**
 * §10.1 — `dropStale(heard - 2.0)`: "events older than 2 s (e.g. after a hidden tab) are
 * discarded unfired".
 *
 * This was `LOOKAHEAD_HIDDEN_SEC + 0.25` = 1.5 s, derived rather than read. The derivation
 * was sound — the scheduler never places a note further ahead than 1.25 s — but §10.1
 * states 2.0 outright and gives the reason. Two seconds also leaves room for a long
 * frame, so a single 300 ms hitch costs one visual rather than four.
 */
export const STALE_AFTER_SEC = 2.0;

export interface VisualQueueOptions {
  capacity?: number;
  staleAfterSec?: number;
}

/** Why a note left the queue without becoming a visual. */
export type DropReason = "stale" | "overflow";

export class VisualQueue {
  readonly capacity: number;
  private readonly staleAfterSec: number;
  /** Sorted ascending by `when`; ties keep insertion order. */
  private notes: NoteEvent[] = [];

  /**
   * The last time the queue was told what "now" was.
   *
   * `push` needs a clock to judge staleness but is not handed one, so it reads the
   * most recent `drain`. A note can therefore be up to one frame late in being called
   * stale on arrival — immaterial at 1.5 s against a 16 ms frame, and it keeps the
   * queue free of an injected clock it otherwise never needs.
   */
  private nowHint = 0;

  /** Counts, surfaced as metrics (§5.5 `visualQueueLen` is `length`). */
  droppedStale = 0;
  droppedOverflow = 0;
  fired = 0;

  constructor(opts: VisualQueueOptions = {}) {
    this.capacity = Math.max(1, opts.capacity ?? DEFAULT_CAPACITY);
    this.staleAfterSec = opts.staleAfterSec ?? STALE_AFTER_SEC;
  }

  get length(): number {
    return this.notes.length;
  }

  /** The last note's heard-time, or 0 when empty. */
  get nextAt(): number {
    return this.notes.length > 0 ? this.notes[0]!.when : 0;
  }

  /** Non-visual notes are the trailing arpeggio of a birth; §9.9 fires nothing for them. */
  push(note: NoteEvent): boolean {
    if (!note.visual) return false;

    // Stale on arrival — a note handed over long after its time has passed can never
    // be shown as having just happened.
    if (note.when < this.nowHint - this.staleAfterSec) {
      this.droppedStale++;
      return false;
    }

    // Capacity overflow drops the **oldest**, i.e. the soonest to be heard. Dropping
    // the newest instead would silently discard recent history to make room for
    // history further in the future, and the oldest is also the one closest to going
    // stale if it waits.
    if (this.notes.length >= this.capacity) {
      this.notes.shift();
      this.droppedOverflow++;
    }

    // Insert by `when`, stable for ties — a tie means two notes at the same heard-time
    // and their order is the order they were scheduled, which is what was intended.
    let i = this.notes.length;
    while (i > 0 && this.notes[i - 1]!.when > note.when) i--;
    this.notes.splice(i, 0, note);
    return true;
  }

  /**
   * Release every note whose heard-time has arrived.
   *
   * Notes older than the stale window are dropped rather than fired: a batch of them
   * firing at once after a stall is a wall of stale visuals that never matched audio.
   */
  drain(now: number): NoteEvent[] {
    this.nowHint = now;
    const out: NoteEvent[] = [];
    while (this.notes.length > 0 && this.notes[0]!.when <= now) {
      const note = this.notes.shift()!;
      if (now - note.when > this.staleAfterSec) {
        this.droppedStale++;
        continue;
      }
      out.push(note);
    }
    this.fired += out.length;
    return out;
  }

  /**
   * Drop everything. §13.2 — a hidden tab keeps *scheduling*, so on return the queue
   * is full of notes whose heard-time has passed; they must not all fire at once.
   */
  clear(): void {
    this.notes.length = 0;
  }
}