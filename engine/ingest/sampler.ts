/**
 * Importance-weighted token-bucket sampler. Spec §6.4.
 *
 * Caps the number of *musical/visual* events per second regardless of input
 * rate, while keeping the texture of small edits. The key correctness rule:
 * **statistics always count every accepted event**, never the sampled subset
 * (spec §2.3.4 "honest data"). Sampling only decides what gets *heard*.
 *
 * Injected RNG and clock so tests are deterministic and free of real time.
 */
import { BATCH_INTERVAL_MS, SAMPLER_BUCKET_CAP, SAMPLER_RANDOM_RESERVE } from "../config";
import type { Rng } from "../util/random";
import type { NormalizedEdit } from "../types";

export interface SamplerCounters {
  /** candidates offered to the sampler */
  offered: number;
  /** candidates that survived sampling (become musical/visual events) */
  selected: number;
  /** candidates discarded because the budget was exhausted */
  dropped: number;
}

/**
 * Partial-selection-free reservoir-free approach: each flush picks exactly
 * `budget` items from the window's candidates.
 *
 * Selection order (§6.4):
 *   1. Reserve `max(1, floor(budget × 0.25))` for **uniformly random** picks —
 *      this is what preserves small-edit texture, since small edits have low
 *      importance and would otherwise never be chosen.
 *   2. Fill the rest by descending importance, ties broken randomly.
 */
export class ImportanceSampler {
  private tokens = 0;
  private readonly counters: SamplerCounters = { offered: 0, selected: 0, dropped: 0 };

  constructor(
    private maxPerSec: number,
    private readonly rng: Rng,
    private readonly bucketCapMul = SAMPLER_BUCKET_CAP,
  ) {}

  setMaxPerSec(v: number): void {
    if (Number.isFinite(v) && v > 0) this.maxPerSec = v;
  }

  getStats(): Readonly<SamplerCounters> {
    return this.counters;
  }

  reset(): void {
    this.tokens = 0;
    this.counters.offered = 0;
    this.counters.selected = 0;
    this.counters.dropped = 0;
  }

  /**
   * Refill the bucket for a window of `dtSec`. The cap is half a second of
   * capacity (§6.4), which lets a burst through after an idle period without
   * letting a long stall accumulate an unbounded backlog.
   */
  refill(dtSec: number): void {
    if (!(dtSec > 0)) return;
    const cap = this.maxPerSec * this.bucketCapMul;
    this.tokens = Math.min(cap, this.tokens + this.maxPerSec * dtSec);
  }

  /** Tokens currently available. Exposed for the debug overlay and tests. */
  get available(): number {
    return this.tokens;
  }

  /**
   * Select up to the token budget from `candidates`.
   *
   * The input array is **not** mutated and the selected edits are returned in
   * the caller's original order — playback order should follow arrival order,
   * not importance rank, or the music will sound like a prioritised queue
   * rather than a stream.
   */
  select(candidates: readonly NormalizedEdit[]): NormalizedEdit[] {
    const n = candidates.length;
    this.counters.offered += n;
    if (n === 0) return [];

    const budget = Math.floor(this.tokens);
    if (budget <= 0) {
      this.counters.dropped += n;
      return [];
    }
    if (n <= budget) {
      // Everything fits; no sampling pressure this window.
      this.tokens -= n;
      this.counters.selected += n;
      return candidates.slice();
    }

    const chosen = new Uint8Array(n); // 0/1 mask, avoids a Set + allocation churn
    let need = budget;

    // --- 1. Uniform-random reserve (keeps small-edit texture) -------------
    const reserve = budget > 0 ? Math.max(1, Math.floor(budget * SAMPLER_RANDOM_RESERVE)) : 0;
    for (let k = 0; k < reserve && need > 0; k++) {
      const idx = Math.floor(this.rng() * n) % n;
      if (chosen[idx] === 0) {
        chosen[idx] = 1;
        need--;
      } else {
        // Already picked — keep drawing rather than wasting the reserve.
        for (let probe = 0; probe < n && need > 0; probe++) {
          const j = (idx + probe + 1) % n;
          if (chosen[j] === 0) {
            chosen[j] = 1;
            need--;
            break;
          }
        }
      }
    }

    // --- 2. Descending importance, ties broken randomly -------------------
    // Index-sorted so equal importance resolves in a random but stable order.
    const order = new Int32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    const r = this.rng;
    const imp = candidates;
    // Insertion order matters only for stability; a full sort is O(n log n) on
    // at most a few hundred entries per 50 ms window, which is negligible.
    const arr = Array.from(order);
    arr.sort((a, b) => {
      const d = (imp[b]?.importance ?? 0) - (imp[a]?.importance ?? 0);
      if (d !== 0) return d;
      return r() < 0.5 ? -1 : 1; // random tie-break
    });

    for (let i = 0; i < arr.length && need > 0; i++) {
      const idx = arr[i]!;
      if (chosen[idx] === 0) {
        chosen[idx] = 1;
        need--;
      }
    }

    // --- 3. Emit in arrival order ----------------------------------------
    const out: NormalizedEdit[] = [];
    for (let i = 0; i < n; i++) {
      if (chosen[i] === 1) out.push(candidates[i]!);
    }

    this.tokens -= out.length;
    this.counters.selected += out.length;
    this.counters.dropped += n - out.length;
    return out;
  }
}

export const DEFAULT_BATCH_INTERVAL_MS = BATCH_INTERVAL_MS;
