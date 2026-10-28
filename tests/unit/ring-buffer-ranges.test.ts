/**
 * Ring-buffer wraparound maths. T4.3's stated test target.
 *
 * Pure, so it needs no GL context — which is the point of pulling it out of
 * `Sparks`. The failure it guards against is silent: `addUpdateRange(start, count)`
 * past the end of the attribute uploads nothing for the wrapped span, so those
 * particles exist in the array and never appear on screen.
 */
import { describe, expect, it } from "vitest";
import { nextHead, rangeTotal, spawnRanges } from "@/engine/visual/ring-buffer-ranges";

/** Slots a spawn of `count` actually leaves written. */
const covered = (count: number, cap: number) => Math.min(count, cap);

describe("spawnRanges", () => {
  it("returns one range when the spawn fits before the end", () => {
    expect(spawnRanges(0, 10, 100)).toEqual([{ start: 0, count: 10 }]);
    expect(spawnRanges(50, 10, 100)).toEqual([{ start: 50, count: 10 }]);
  });

  it("returns one range that lands exactly on the end", () => {
    // The boundary case that is easy to get wrong in either direction.
    expect(spawnRanges(90, 10, 100)).toEqual([{ start: 90, count: 10 }]);
  });

  it("splits into two ranges when the spawn wraps", () => {
    expect(spawnRanges(90, 20, 100)).toEqual([
      { start: 90, count: 10 },
      { start: 0, count: 10 },
    ]);
  });

  it("covers exactly the surviving slots, never dropping any", () => {
    // The property that matters, as opposed to a few hand-picked shapes. Kept to
    // small caps: this walks every slot of every range, so a 6 144-cap here would
    // be hundreds of millions of iterations.
    for (const cap of [6, 24]) {
      for (let head = 0; head < cap; head++) {
        for (const count of [1, 2, 5, 7, 13, cap - 1, cap, cap + 1, cap * 2 + 3]) {
          const r = spawnRanges(head, count, cap);
          expect(rangeTotal(r)).toBe(covered(count, cap));
          // And no slot appears in two spans — an overlap would upload twice.
          const seen = new Set<number>();
          for (const span of r) {
            for (let i = span.start; i < span.start + span.count; i++) {
              expect(seen.has(i)).toBe(false);
              seen.add(i);
            }
          }
        }
      }
    }
  });

  it("holds the same total at the real §9.5 capacities", () => {
    // The tier capacities, where only the total is checked — `rangeTotal` is
    // O(spans), not O(slots), so this stays cheap.
    for (const cap of [6144, 12288, 24576]) {
      for (const count of [1, 36, 48, cap, cap + 1]) {
        expect(rangeTotal(spawnRanges(0, count, cap))).toBe(covered(count, cap));
        expect(rangeTotal(spawnRanges(cap - 10, count, cap))).toBe(covered(count, cap));
      }
    }
  });

  it("never emits a range that runs past the end of the buffer", () => {
    for (const cap of [6, 24]) {
      for (let head = 0; head < cap; head++) {
        for (const count of [1, 5, 6, 7, 13]) {
          for (const r of spawnRanges(head, count, cap)) {
            expect(r.start).toBeGreaterThanOrEqual(0);
            expect(r.start).toBeLessThan(cap);
            expect(r.start + r.count).toBeLessThanOrEqual(cap);
          }
        }
      }
    }
  });

  it("emits no empty range", () => {
    // A zero-count range would mark the attribute dirty and upload nothing.
    for (const cap of [6, 24]) {
      for (let head = 0; head < cap; head++) {
        for (const r of spawnRanges(head, 0, cap)) expect(r.count).toBeGreaterThan(0);
      }
    }
  });

  it("returns nothing for a zero count, so no upload is flagged", () => {
    // §9.5: `needsUpdate` happens "only on frames that spawned".
    expect(spawnRanges(3, 0, 100)).toEqual([]);
  });

  it("keeps only the final lap when the spawn laps the ring", () => {
    // 25 items into a 10-slot ring: the last 10 win, and they start where item
    // 15 landed, i.e. slot 9.
    const r = spawnRanges(4, 25, 10);
    expect(rangeTotal(r)).toBe(10);
    expect(r).toEqual([
      { start: 9, count: 1 },
      { start: 0, count: 9 },
    ]);
  });

  it("writes the whole ring when the spawn is exactly one lap", () => {
    const r = spawnRanges(4, 10, 10);
    expect(rangeTotal(r)).toBe(10);
    expect(r).toEqual([
      { start: 4, count: 6 },
      { start: 0, count: 4 },
    ]);
  });

  it("rejects a head outside the buffer rather than clamping it", () => {
    // Clamping would hide a corrupt cursor and desync the ring from the arrays.
    expect(() => spawnRanges(100, 1, 100)).toThrow(RangeError);
    expect(() => spawnRanges(-1, 1, 100)).toThrow(RangeError);
    expect(() => spawnRanges(1.5, 1, 100)).toThrow(RangeError);
  });

  it("rejects a non-positive capacity", () => {
    expect(() => spawnRanges(0, 1, 0)).toThrow(RangeError);
    expect(() => spawnRanges(0, 1, -5)).toThrow(RangeError);
  });

  it("rejects a negative count", () => {
    expect(() => spawnRanges(0, -1, 100)).toThrow(RangeError);
  });
});

describe("nextHead", () => {
  it("advances without wrapping", () => {
    expect(nextHead(0, 10, 100)).toBe(10);
    expect(nextHead(90, 10, 100)).toBe(0); // exactly to the end
  });

  it("wraps past the end", () => {
    expect(nextHead(90, 20, 100)).toBe(10);
  });

  it("stays put for a zero count", () => {
    expect(nextHead(7, 0, 100)).toBe(7);
  });

  it("wraps a multi-lap spawn by exactly the remainder", () => {
    expect(nextHead(4, 25, 10)).toBe(9);
    expect(nextHead(4, 30, 10)).toBe(4);
  });

  it("agrees with spawnRanges: the cursor is where the next spawn begins", () => {
    // They are separate functions because the cursor advances even when the
    // ranges are empty; the invariant is that a non-empty spawn's surviving slots
    // all lie before the cursor.
    for (const cap of [6, 24]) {
      for (let head = 0; head < cap; head++) {
        for (const count of [1, 5, 13]) {
          const r = spawnRanges(head, count, cap);
          const cursor = nextHead(head, count, cap);
          expect(rangeTotal(r)).toBe(covered(count, cap));
          for (const span of r) {
            for (let i = span.start; i < span.start + span.count; i++) {
              // Contiguity: nothing may skip a slot between head and cursor.
              expect((i - head + cap) % cap).toBeLessThan(count);
            }
          }
          expect(cursor).toBeGreaterThanOrEqual(0);
          expect(cursor).toBeLessThan(cap);
        }
      }
    }
  });

  it("rejects an out-of-range head and a non-positive capacity", () => {
    expect(() => nextHead(10, 1, 10)).toThrow(RangeError);
    expect(() => nextHead(-1, 1, 10)).toThrow(RangeError);
    expect(() => nextHead(0, 1, 0)).toThrow(RangeError);
  });
});