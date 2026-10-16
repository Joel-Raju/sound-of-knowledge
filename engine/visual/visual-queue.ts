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
import { LOOKAHEAD_HIDDEN_SEC } from "../config";

/**
 * Default capacity. A note's visual event lives ~3.2 s (a label) and `≤ 1 per 1.2 s`
 * of labels are spawned, so a queue this size covers the worst case that can still be
 * displayed at all; anything beyond it is already invisible.
 */
export const DEFAULT_CAPACITY = 64;

/**
 * How late a note may be before it is dropped rather than fired.
 *
 * Derived rather than picked: `LOOKAHEAD_HIDDEN_SEC` is the furthest ahead the
 * scheduler will ever place a note, so a note more than that far *past* its `when`
 * cannot be "about to be heard" — it missed its window. The extra 0.25 s covers
 * frame slack, so a dropped frame does not cost a visual.
 */
export const STALE_AFTER_SEC = LOOKAHEAD_HIDDEN_SEC + 0.25;

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