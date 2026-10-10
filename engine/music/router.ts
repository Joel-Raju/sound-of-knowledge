/**
 * Edit → voice routing. Spec §7.5.
 *
 * The priority order is the whole point: it decides that a *new page* sings
 * even if it is tiny, and a *revert* rings even if a large edit is also
 * arriving. Reverts are rare (≈1 %) and are the single most legible signal in
 * the data, so they get first claim on the ear.
 */
import { SUB_DOUBLE_PROB, SUB_MAGNITUDE_THRESHOLD, VEL_MAX, VEL_MIN } from "../config";
import { clamp } from "../util/math";
import type { NormalizedEdit } from "../types";

export type RoutedKind = "birth" | "gong" | "bot" | "sub" | "pluck" | "bell";

/**
 * Spec §7.5 priority order:
 *  1. `kind === 'new'`   → birth  (4-note arpeggio)
 *  2. `kind === 'revert'` → gong
 *  3. `actor === 'bot'`   → bot    (fuel for the percussion gate, §7.8)
 *  4. `magnitude >= 0.60` → sub    (deep swell)
 *  5. `delta > 0`         → pluck  (additions: warm)
 *  6. otherwise           → bell   (removals: cool glass)
 */
export function route(edit: NormalizedEdit): RoutedKind {
  if (edit.kind === "new") return "birth";
  if (edit.kind === "revert") return "gong";
  if (edit.actor === "bot") return "bot";
  if (edit.magnitude >= SUB_MAGNITUDE_THRESHOLD) return "sub";
  if (edit.delta > 0) return "pluck";
  return "bell";
}

/**
 * Spec §7.5 velocity:
 *   `clamp(0.30 + 0.50·magnitude + (minor ? −0.10 : 0) + (anon ? 0.05 : 0), 0.15, 0.90)`
 */
export function velocityOf(edit: NormalizedEdit): number {
  let v = 0.3 + 0.5 * edit.magnitude;
  if (edit.minor) v -= 0.1;
  if (edit.actor === "anon") v += 0.05;
  return clamp(v, VEL_MIN, VEL_MAX);
}

/**
 * Spec §7.5 step 4: a large edit plays the sub, *and* has a 35 % chance of also
 * playing its normal mapping, so a big rewrite is sometimes a swell and
 * sometimes a swell with a bell on top.
 *
 * Injected RNG keeps this deterministic under test.
 */
export function shouldDoubleAsMelodic(edit: NormalizedEdit, rng: () => number): boolean {
  if (edit.kind === "new" || edit.kind === "revert") return false;
  if (edit.actor === "bot") return false;
  if (edit.magnitude < SUB_MAGNITUDE_THRESHOLD) return false;
  return rng() < SUB_DOUBLE_PROB;
}
