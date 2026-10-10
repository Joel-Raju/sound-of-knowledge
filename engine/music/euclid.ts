/**
 * Bjorklund / Euclidean rhythm generation. Spec §7.8.
 *
 * Used for the bot-driven percussion gate. Bjorklund's algorithm distributes
 * `k` onsets as evenly as possible over `n` steps — which is why the bot pulse
 * sounds like a groove rather than a metronome, and why it stays musical at any
 * bot rate instead of just getting faster.
 */

/**
 * Bjorklund's algorithm, in Toussaint's a/b-list formulation.
 *
 * `a` starts as the k onsets, `b` as the n−k rests. Each round merges `a[i]`
 * with `b[i]` and moves anything left over from the longer list into `b`. The
 * result is `a ++ b`.
 *
 * The formulation matters. Collapsing both lists into one and pairing
 * front-to-back — the obvious thing to write — produces *unevenly* patterns:
 * it yields gaps of {4,2,2,2,2,2,2} for `euclid(7,16)` instead of
 * {3,2,2,2,3,2,2}, which breaks the "gaps differ by ≤ 1" requirement in spec
 * §13.2 and would make the bot groove lurch instead of rolling.
 *
 * Verified against every reference in spec §13.2:
 *   euclid(3, 8)  = x..x..x.
 *   euclid(5, 8)  = x.xx.xx.
 *   euclid(4, 16) = x...x...x...x...
 *   euclid(7, 16) = 7 hits, gaps {3,2,2,2,3,2,2} — spread 1
 */
export function euclid(k: number, n: number): boolean[] {
  if (n <= 0) return [];
  const hits = k < 0 ? 0 : k > n ? n : k;
  const out: boolean[] = new Array<boolean>(n).fill(false);
  if (hits === 0) return out;

  let a: boolean[][] = [];
  let b: boolean[][] = [];
  for (let i = 0; i < hits; i++) a.push([true]);
  for (let i = 0; i < n - hits; i++) b.push([false]);

  while (b.length > 1) {
    const m = a.length < b.length ? a.length : b.length;
    const nextA: boolean[][] = [];
    for (let i = 0; i < m; i++) nextA.push(a[i]!.concat(b[i]!));

    // Whatever is left in `b` past the merged prefix…
    const nextB: boolean[][] = [];
    for (let i = m; i < b.length; i++) nextB.push(b[i]!);
    // …plus any tail of `a` when `a` was the longer list.
    for (let i = m; i < a.length; i++) nextB.push(a[i]!);

    a = nextA;
    b = nextB;
  }

  const flat: boolean[] = [];
  for (const g of a) for (const v of g) flat.push(v);
  for (const g of b) for (const v of g) flat.push(v);

  let count = 0;
  const limit = flat.length < out.length ? flat.length : out.length;
  for (let i = 0; i < limit; i++) {
    if (flat[i] && count < hits) {
      out[i] = true;
      count++;
    }
  }
  // Backfill if the construction came up short.
  for (let i = 0; i < out.length && count < hits; i++) {
    if (!out[i]) {
      out[i] = true;
      count++;
    }
  }
  return out;
}

/**
 * Rotate a pattern left by `shift` steps. Spec §7.8 uses this to move the
 * groove around so the same bot rate does not sound identical every phrase.
 */
export function rotate(pattern: readonly boolean[], shift: number): boolean[] {
  const n = pattern.length;
  if (n === 0) return [];
  const k = ((shift % n) + n) % n;
  const out: boolean[] = new Array<boolean>(n);
  for (let i = 0; i < n; i++) out[i] = pattern[(i + k) % n]!;
  return out;
}

/** Count of onsets — used by tests and the debug overlay. */
export function countHits(pattern: readonly boolean[]): number {
  let n = 0;
  for (let i = 0; i < pattern.length; i++) if (pattern[i]) n++;
  return n;
}

/**
 * Smallest and largest gap between consecutive onsets, in step units.
 * Spec §13.2 asserts that for `euclid(7,16)` the gaps differ by ≤ 1, which is
 * the defining property of a Euclidean rhythm.
 */
export function gapSpread(pattern: readonly boolean[]): { min: number; max: number } {
  const n = pattern.length;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) if (pattern[i]) idx.push(i);
  if (idx.length <= 1) return { min: n, max: n };
  let min = Infinity;
  let max = 0;
  for (let i = 0; i < idx.length; i++) {
    const a = idx[i]!;
    const b = idx[(i + 1) % idx.length]!;
    const d = i === idx.length - 1 ? b + n - a : b - a;
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return { min, max };
}
