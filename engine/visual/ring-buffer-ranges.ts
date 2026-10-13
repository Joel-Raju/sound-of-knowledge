/**
 * Instanced ring-buffer writing, as a pure function.
 *
 * Spec §9.5 requires spawns to wrap "with up to two contiguous ranges", because
 * writing 48 particles starting near the end of a 6 144-slot buffer crosses the
 * boundary and is two disjoint spans, not one. `THREE.InstancedBufferAttribute`
 * uploads exactly the ranges handed to `addUpdateRange`, so getting this wrong
 * is silent in one direction and catastrophic in the other: a naive
 * `addUpdateRange(head, count)` past the end uploads nothing for the wrapped
 * part, and those particles never appear.
 *
 * Pure, so the wraparound arithmetic is testable without a GL context — which is
 * what T4.3 asks for.
 */

/** One contiguous span of instances to upload. */
export interface UpdateRange {
  start: number;
  count: number;
}

/**
 * Spans covering `count` items written at `head` in a ring of `cap`.
 *
 * Returns `[]` for a zero count — an empty spawn must not mark the attributes
 * dirty, because `needsUpdate = true` re-uploads the buffer and §9.5 is explicit
 * that it happens "only on frames that spawned".
 *
 * When `count >= cap` the spawn laps the ring, and only the **final** lap
 * survives — the earlier writes are overwritten by the spawn itself. The spans
 * returned therefore describe the last `cap` items, starting at
 * `(head + count − cap) % cap`. Returning the whole `count` here would report
 * slots written twice, and those overlapping spans get merged by three.js into
 * one upload that costs more than the ring is worth.
 *
 * @throws on a negative count, a non-positive capacity, or a `head` outside
 *         `[0, cap)`. These are programmer errors, not runtime conditions, and
 *         clamping them would hide a corrupt cursor instead of surfacing it.
 */
export function spawnRanges(head: number, count: number, cap: number): UpdateRange[] {
  if (!Number.isInteger(cap) || cap <= 0) {
    throw new RangeError(`cap must be a positive integer, got ${cap}`);
  }
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`count must be a non-negative integer, got ${count}`);
  }
  if (!Number.isInteger(head) || head < 0 || head >= cap) {
    throw new RangeError(`head must be in [0, ${cap}), got ${head}`);
  }
  if (count === 0) return [];

  // Surviving items, and where the first of them lands.
  const effective = Math.min(count, cap);
  const start = (head + count - effective) % cap;

  const untilEnd = cap - start;
  if (effective <= untilEnd) return [{ start, count: effective }];
  return [
    { start, count: untilEnd },
    { start: 0, count: effective - untilEnd },
  ];
}

/**
 * The cursor after writing `count` items at `head`.
 *
 * Separate from `spawnRanges` because the cursor advances even when the ranges
 * are empty, and because it is the one piece of the ring's state a caller must
 * never re-derive — re-deriving it from the ranges gives the wrong answer the
 * moment a spawn wraps.
 */
export function nextHead(head: number, count: number, cap: number): number {
  if (!Number.isInteger(cap) || cap <= 0) {
    throw new RangeError(`cap must be a positive integer, got ${cap}`);
  }
  if (!Number.isInteger(head) || head < 0 || head >= cap) {
    throw new RangeError(`head must be in [0, ${cap}), got ${head}`);
  }
  return (head + Math.max(0, count)) % cap;
}

/** Total instances covered by a set of ranges — must equal the spawn count. */
export function rangeTotal(ranges: readonly UpdateRange[]): number {
  let n = 0;
  for (const r of ranges) n += r.count;
  return n;
}