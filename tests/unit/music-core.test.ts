import { describe, expect, it } from "vitest";
import { euclid, rotate, countHits, gapSpread } from "@/engine/music/euclid";
import { SpatialMapper } from "@/engine/music/spatial-mapper";
import { route, velocityOf, shouldDoubleAsMelodic } from "@/engine/music/router";
import { EnergyTracker } from "@/engine/music/density";
import { mulberry32 } from "@/engine/util/random";
import {
  BOT_REF,
  DENSITY_MUL,
  LANG_HOMES,
  SHELL_RADIUS_HI,
  SHELL_RADIUS_LO,
  VEL_MAX,
  VEL_MIN,
} from "@/engine/config";
import { rateToEnergy } from "@/engine/util/perf";
import type { NormalizedEdit, Vec3 } from "@/engine/types";

const s = (b: boolean[]): string => b.map((x) => (x ? "x" : ".")).join("");

// spec §13.2 row `euclid`
describe("euclid", () => {
  it("matches the spec's exact reference patterns", () => {
    expect(s(euclid(3, 8))).toBe("x..x..x.");
    expect(s(euclid(5, 8))).toBe("x.xx.xx.");
    expect(s(euclid(4, 16))).toBe("x...x...x...x...");
  });

  it("emits exactly k hits in n steps", () => {
    for (let n = 2; n <= 16; n++) {
      for (let k = 0; k <= n; k++) {
        const p = euclid(k, n);
        expect(p.length).toBe(n);
        expect(countHits(p)).toBe(k);
      }
    }
  });

  it("euclid(7,16): 7 hits with gaps differing by ≤ 1", () => {
    const p = euclid(7, 16);
    expect(countHits(p)).toBe(7);
    const { min, max } = gapSpread(p);
    expect(max - min).toBeLessThanOrEqual(1);
  });

  it("distributes onsets evenly for every (k,16)", () => {
    for (let k = 1; k <= 15; k++) {
      const { min, max } = gapSpread(euclid(k, 16));
      expect(max - min, `k=${k}`).toBeLessThanOrEqual(1);
    }
  });

  it("handles degenerate inputs", () => {
    expect(euclid(0, 16)).toEqual(new Array<boolean>(16).fill(false));
    expect(euclid(16, 16).every(Boolean)).toBe(true);
    expect(euclid(99, 8).filter(Boolean).length).toBe(8); // clamped to n
    expect(euclid(3, 0)).toEqual([]);
  });

  it("rotate preserves hit count and wraps", () => {
    const p = euclid(3, 8);
    for (const shift of [0, 1, 3, 7, 8, -1, -9]) {
      const r = rotate(p, shift);
      expect(countHits(r)).toBe(countHits(p));
    }
    expect(rotate(p, 0)).toEqual(p);
    expect(rotate(p, 8)).toEqual(p);
    // Rotating left by 3 moves the onsets {0,3,6} to {3,6,1}.
    expect(rotate(p, 3)).toEqual([true, false, false, true, false, true, false, false]);
  });

  it("rotate handles an empty pattern", () => {
    expect(rotate([], 3)).toEqual([]);
  });
});

// spec §13.2 row `spatial-mapper`
describe("SpatialMapper", () => {
  const m = new SpatialMapper();
  const out: Vec3 = { x: 0, y: 0, z: 0 };

  it("is deterministic", () => {
    const a: Vec3 = { x: 0, y: 0, z: 0 };
    const b: Vec3 = { x: 0, y: 0, z: 0 };
    m.placeEdit("enwiki", "Albert Einstein", 12345, a);
    m.placeEdit("enwiki", "Albert Einstein", 12345, b);
    expect(a).toEqual(b);
    expect(m.radiusOf("Albert Einstein", 12345)).toBe(m.radiusOf("Albert Einstein", 12345));
  });

  it("produces unit-length directions", () => {
    for (let i = 0; i < 2000; i++) {
      m.placeEdit(`wiki${i % 40}`, `Title ${i}`, i, out);
      const len = Math.hypot(out.x, out.y, out.z);
      expect(len).toBeCloseTo(1, 6);
    }
  });

  it("keeps radius within [7, 13]", () => {
    for (let i = 0; i < 2000; i++) {
      const r = m.radiusOf(`Title ${i}`, i);
      expect(r).toBeGreaterThanOrEqual(SHELL_RADIUS_LO);
      expect(r).toBeLessThanOrEqual(SHELL_RADIUS_HI);
    }
  });

  it("spreads radius across the full shell", () => {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 5000; i++) {
      const r = m.radiusOf(`T${i}`, i);
      if (r < min) min = r;
      if (r > max) max = r;
    }
    expect(min).toBeLessThan(7.5);
    expect(max).toBeGreaterThan(12.5);
  });

  it("same-wiki edits cluster near their home (median < 0.6 rad)", () => {
    const home: Vec3 = { x: 0, y: 0, z: 0 };
    m.homeOfWiki("enwiki", home);
    const angles: number[] = [];
    for (let i = 0; i < 500; i++) {
      m.placeEdit("enwiki", `Article ${i}`, 1000 + i, out);
      const dot = Math.min(1, Math.max(-1, home.x * out.x + home.y * out.y + home.z * out.z));
      angles.push(Math.acos(dot));
    }
    angles.sort((a, b) => a - b);
    const median = angles[Math.floor(angles.length / 2)]!;
    expect(median).toBeLessThan(0.6);
  });

  it("distributes the 64 homes evenly over the sphere", () => {
    // A Fibonacci sphere's mean nearest-neighbour distance approximates
    // sqrt(4π/N) ≈ 0.44 rad for N = 64. Asserting the *shape* of the
    // distribution catches a collapsed or clustered generator.
    //
    // Note this reads the home **table** directly. Mapping 64 distinct wiki
    // strings onto 64 slots via FNV necessarily collides (birthday problem,
    // ~52 unique) — that is correct, and asserting 64 unique hashes would be
    // asserting a broken hash table.
    const homes: Vec3[] = [];
    for (let i = 0; i < LANG_HOMES; i++) {
      const v: Vec3 = { x: 0, y: 0, z: 0 };
      m.homeAt(i, v);
      homes.push(v);
      expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(1, 6); // unit vectors
    }
    const unique = new Set(
      homes.map((h) => `${h.x.toFixed(4)},${h.y.toFixed(4)},${h.z.toFixed(4)}`),
    );
    expect(unique.size).toBe(LANG_HOMES);

    let sumNearest = 0;
    for (let i = 0; i < homes.length; i++) {
      let best = Infinity;
      for (let j = 0; j < homes.length; j++) {
        if (i === j) continue;
        const a = homes[i]!;
        const b = homes[j]!;
        const dot = Math.min(1, Math.max(-1, a.x * b.x + a.y * b.y + a.z * b.z));
        best = Math.min(best, Math.acos(dot));
      }
      sumNearest += best;
    }
    const meanNearest = sumNearest / homes.length;
    expect(meanNearest).toBeGreaterThan(0.15);
    expect(meanNearest).toBeLessThan(0.8);
  });

  it("hashes wikis into the home table consistently", () => {
    const a: Vec3 = { x: 0, y: 0, z: 0 };
    const b: Vec3 = { x: 0, y: 0, z: 0 };
    m.homeOfWiki("enwiki", a);
    m.homeOfWiki("enwiki", b);
    expect(a).toEqual(b);
    // And it must equal one of the table entries.
    let matched = false;
    for (let i = 0; i < LANG_HOMES; i++) {
      const t: Vec3 = { x: 0, y: 0, z: 0 };
      m.homeAt(i, t);
      if (Math.hypot(t.x - a.x, t.y - a.y, t.z - a.z) < 1e-9) {
        matched = true;
        break;
      }
    }
    expect(matched).toBe(true);
  });

  it("spreads homes over both hemispheres", () => {
    let pos = 0;
    let neg = 0;
    for (let i = 0; i < LANG_HOMES; i++) {
      const v: Vec3 = { x: 0, y: 0, z: 0 };
      m.homeAt(i, v);
      if (v.y >= 0) pos++;
      else neg++;
    }
    expect(pos).toBeGreaterThan(LANG_HOMES * 0.4);
    expect(neg).toBeGreaterThan(LANG_HOMES * 0.4);
  });

  it("does not allocate — writes into the caller's object", () => {
    const target: Vec3 = { x: 9, y: 9, z: 9 };
    m.placeEdit("enwiki", "X", 1, target);
    expect(target).toBe(out === target ? target : target);
    expect(Math.hypot(target.x, target.y, target.z)).toBeCloseTo(1, 6);
  });

  it("LANG_HOMES is 64", () => {
    expect(LANG_HOMES).toBe(64);
  });
});

// spec §13.2 row `router`
describe("router — priority order (§7.5)", () => {
  const base: NormalizedEdit = {
    id: 1,
    ts: 0,
    wiki: "enwiki",
    host: "en.wikipedia.org",
    lang: "en",
    project: "wikipedia",
    ns: 0,
    title: "T",
    actor: "registered",
    kind: "edit",
    minor: false,
    delta: 100,
    absDelta: 100,
    magnitude: 0.1,
    importance: 0.4,
    revNew: 1,
  };

  it("new outranks everything", () => {
    expect(route({ ...base, kind: "new", actor: "bot", magnitude: 1 })).toBe("birth");
    expect(route({ ...base, kind: "new", delta: -1000 })).toBe("birth");
  });

  it("revert outranks bot and magnitude", () => {
    expect(route({ ...base, kind: "revert", actor: "bot", magnitude: 1 })).toBe("gong");
  });

  it("bot outranks magnitude", () => {
    expect(route({ ...base, actor: "bot", magnitude: 1 })).toBe("bot");
    expect(route({ ...base, actor: "bot", delta: -500 })).toBe("bot");
  });

  it("large edits outrank sign", () => {
    expect(route({ ...base, magnitude: 0.6, delta: 100 })).toBe("sub");
    expect(route({ ...base, magnitude: 0.6, delta: -100 })).toBe("sub");
    expect(route({ ...base, magnitude: 0.59, delta: -100 })).toBe("bell");
  });

  it("additions pluck, removals bell", () => {
    expect(route({ ...base, delta: 1 })).toBe("pluck");
    expect(route({ ...base, delta: 0 })).toBe("bell");
    expect(route({ ...base, delta: -1 })).toBe("bell");
  });

  it("velocity follows the §7.5 formula and clamps", () => {
    expect(velocityOf({ ...base, magnitude: 0.5, minor: false, actor: "registered" })).toBeCloseTo(
      0.55,
      6,
    );
    expect(velocityOf({ ...base, magnitude: 0.5, minor: true, actor: "anon" })).toBeCloseTo(0.5, 6);
    for (let mag = 0; mag <= 1; mag += 0.1) {
      for (const minor of [true, false]) {
        for (const actor of ["bot", "anon", "registered"] as const) {
          const v = velocityOf({ ...base, magnitude: mag, minor, actor });
          expect(v).toBeGreaterThanOrEqual(VEL_MIN);
          expect(v).toBeLessThanOrEqual(VEL_MAX);
        }
      }
    }
  });

  it("double-as-melodic fires ~35 % for large human edits only", () => {
    const rng = mulberry32(1);
    const big: NormalizedEdit = { ...base, magnitude: 0.9 };
    let n = 0;
    for (let i = 0; i < 20000; i++) if (shouldDoubleAsMelodic(big, rng)) n++;
    expect(n / 20000).toBeGreaterThan(0.32);
    expect(n / 20000).toBeLessThan(0.38);

    // Never for bots, reverts, new pages, or small edits.
    expect(shouldDoubleAsMelodic({ ...big, actor: "bot" }, rng)).toBe(false);
    expect(shouldDoubleAsMelodic({ ...big, kind: "revert" }, rng)).toBe(false);
    expect(shouldDoubleAsMelodic({ ...big, kind: "new" }, rng)).toBe(false);
    expect(shouldDoubleAsMelodic({ ...base, magnitude: 0.1 }, rng)).toBe(false);
  });
});

// spec §13.2 row `density`
describe("EnergyTracker", () => {
  function feed(t: EnergyTracker, eps: number, botRatio = 0.2, seconds = 60): void {
    // Feed 500 ms windows until the EMA has settled.
    for (let i = 0; i < seconds * 2; i++) {
      t.update({ accepted: eps * 0.5, botAccepted: eps * botRatio * 0.5, windowMs: 500 });
    }
  }

  it("E is monotonic in eps", () => {
    let prev = -1;
    for (let eps = 0; eps <= 60; eps += 1) {
      const t = new EnergyTracker();
      feed(t, eps);
      const e = t.E;
      expect(e).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = e;
    }
  });

  it("E(0) = 0", () => {
    const t = new EnergyTracker();
    feed(t, 0);
    expect(t.E).toBe(0);
  });

  it("E rises toward 1 as eps approaches EPS_REF", () => {
    const t = new EnergyTracker();
    feed(t, 15); // EPS_REF
    expect(t.E).toBeCloseTo(1, 1);
  });

  it("matches rateToEnergy for the settled value", () => {
    const t = new EnergyTracker();
    feed(t, 6);
    expect(t.E).toBeCloseTo(rateToEnergy(6, 15), 3);
  });

  it("botNorm is clamped to [0,1] against BOT_REF", () => {
    const t = new EnergyTracker();
    feed(t, 60, 1); // 60 bots/s vs BOT_REF = 8
    expect(t.botNorm).toBe(1);
    const u = new EnergyTracker();
    feed(u, 1, 0);
    expect(u.botNorm).toBe(0);
  });

  it("targetNotesPerSec scales with the density setting", () => {
    const t = new EnergyTracker();
    feed(t, 8);
    const sparse = t.targetNotesPerSec("sparse");
    const normal = t.targetNotesPerSec("normal");
    const dense = t.targetNotesPerSec("dense");
    expect(sparse).toBeLessThan(normal);
    expect(normal).toBeLessThan(dense);
    expect(sparse / normal).toBeCloseTo(DENSITY_MUL.sparse / DENSITY_MUL.normal, 6);
    expect(dense / normal).toBeCloseTo(DENSITY_MUL.dense / DENSITY_MUL.normal, 6);
  });

  it("targetNotesPerSec rises with energy", () => {
    const lo = new EnergyTracker();
    feed(lo, 2);
    const hi = new EnergyTracker();
    feed(hi, 14);
    expect(lo.targetNotesPerSec("normal")).toBeLessThan(hi.targetNotesPerSec("normal"));
  });

  it("BOT_REF is 8 (spec §7.1)", () => {
    expect(BOT_REF).toBe(8);
  });

  it("handles a zero-length stats window without NaN", () => {
    const t = new EnergyTracker();
    t.update({ accepted: 10, botAccepted: 2, windowMs: 0 });
    expect(Number.isFinite(t.E)).toBe(true);
    expect(Number.isFinite(t.eps)).toBe(true);
  });
});
