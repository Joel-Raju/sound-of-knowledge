/**
 * §10.2 — the fire table, cell by cell.
 *
 * **Why this file exists.** Since T4.2 the harness has fired sparks and orb impacts
 * from hand-written synthetic code in `visual-harness.tsx`. That code looked right and
 * matched the table by eye, but the table itself had never been executed — nothing
 * checked that a revert dents instead of pushing, that a large edit's streak is 1.8×
 * size, or that impacts land at `duration*0.85`. Those are precisely the errors that
 * produce visuals that feel subtly wrong with no visible fault.
 *
 * The director takes structural types, so the whole table runs against recording fakes
 * with no WebGL context.
 */
import { describe, expect, it, beforeEach } from "vitest";
import * as THREE from "three";
import {
  VisualDirector,
  PENDING_IMPACT_SLOTS,
  IMPACT_MAGNITUDE,
  LARGE_STREAK_SIZE_SCALE,
  TRAUMA_LARGE,
  TRAUMA_REVERT,
  FIRE_FLAVORS,
  type FireTargets,
} from "@/engine/visual/fire";
import {
  sparkDuration,
  SPARK_ARRIVAL_FRACTION,
  SPARK_COUNTS,
} from "@/engine/visual/sparks";
import { BLOOM_SWELL_LARGE } from "@/engine/visual/post";
import type { NoteEvent, NormalizedEdit, NoteFlavor } from "@/engine/types";

interface Call {
  args: unknown[];
}

const recorder = () => {
  const calls: Record<string, Call[]> = {};
  return {
    calls,
    of(name: string): Call[] {
      return calls[name] ?? [];
    },
    add(name: string, ...args: unknown[]): void {
      (calls[name] ??= []).push({ args });
    },
  };
};

const edit = (over: Partial<NormalizedEdit> = {}): NormalizedEdit => ({
  id: 1,
  ts: 0,
  wiki: "enwiki",
  host: "en.wikipedia.org",
  lang: "en",
  project: "wikipedia",
  ns: 0,
  title: "Albert Einstein",
  actor: "registered",
  kind: "edit",
  minor: false,
  delta: 4000,
  absDelta: 4000,
  magnitude: 0.8,
  importance: 0.8,
  revNew: 5,
  ...over,
});

const note = (flavor: NoteFlavor, over: Partial<NoteEvent> = {}): NoteEvent => ({
  when: 0,
  voice: "pluck",
  midi: 60,
  freq: 261.6,
  vel: 0.7,
  dir: { x: 1, y: 0, z: 0 },
  radius: 9,
  edit: edit(),
  flavor,
  visual: true,
  ...over,
});

/** The shell origin every test fires from — a point on the 7–13 shell, not the core. */
const ORIGIN = new THREE.Vector3(0, 0, 9);

function harness(): { d: VisualDirector; r: ReturnType<typeof recorder>; t: FireTargets } {
  const r = recorder();
  const t: FireTargets = {
    sparks: {
      spawnStreak: (o, d, c, m, opts) => {
        r.add("streak", o, d, c, m, opts);
        return 10;
      },
      spawnBurst: (o, c, m) => {
        r.add("burst", o, c, m);
        return 48;
      },
      spawnBotPulse: (o, d, c, m) => {
        r.add("botPulse", o, d, c, m);
        return 1;
      },
    },
    rings: {
      spawn: (o, c, at) => {
        r.add("ring", o, c, at);
        return 1;
      },
    },
    orb: {
      addImpact: (d, m, k, at) => {
        r.add("impact", d, m, k, at);
      },
    },
    colorFor: (k) => new THREE.Color(k === "revert" ? 1 : 0.5, 0.5, 0.5),
    post: {
      kickChromaticAberration: (a) => r.add("caKick", a),
      swellBloom: (a) => r.add("swell", a),
    },
    addTrauma: (a) => r.add("trauma", a),
    labels: {
      spawn: (e, o, now) => {
        r.add("label", e, o, now);
        return true;
      },
      maybeEmitNotable: (e, now) => {
        r.add("ticker", e, now);
        return true;
      },
    },
  };
  return { d: new VisualDirector(t), r, t };
}

let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});

const fire = (flavor: NoteFlavor, over: Partial<NoteEvent> = {}, now = 0): void => {
  h.d.fire(note(flavor, over), ORIGIN, now);
};

/**
 * Advance the clock far enough for every deferred impact to arrive.
 *
 * Necessary because §10.2 defers every `push` impact to arrival time: `orb.addImpact`
 * is simply not called until `flush`, so any test inspecting an impact has to let the
 * clock reach it. Asserting on `impact` without this reads an empty array — and a
 * `for` loop over an empty array passes vacuously, which is how one of these tests was
 * green for the wrong reason.
 */
const flushAll = (): void => {
  for (let t = 0; t < 20; t += 0.05) h.d.flush(t);
};

describe("§10.2 — the sparks column", () => {
  it("add fires a streak", () => {
    fire("add");
    expect(h.r.of("streak")).toHaveLength(1);
  });

  it("remove fires a streak", () => {
    fire("remove");
    expect(h.r.of("streak")).toHaveLength(1);
  });

  it("large fires a streak at 1.8x size", () => {
    fire("large");
    const opts = h.r.of("streak")[0]!.args[4] as { sizeScale?: number };
    expect(opts.sizeScale).toBeCloseTo(LARGE_STREAK_SIZE_SCALE);
    expect(opts.sizeScale).toBeCloseTo(1.8);
  });

  it("add and remove both use size 1", () => {
    fire("add");
    fire("remove");
    for (const c of h.r.of("streak")) {
      expect((c.args[4] as { sizeScale?: number }).sizeScale).toBe(1);
    }
  });

  it("§10.2's accent and core are the two brightness variants", () => {
    // The spec names these variants in the table but §9.5 defines only three spark
    // kinds and no such switch. Brightness is the only per-streak style axis §9.5
    // defines that the two words could mean, and `core` is the brighter of the two:
    // a removal is an event about the content, not the record.
    fire("add");
    const add = h.r.of("streak")[0]!.args[4] as { brightnessScale?: number };
    fire("remove");
    const rem = h.r.of("streak")[1]!.args[4] as { brightnessScale?: number };
    expect(add.brightnessScale).toBeDefined();
    expect(rem.brightnessScale).toBeDefined();
    expect(rem.brightnessScale!).toBeGreaterThan(add.brightnessScale!);
  });

  it("revert fires no spark", () => {
    // The ring and the dent are the whole visual for a revert.
    fire("revert");
    expect(h.r.of("streak")).toHaveLength(0);
    expect(h.r.of("burst")).toHaveLength(0);
  });

  it("new fires a burst of 48 at the origin", () => {
    fire("new");
    expect(h.r.of("burst")).toHaveLength(1);
    expect(h.r.of("burst")[0]!.args[0]).toBe(ORIGIN);
    expect(SPARK_COUNTS.burst).toBe(48);
  });

  it("new fires one burst, not one per arpeggio note", () => {
    // §10.2 — "first note only". `NoteEvent.visual` is false for a birth's trailing
    // arpeggio notes, which is exactly that flag.
    fire("new", { visual: false });
    expect(h.r.of("burst")).toHaveLength(0);
  });

  it("bot-thud fires a bot pulse", () => {
    fire("bot-thud");
    expect(h.r.of("botPulse")).toHaveLength(1);
    expect(h.r.of("streak")).toHaveLength(0);
  });

  it("bot-tick fires a smaller bot pulse than bot-thud", () => {
    // §10.2 — "(smaller, dimmer)". One particle is already the minimum count, so
    // "smaller" has to be the magnitude that feeds the particle's size.
    fire("bot-thud");
    const thud = h.r.of("botPulse")[0]!.args[3] as number;
    fire("bot-tick");
    const tick = h.r.of("botPulse")[1]!.args[3] as number;
    expect(tick).toBeLessThan(thud);
  });
});

describe("§10.2 — the rings column", () => {
  it("only revert fires a ring", () => {
    for (const f of FIRE_FLAVORS) {
      fire(f);
    }
    expect(h.r.of("ring")).toHaveLength(1);
    expect(h.r.of("ring")[0]!.args[0]).toBe(ORIGIN);
  });

  it("the revert ring starts immediately", () => {
    fire("revert", {}, 12);
    expect(h.r.of("ring")[0]!.args[2]).toBe(12);
  });
});

describe("§10.2 — the orb impact column", () => {
  it("revert dents, and does so immediately", () => {
    // The only row that says "immediately" and the only one that says "dent".
    fire("revert", {}, 7);
    const hits = h.r.of("impact");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.args[2]).toBe("dent");
    expect(hits[0]!.args[3]).toBe(7);
  });

  it("add and remove push at arrival, not immediately", () => {
    fire("add", {}, 0);
    fire("remove", {}, 0);
    // Nothing yet: both are deferred to arrival.
    expect(h.r.of("impact")).toHaveLength(0);
    flushAll();
    expect(h.r.of("impact")).toHaveLength(2);
    for (const c of h.r.of("impact")) {
      expect(c.args[2]).toBe("push");
      expect(c.args[3]).toBeGreaterThan(0);
    }
  });

  it("large pushes harder than add does", () => {
    fire("add");
    flushAll();
    const normal = h.r.of("impact")[0]!.args[1] as number;
    h = harness();
    fire("large");
    flushAll();
    const strong = h.r.of("impact")[0]!.args[1] as number;
    expect(strong).toBeGreaterThan(normal);
    expect(strong).toBeCloseTo(IMPACT_MAGNITUDE.large);
  });

  it("bot-thud pushes softly", () => {
    fire("bot-thud");
    flushAll();
    expect(h.r.of("impact")[0]!.args[1]).toBeCloseTo(IMPACT_MAGNITUDE.small);
  });

  it("bot-tick fires no impact", () => {
    fire("bot-tick");
    expect(h.r.of("impact")).toHaveLength(0);
  });

  it("new fires no impact", () => {
    fire("new");
    expect(h.r.of("impact")).toHaveLength(0);
  });
});

describe("§10.2 — 'at arrival time (now + duration*0.85)'", () => {
  it("arrives at 85 % of §9.5's duration", () => {
    const n = note("add", { edit: edit({ magnitude: 0.5 }) });
    fire("add", { edit: n.edit }, 0);
    const expected = sparkDuration(0.5) * SPARK_ARRIVAL_FRACTION;
    expect(expected).toBeCloseTo(1.45 * 0.85, 10);
    expect(h.d.pendingImpacts).toBe(1);
    // Fired at the right moment, not before it.
    expect(h.d.flush(expected - 0.01)).toBe(0);
    expect(h.d.flush(expected + 0.01)).toBe(1);
    expect(h.r.of("impact")[0]!.args[3]).toBeCloseTo(expected + 0.01, 6);
  });

  it("tracks magnitude — a bigger edit's streak arrives sooner", () => {
    // §9.5 — `lerp(1.1, 1.8, 1 − magnitude)`. Small edits are slow and long, so their
    // impact is correspondingly later. If these two ever arrived together the orb
    // would stop reading the size of the edit.
    const arrivalFor = (m: number): number => {
      h = harness();
      fire("add", { edit: edit({ magnitude: m }) }, 0);
      let at = -1;
      for (let t = 0; t < 5; t += 0.001) {
        if (h.d.flush(t) === 1) {
          at = t;
          break;
        }
      }
      return at;
    };
    expect(arrivalFor(0.9)).toBeLessThan(arrivalFor(0.1));
  });

  it("uses the same duration the particle was spawned with", () => {
    // The impact and the spark must agree; two copies of §9.5's formula is how they
    // would drift apart, and a drifted arrival is invisible when wrong.
    fire("add", { edit: edit({ magnitude: 0.42 }) });
    const m = 0.42;
    let at = -1;
    for (let t = 0; t < 5; t += 0.001) {
      if (h.d.flush(t) === 1) {
        at = t;
        break;
      }
    }
    expect(at).toBeCloseTo(sparkDuration(m) * SPARK_ARRIVAL_FRACTION, 2);
  });

  it("strikes toward the core, not toward the edit", () => {
    fire("add", {}, 0);
    flushAll();
    const dir = h.r.of("impact")[0]!.args[0] as THREE.Vector3;
    // ORIGIN is (0,0,9), so toward the core is (0,0,-1).
    expect(dir.x).toBeCloseTo(0);
    expect(dir.y).toBeCloseTo(0);
    expect(dir.z).toBeCloseTo(-1);
  });
});

describe("§10.2 — pendingImpacts[32]", () => {
  it("has the spec's slot count", () => {
    expect(PENDING_IMPACT_SLOTS).toBe(32);
  });

  it("never queues more than 32, dropping the oldest arrival", () => {
    for (let i = 0; i < 100; i++) fire("add", { edit: edit({ magnitude: i / 100 }) }, i);
    expect(h.d.pendingImpacts).toBeLessThanOrEqual(PENDING_IMPACT_SLOTS);
    expect(h.d.pendingImpacts).toBe(PENDING_IMPACT_SLOTS);
  });

  it("a slot is reusable once its impact has fired", () => {
    for (let i = 0; i < PENDING_IMPACT_SLOTS; i++) fire("add", {}, i);
    expect(h.d.pendingImpacts).toBe(PENDING_IMPACT_SLOTS);
    // Fire them all; the pool must come back empty rather than stay full forever.
    expect(h.d.flush(1000)).toBe(PENDING_IMPACT_SLOTS);
    expect(h.d.pendingImpacts).toBe(0);
    fire("add", {}, 1001);
    expect(h.d.pendingImpacts).toBe(1);
  });

  it("fires late impacts rather than skipping them", () => {
    // A skipped impact is a hole: the orb reacts to some edits and silently not to
    // others, with no way to tell which.
    fire("add", {}, 0);
    expect(h.d.flush(99)).toBe(1);
    expect(h.r.of("impact")).toHaveLength(1);
  });

  it("fires nothing before the arrival time", () => {
    fire("add", {}, 0);
    expect(h.d.flush(0.001)).toBe(0);
    expect(h.d.pendingImpacts).toBe(1);
  });

  it("clear() empties it, so a hidden tab does not dump a wall of impacts", () => {
    for (let i = 0; i < 10; i++) fire("add", {}, i);
    h.d.clear();
    expect(h.d.pendingImpacts).toBe(0);
    expect(h.d.flush(1000)).toBe(0);
  });
});

describe("§10.2 — the 'other' column", () => {
  it("large adds trauma 0.15", () => {
    fire("large");
    expect(h.r.of("trauma")[0]!.args[0]).toBeCloseTo(TRAUMA_LARGE);
    expect(TRAUMA_LARGE).toBeCloseTo(0.15);
  });

  it("large swells the bloom", () => {
    fire("large");
    expect(h.r.of("swell")[0]!.args[0]).toBeCloseTo(BLOOM_SWELL_LARGE);
    expect(BLOOM_SWELL_LARGE).toBeGreaterThan(0);
  });

  it("revert adds trauma 0.30 and a CA kick", () => {
    fire("revert");
    expect(h.r.of("trauma")[0]!.args[0]).toBeCloseTo(TRAUMA_REVERT);
    expect(TRAUMA_REVERT).toBeCloseTo(0.3);
    expect(h.r.of("caKick")).toHaveLength(1);
  });

  it("add and remove add neither trauma nor bloom nor CA", () => {
    fire("add");
    fire("remove");
    expect(h.r.of("trauma")).toHaveLength(0);
    expect(h.r.of("swell")).toHaveLength(0);
    expect(h.r.of("caKick")).toHaveLength(0);
  });

  it("revert's dent is not deferred — the CA kick is with it", () => {
    // Both happen in the same instant, which is why revert feels like one event.
    fire("revert", {}, 5);
    expect(h.r.of("impact")[0]!.args[3]).toBe(5);
    expect(h.r.of("caKick")).toHaveLength(1);
    expect(h.d.pendingImpacts).toBe(0);
  });
});

describe("§9.9 — labels and ticker are driven by every note", () => {
  it("every flavor offers its edit to the label gate", () => {
    for (const f of FIRE_FLAVORS) fire(f);
    expect(h.r.of("label")).toHaveLength(FIRE_FLAVORS.length);
  });

  it("every flavor offers its edit to the ticker", () => {
    for (const f of FIRE_FLAVORS) fire(f);
    expect(h.r.of("ticker")).toHaveLength(FIRE_FLAVORS.length);
  });

  it("the director forwards rather than re-deciding", () => {
    // §9.9 gives labels and the ticker separate thresholds, intervals and exclusions.
    // If the director filtered first, one of the two sets of numbers would be dead.
    fire("bot-thud", { edit: edit({ actor: "bot", importance: 0.1, ns: 3 }) });
    expect(h.r.of("label")).toHaveLength(1);
    expect(h.r.of("ticker")).toHaveLength(1);
  });

  it("the label is offered the edit's shell origin", () => {
    fire("add");
    expect(h.r.of("label")[0]!.args[1]).toBe(ORIGIN);
  });
});

describe("the table is exhaustive", () => {
  it("covers every flavor §5.6 defines", () => {
    expect([...FIRE_FLAVORS].sort()).toEqual(
      ["add", "bot-tick", "bot-thud", "large", "new", "remove", "revert"].sort(),
    );
  });

  it("fires something visible for every flavor", () => {
    // A flavor with an empty row would be a flavor that makes no sound visually, and
    // the table should have no such row.
    for (const f of FIRE_FLAVORS) {
      h = harness();
      fire(f);
      const fired =
        h.r.of("streak").length +
        h.r.of("burst").length +
        h.r.of("botPulse").length +
        h.r.of("ring").length +
        h.r.of("impact").length;
      expect(fired, `${f} fires nothing`).toBeGreaterThan(0);
    }
  });

  it("works without the optional extras", () => {
    // The offline renderer has no DOM and no camera rig; the director must not
    // require them to exist.
    const r = recorder();
    const bare = new VisualDirector({
      sparks: {
        spawnStreak: () => 1,
        spawnBurst: () => 1,
        spawnBotPulse: () => 1,
      },
      rings: { spawn: () => 1 },
      orb: { addImpact: (...a) => void r.add("impact", ...a) },
      colorFor: () => new THREE.Color(),
    });
    expect(() => bare.fire(note("revert"), ORIGIN, 0)).not.toThrow();
    expect(r.of("impact")).toHaveLength(1);
  });
});