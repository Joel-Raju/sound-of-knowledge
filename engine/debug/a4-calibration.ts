/**
 * A4 calibration — a deterministic plan of edits, one per named direction.
 *
 * **What A4 asks.** "Each sound comes from the direction its comet came from."
 *
 * **Why the obvious test cannot answer it.** Three separate obstacles, each verified
 * rather than assumed:
 *
 * 1. **Correlation.** ~10 notes arrive per 2.5 s at `density=sparse`. There is no quiet
 *    data mode — `DataMode.mode` is `live | replay | synthetic` and none of them stops
 *    traffic — so a human watching one comet cannot tell which sound is its comet's.
 * 2. **The frame rotates.** `CAMERA_YAW_RATE` is 0.03 rad/s = 1.72°/s, unconditionally,
 *    and `reduceMotion` does not gate it. "Left of screen" is therefore not a fixed
 *    reference. (Over a single 3 s flight that is only 5.2°, so it is not the *main*
 *    obstacle — the correlation is. But it rules out any durable mental map.)
 * 3. **Nothing in the product labels a direction.** A comet that arrives on the left is
 *    indistinguishable from one that arrives in front.
 *
 * **What this does instead.** Picks, from the real `SpatialMapper`, edits that genuinely
 * land in each named camera-relative direction, and names each edit's *title* after the
 * direction it is supposed to come from. So the screen shows `RIGHT`, and the only
 * question left is whether the sound arrives on your right.
 *
 * Nothing here fabricates a position: the plan is produced by calling the same
 * `placeEdit` the scheduler calls, so if this says an edit comes from the right, the
 * scheduler's own lookup agrees — and if it disagreed, the test would be lying.
 */
import { SpatialMapper } from "../music/spatial-mapper";
import type { Vec3 } from "../types";
import { hashIndex } from "../util/hash";

export type A4Direction = "FRONT" | "RIGHT" | "LEFT" | "BEHIND" | "ABOVE" | "BELOW";

export const A4_DIRECTIONS: readonly A4Direction[] = [
  "FRONT",
  "RIGHT",
  "LEFT",
  "BEHIND",
  "ABOVE",
  "BELOW",
];

export interface A4Step {
  /** The direction this edit's sound is supposed to arrive from. */
  label: A4Direction;
  wiki: string;
  title: string;
  id: number;
  /** The world direction `placeEdit` actually returns for this triple. */
  dir: Vec3;
  radius: number;
  /** 1 = perfectly aligned with the target direction. */
  alignment: number;
  /** Angle in degrees between `dir` and the ideal target. */
  errorDeg: number;
}

/** Camera-relative basis, derived from the frozen rig's own pose. */
export interface A4Basis {
  forward: Vec3;
  right: Vec3;
  up: Vec3;
}

const norm = (v: Vec3): Vec3 => {
  const m = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / m, y: v.y / m, z: v.z / m };
};
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

/**
 * Build the target direction for a named slot.
 *
 * `up` is the rig's world-up, not the camera's, for `ABOVE`/`BELOW`. Using camera-up
 * would place them at the top and bottom of the *frame*, which for a pitched camera is
 * not where the sound comes from — the listener's own up is what HRTF uses.
 */
export function a4Basis(forward: Vec3, worldUp: Vec3 = { x: 0, y: 1, z: 0 }): A4Basis {
  const f = norm(forward);
  // Guard the degenerate case: a forward parallel to world-up has no stable right vector.
  const right = Math.abs(dot(f, worldUp)) > 0.999 ? norm(cross(f, { x: 1, y: 0, z: 0 })) : norm(cross(f, worldUp));
  return { forward: f, right, up: norm(worldUp) };
}

export function a4Target(basis: A4Basis, label: A4Direction): Vec3 {
  switch (label) {
    case "FRONT":
      return basis.forward;
    case "RIGHT":
      return basis.right;
    case "LEFT":
      return { x: -basis.right.x, y: -basis.right.y, z: -basis.right.z };
    case "BEHIND":
      return { x: -basis.forward.x, y: -basis.forward.y, z: -basis.forward.z };
    case "ABOVE":
      return basis.up;
    case "BELOW":
      return { x: -basis.up.x, y: -basis.up.y, z: -basis.up.z };
  }
}

/**
 * Candidate wiki strings. `homeOf` hashes the wiki to one of 64 Fibonacci-sphere
 * directions, so the search has to vary the *wiki* — varying only the id explores a
 * ±0.3 rad cone around one home and can never cover the sphere.
 */
const CANDIDATE_WIKIS: string[] = Array.from({ length: 220 }, (_, i) => `calwiki${i}`);
const CANDIDATE_IDS: number[] = [7, 101, 2003, 40009];

/**
 * Find, for each named direction, an edit that genuinely lands there.
 *
 * Deterministic: same `basis` in, same plan out. That is what lets a unit test assert the
 * geometry without a browser or an audio device.
 */
export function planA4(basis: A4Basis, mapper: SpatialMapper = new SpatialMapper()): A4Step[] {
  const dir: Vec3 = { x: 0, y: 0, z: 0 };
  // dir → { alignment, wiki, id } for every candidate, per target.
  const best = new Map<A4Direction, { align: number; wiki: string; id: number }>();

  // **The title must be the one the runtime will actually use.**
  //
  // `placeEdit(wiki, title, id, out)` hashes `${title}:${id}` for its jitter, so the
  // title is load-bearing. The first version of this planner searched with
  // `placeEdit(wiki, wiki, id)` — the *wiki* standing in for the title — and then
  // emitted an edit whose real title was `A4 ${label}`. The runtime hash therefore
  // differed from the planning hash, the jitter differed by up to ~34 degrees, and the
  // note landed somewhere other than where the label said.
  //
  // The symptom was the whole feature appearing broken: a note labelled RIGHT was
  // heard on the left. The plan was not a plan for the thing that was actually played.
  //
  // So: search with the title that will be used, for each label separately.
  for (const label of A4_DIRECTIONS) {
    const title = `A4 ${label}`;
    for (const wiki of CANDIDATE_WIKIS) {
      for (const id of CANDIDATE_IDS) {
        mapper.placeEdit(wiki, title, id, dir);
        const a = dot(dir, a4Target(basis, label));
        const prev = best.get(label);
        if (!prev || a > prev.align) best.set(label, { align: a, wiki, id });
      }
    }
  }

  const steps: A4Step[] = [];
  const used = new Set<string>();
  for (const label of A4_DIRECTIONS) {
    const hit = best.get(label);
    if (!hit) continue;
    // Two labels must not resolve to the same edit, or "LEFT" and "RIGHT" would both be
    // the same sound and the test could not tell them apart.
    const key = `${hit.wiki}:${hit.id}`;
    if (used.has(key)) continue;
    used.add(key);

    // Recompute with the *runtime* title, so `dir` is what will really be played.
    const title = `A4 ${label}`;
    mapper.placeEdit(hit.wiki, title, hit.id, dir);
    const align = dot(dir, a4Target(basis, label));
    const errorDeg = (Math.acos(Math.min(1, Math.max(-1, align))) * 180) / Math.PI;
    steps.push({
      label,
      wiki: hit.wiki,
      // The title IS the expected direction, so the screen states the answer the ear
      // has to confirm.
      title,
      id: hit.id,
      dir: { x: dir.x, y: dir.y, z: dir.z },
      radius: mapper.radiusOf(hit.wiki, hit.id),
      alignment: align,
      errorDeg,
    });
  }
  return steps;
}

/** Exposed so a caller can log how far apart two homes are. */
export function homeIndexOf(wiki: string, homes: number): number {
  return hashIndex(wiki, homes);
}
