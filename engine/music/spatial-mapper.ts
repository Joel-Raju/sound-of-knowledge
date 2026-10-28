/**
 * Edit → direction and radius in space. Spec §7.9.
 *
 * Shared by audio and visuals so a sound is heard from exactly where its comet
 * appears (§2.2.3, §2.3.6). **Deterministic**: the same edit always maps to the
 * same point, so audio and visuals cannot disagree even though they run at
 * different rates on different clocks.
 *
 * Two properties create the spatial structure:
 *  - **language homes** — 64 Fibonacci-sphere directions, one per language
 *    family, so edits cluster into recognisable regions of the space;
 *  - **per-edit jitter** — a small angular perturbation off the home, so a
 *    cluster is a cloud rather than a point.
 */
import { hashGaussianish, hashIndex, hashUniforms } from "../util/hash";
import { GOLDEN_ANGLE } from "../util/math";
import { LANG_HOMES, SHELL_RADIUS_LO, SHELL_RADIUS_SPAN } from "../config";
import type { Vec3 } from "../types";

/**
 * 64 unit vectors on a Fibonacci sphere. Precomputed once at module load:
 * precomputing beats calling `cos`/`sin` 64× per edit, and this table is the
 * same in the worker, the main thread and the tests.
 */
const HOMES: Float64Array = (() => {
  const out = new Float64Array(LANG_HOMES * 3);
  const ga = GOLDEN_ANGLE;
  for (let i = 0; i < LANG_HOMES; i++) {
    const y = 1 - (i / (LANG_HOMES - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = ga * i;
    out[i * 3] = Math.cos(th) * r;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = Math.sin(th) * r;
  }
  return out;
})();

/** Preallocated scratch — spec §7.9 forbids per-call allocation here. */
const u = new Float64Array(3);

function homeOf(wiki: string, out: Vec3): Vec3 {
  const i = hashIndex(wiki, LANG_HOMES) * 3;
  out.x = HOMES[i]!;
  out.y = HOMES[i + 1]!;
  out.z = HOMES[i + 2]!;
  return out;
}

const scratchHome: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Spec §7.9 — perturb `home` by a random angle with σ ≈ 0.30 rad in a random
 * tangent direction, then renormalise.
 *
 * A proper tangent basis (rather than nudging x/y/z independently) is what
 * keeps the perturbation *on the sphere*: nudging components directly would
 * change the radius and push edits off the shell, which is visible as a
 * non-uniform density.
 */
function jitter(home: Vec3, angle: number, out: Vec3): Vec3 {
  // Build an arbitrary tangent basis around `home`.
  let ux = 0;
  let uy = 1;
  const uz = 0;
  if (Math.abs(home.y) > 0.9) {
    ux = 1;
    uy = 0;
  }
  // t1 = normalize(cross(home, u))
  let t1x = home.y * uz - home.z * uy;
  let t1y = home.z * ux - home.x * uz;
  let t1z = home.x * uy - home.y * ux;
  const t1l = Math.hypot(t1x, t1y, t1z) || 1;
  t1x /= t1l;
  t1y /= t1l;
  t1z /= t1l;
  // t2 = cross(home, t1)  (already unit length if home and t1 are unit)
  const t2x = home.y * t1z - home.z * t1y;
  const t2y = home.z * t1x - home.x * t1z;
  const t2z = home.x * t1y - home.y * t1x;

  // Random tangent direction from the third hashed uniform.
  const phi = u[2]! * Math.PI * 2;
  const dx = Math.cos(phi) * t1x + Math.sin(phi) * t2x;
  const dy = Math.cos(phi) * t1y + Math.sin(phi) * t2y;
  const dz = Math.cos(phi) * t1z + Math.sin(phi) * t2z;

  const s = Math.sin(angle);
  const c = Math.cos(angle);
  out.x = home.x * c + dx * s;
  out.y = home.y * c + dy * s;
  out.z = home.z * c + dz * s;

  const len = Math.hypot(out.x, out.y, out.z) || 1;
  out.x /= len;
  out.y /= len;
  out.z /= len;
  return out;
}

export interface SpatialMapperOptions {
  /** angular jitter sigma in radians (spec default 0.30) */
  jitterSigma?: number;
}

/**
 * Deterministic edit → (direction, radius). Writes into caller-provided
 * objects; never allocates (spec §7.9).
 */
export class SpatialMapper {
  private readonly jitterSigma: number;

  constructor(opts: SpatialMapperOptions = {}) {
    this.jitterSigma = opts.jitterSigma ?? 0.3;
  }

  /** Map an edit into `out`, which is overwritten. Returns `out`. */
  placeEdit(wiki: string, title: string, id: number, out: Vec3): Vec3 {
    homeOf(wiki, scratchHome);
    hashUniforms(`${title}:${id}`, u, 3);

    // u[0] → radius, u[1] → jitter angle (signed), u[2] → tangent direction.
    const radius = SHELL_RADIUS_LO + SHELL_RADIUS_SPAN * u[0]!;
    const g = hashGaussianish(u[0]!, u[1]!, hashIndex(`${title}:${id}`, 997) / 997);
    const angle = g * this.jitterSigma;

    jitter(scratchHome, angle, out);
    // Radius is returned separately by `radiusOf`; store nothing here.
    void radius;
    return out;
  }

  /** Shell radius in `[7, 13]` for an edit. Spec §7.9: `7 + 6u`. */
  radiusOf(title: string, id: number): number {
    hashUniforms(`${title}:${id}`, u, 3);
    return SHELL_RADIUS_LO + SHELL_RADIUS_SPAN * u[0]!;
  }

  /** The language home direction, for tests and the debug overlay. */
  homeOfWiki(wiki: string, out: Vec3): Vec3 {
    return homeOf(wiki, out);
  }

  /**
   * The i-th home in the Fibonacci table, bypassing the string hash.
   *
   * Exposed so tests can assert properties of the **table** (64 distinct,
   * evenly spread points) rather than of the hash of arbitrary wiki names —
   * mapping 64 distinct strings onto 64 slots necessarily collides (birthday
   * problem: ~52 unique), and that is correct behaviour, not a bug.
   */
  homeAt(i: number, out: Vec3): Vec3 {
    const k = (((i % LANG_HOMES) + LANG_HOMES) % LANG_HOMES) * 3;
    out.x = HOMES[k]!;
    out.y = HOMES[k + 1]!;
    out.z = HOMES[k + 2]!;
    return out;
  }
}

/** Shared default instance — the mapper is stateless apart from scratch. */
export const spatialMapper = new SpatialMapper();
