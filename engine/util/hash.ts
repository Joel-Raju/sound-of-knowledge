/**
 * FNV-1a, 32-bit. Spec §7.9 (spatial mapper), §13.2 test vectors.
 *
 * Chosen over a JS string hash because it is specified, trivially portable,
 * and produces identical results in the worker, the main thread and tests —
 * which matters because §7.9 requires audio and visuals to agree on where an
 * edit came from.
 */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193; // 16777619

/** Spec §13.2: `fnv1a("") = 0x811c9dc5`. */
export function fnv1a(str: string): number {
  let h = FNV_OFFSET_BASIS;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME); // keeps the multiply in int32 range
  }
  return h >>> 0;
}

/** Spec §13.2: `fnv1a("a") = 0xe40c292c`. */
export function fnv1aInt(str: string): number {
  return fnv1a(str) | 0;
}

/**
 * Hash to the unit interval [0, 1).
 * Uses the top 24 bits so the result is well distributed even when the
 * caller only needs a single float.
 */
export function hash01(str: string): number {
  return (fnv1a(str) >>> 8) / 0x01000000;
}

/**
 * Hash to [0, n). Spec §7.9: `homeIndex = fnv1a(edit.wiki) % 64`.
 * Guarded against n <= 0 so a misconfigured constant returns 0 rather than NaN.
 */
export function hashIndex(str: string, n: number): number {
  if (n <= 0) return 0;
  return fnv1a(str) % n;
}

/**
 * Derive `count` independent uniform values in [0, 1) from one string.
 * Spec §7.9: "derive three uniform numbers" from `fnv1a(title + ':' + id)`.
 * Uses counter-mode hashing so the outputs do not overlap.
 */
export function hashUniforms(str: string, out: Float64Array, count: number): void {
  const n = count < out.length ? count : out.length;
  for (let i = 0; i < n; i++) {
    // Mix in a counter via a second round of FNV.
    let h = FNV_OFFSET_BASIS ^ (i + 1);
    for (let j = 0; j < str.length; j++) {
      h ^= str.charCodeAt(j);
      h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
    }
    h ^= h >>> 16;
    h = Math.imul(h, 0x7feb352d);
    h ^= h >>> 15;
    h = Math.imul(h, 0x846ca68b);
    h ^= h >>> 16;
    out[i] = (h >>> 8) / 0x01000000;
  }
}

/**
 * Approximately gaussian value with ~unit variance, via the sum of three
 * uniforms. Spec §7.9: "gaussian-ish via sum of 3 uniforms".
 * Range is [-1.5, +1.5]; divide by 1.5 for a rough unit-variance estimate.
 */
export function hashGaussianish(u0: number, u1: number, u2: number): number {
  return (u0 + u1 + u2 - 1.5) / 1.5;
}
