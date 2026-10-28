/**
 * Voice slot allocator. Spec §8.5.
 *
 * **Pure and allocation-free** — no audio nodes, no clock, no Web Audio. It
 * answers one question: given a note about to be scheduled, which of the N
 * voice slots can take it?
 *
 * The reason it can be pure is that voice durations are *deterministic
 * functions of the note* (see `voice-params.ts`), so the main thread knows a
 * slot's end time the moment it schedules into it. If durations depended on
 * anything the worklet decided, the main thread would have no idea whether a
 * slot was free and would have to allocate defensively.
 */
import {
  GONG_MAX_CONCURRENT,
  KIND_CONCURRENT_CAP,
  KIND_PRIORITY_BONUS,
  SUB_MAX_CONCURRENT,
  VOICE_KINDS,
} from "../config";
import type { VoiceKind } from "./voice-params";

export interface Slot {
  /** audio-clock time this slot's note finishes */
  endTime: number;
  kind: VoiceKind;
  priority: number;
}

/**
 * Spec §8.5 — `priority = importance + { gong: +0.6, sub: +0.4, bell/pluck: +0.1,
 * thud/tick: +0 }`.
 *
 * The bonus exists so a rare, dramatic event is never evicted by a stream of
 * ordinary ones: a revert outranks a burst of small additions even if those
 * arrived with marginally higher importance.
 */
export function priorityOf(kind: VoiceKind, importance: number): number {
  return importance + (KIND_PRIORITY_BONUS[VOICE_KINDS[kind] ?? "bell"] ?? 0);
}

/** Spec §8.5 caps: gong ≤ 2 concurrent, sub ≤ 3. Others uncapped. */
export function capOf(kind: VoiceKind): number {
  const name = VOICE_KINDS[kind] ?? "bell";
  return KIND_CONCURRENT_CAP[name as keyof typeof KIND_CONCURRENT_CAP] ?? Number.POSITIVE_INFINITY;
}

export { GONG_MAX_CONCURRENT, SUB_MAX_CONCURRENT };

export class VoiceAllocator {
  readonly size: number;
  private readonly slots: Slot[];

  constructor(size: number) {
    if (size <= 0) throw new RangeError("VoiceAllocator size must be > 0");
    this.size = size;
    this.slots = [];
    for (let i = 0; i < size; i++) {
      // `endTime = -Infinity` so every slot is free before the first note.
      this.slots.push({
        endTime: Number.NEGATIVE_INFINITY,
        kind: 0,
        priority: Number.NEGATIVE_INFINITY,
      });
    }
  }

  getSlot(i: number): Slot | undefined {
    return this.slots[i];
  }

  /**
   * Reserve a slot. Returns the index, or **-1** if none can be taken.
   *
   * Order (spec §8.5):
   *   1. kind caps — gong ≤ 2 and sub ≤ 3 *in flight* at this time;
   *   2. first slot already free (`endTime <= when`);
   *   3. otherwise steal the lowest-priority slot, but only if strictly lower
   *      priority than the incoming note.
   */
  allocate(kind: VoiceKind, when: number, dur: number, importance: number): number {
    const n = this.size;
    const priority = priorityOf(kind, importance);

    // --- 1. caps -----------------------------------------------------------
    const cap = capOf(kind);
    if (Number.isFinite(cap)) {
      let inflight = 0;
      for (let i = 0; i < n; i++) {
        const s = this.slots[i]!;
        if (s.kind === kind && s.endTime > when) inflight++;
      }
      if (inflight >= cap) return -1;
    }

    // --- 2. a free slot ---------------------------------------------------
    for (let i = 0; i < n; i++) {
      if (this.slots[i]!.endTime <= when) {
        this.slots[i]!.endTime = when + dur;
        this.slots[i]!.kind = kind;
        this.slots[i]!.priority = priority;
        this.stolenLast = false;
        return i;
      }
    }

    // --- 3. steal the weakest, if we outrank it ---------------------------
    let worst = 0;
    for (let i = 1; i < n; i++) {
      if (this.slots[i]!.priority < this.slots[worst]!.priority) worst = i;
    }
    if (this.slots[worst]!.priority < priority) {
      this.slots[worst]!.endTime = when + dur;
      this.slots[worst]!.kind = kind;
      this.slots[worst]!.priority = priority;
      this.stolenLast = true;
      return worst;
    }
    return -1;
  }

  /** True when the last `allocate` took a slot that was still sounding, so the
   * caller must send a `kill` (30 ms fade) before the `on`. Spec §8.5. */
  private stolenLast = false;

  get lastWasStolen(): boolean {
    return this.stolenLast;
  }

  /** Slots still sounding at `t`. For the debug overlay and metrics. */
  activeAt(t: number): number {
    let n = 0;
    for (let i = 0; i < this.size; i++) if (this.slots[i]!.endTime > t) n++;
    return n;
  }

  /** Free the whole pool — used on dispose and in tests. */
  reset(): void {
    for (let i = 0; i < this.size; i++) {
      this.slots[i]!.endTime = Number.NEGATIVE_INFINITY;
      this.slots[i]!.priority = Number.NEGATIVE_INFINITY;
      this.slots[i]!.kind = 0;
    }
  }
}
