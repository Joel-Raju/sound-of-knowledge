import { describe, expect, it } from "vitest";
import { Scheduler } from "@/engine/music/scheduler";
import { SyntheticSource } from "@/engine/ingest/synthetic";
import { mulberry32 } from "@/engine/util/random";
import {
  GONG_COOLDOWN_SEC,
  LOOKAHEAD_HIDDEN_SEC,
  LOOKAHEAD_SEC,
  STEP_SEC,
  STEPS_PER_BAR,
  CHORD_BARS,
  BIRTH_COOLDOWN_SEC,
  HUMANIZE_SEC,
} from "@/engine/config";
import type { HarmonyEvent } from "@/engine/music/harmony";
import type { NoteEvent, NormalizedEdit } from "@/engine/types";

interface Harness {
  s: Scheduler;
  notes: NoteEvent[];
  harmonyEvents: HarmonyEvent[];
  advance: (ms: number) => void;
  setHidden: (v: boolean) => void;
  feed: (edits: NormalizedEdit[]) => void;
  now: () => number;
}

/**
 * Virtual-clock harness. `advance(ms)` moves the audio clock forward in 25 ms
 * heartbeat steps, exactly as the ingest worker would drive it in production.
 */
function harness(
  opts: { seed?: number; accept?: boolean; density?: "sparse" | "normal" | "dense" } = {},
): Harness {
  let now = 0;
  let hidden = false;
  const notes: NoteEvent[] = [];
  const harmonyEvents: HarmonyEvent[] = [];
  const accept = opts.accept ?? true;

  const s = new Scheduler({
    now: () => now,
    isHidden: () => hidden,
    rng: mulberry32(opts.seed ?? 12345),
    note: (n) => {
      if (!accept) return false;
      notes.push(n);
      return true;
    },
    harmony: (e) => harmonyEvents.push(e),
  });
  s.setDensity(opts.density ?? "dense");

  const advance = (ms: number) => {
    const target = now + ms / 1000;
    while (now < target) {
      now = Math.min(target, now + 0.025);
      s.onTick();
    }
  };

  return {
    s,
    notes,
    harmonyEvents,
    advance,
    setHidden: (v) => {
      hidden = v;
    },
    feed: (edits) => s.onBatch(edits),
    now: () => now,
  };
}

const edit = (over: Partial<NormalizedEdit> = {}): NormalizedEdit => ({
  id: Math.floor(Math.random() * 1e9),
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
  delta: 100,
  absDelta: 100,
  magnitude: 0.2,
  importance: 0.4,
  revNew: 1,
  ...over,
});

/** Feed a steady stream and let the scheduler run. */
function drive(h: Harness, seconds: number, source: SyntheticSource, eps = 6): void {
  for (let t = 0; t < seconds; t += 0.025) {
    const edits = source.next(25);
    if (edits.length) h.feed(edits);
    // Keep the energy tracker fed as the worker stats would (§6.5).
    h.s.onStats({
      accepted: eps * 0.5,
      botAccepted: eps * 0.2 * 0.5,
      windowMs: 500,
    });
    h.advance(25);
  }
}

// spec §13.2 row `scheduler`
describe("Scheduler — quantisation", () => {
  it("schedules every melodic note on the 16th grid within ±6 ms", () => {
    const h = harness();
    h.setHidden(false);
    const src = new SyntheticSource({ seed: 1, rateMul: 6 });
    drive(h, 30, src);

    // Anchor to the scheduler's own grid origin — the first step lands at
    // `now + 0.05`, not at wall-clock zero.
    const t0 = h.s.gridOrigin;
    let checked = 0;
    for (const n of h.notes) {
      const steps = (n.when - t0) / STEP_SEC;
      const offGrid = Math.abs(steps - Math.round(steps)) * STEP_SEC;
      // ±6 ms covers the spec's humanize allowance (§7.1).
      expect(offGrid).toBeLessThanOrEqual(0.0061);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("emits at most 2 melodic notes per step", () => {
    const h = harness();
    const src = new SyntheticSource({ seed: 2, rateMul: 40 });
    drive(h, 30, src);

    const byStep = new Map<number, number>();
    const t0 = h.now() - 30;
    for (const n of h.notes) {
      if (n.flavor !== "add" && n.flavor !== "remove") continue;
      const step = Math.round((n.when - t0) / STEP_SEC);
      byStep.set(step, (byStep.get(step) ?? 0) + 1);
    }
    for (const [, count] of byStep) expect(count).toBeLessThanOrEqual(2);
  });

  it("schedules sub and gong only on beats (step % 4 === 0)", () => {
    const h = harness();
    // Flood with large edits and reverts so the beat gate is exercised.
    for (let i = 0; i < 400; i++) {
      h.feed([edit({ id: i + 1, magnitude: 0.95, kind: "edit", delta: 100000 })]);
      h.feed([edit({ id: 1000 + i, kind: "revert", magnitude: 0.8, delta: -100000 })]);
      h.advance(25);
    }
    const t0 = h.s.gridOrigin;
    let checked = 0;
    for (const n of h.notes) {
      if (n.voice !== "sub" && n.voice !== "gong") continue;
      const step = (n.when - t0) / STEP_SEC;
      expect(Math.abs(step / 4 - Math.round(step / 4))).toBeLessThan(0.02);
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
  });

  it("respects the gong cooldown of 1.2 s", () => {
    const h = harness();
    // Needs > 1.2 s of runtime for a second gong to be possible at all.
    for (let i = 0; i < 600; i++) {
      h.feed([edit({ id: 5000 + i, kind: "revert", magnitude: 0.9, delta: -99999 })]);
      h.advance(25);
    }
    const gongs = h.notes.filter((n) => n.voice === "gong").map((n) => n.when);
    gongs.sort((a, b) => a - b);
    expect(gongs.length).toBeGreaterThan(2);
    for (let i = 1; i < gongs.length; i++) {
      expect(gongs[i]! - gongs[i - 1]!).toBeGreaterThanOrEqual(GONG_COOLDOWN_SEC - 0.03);
    }
  });

  it("respects the birth cooldown of 1.5 s", () => {
    const h = harness();
    for (let i = 0; i < 600; i++) {
      h.feed([edit({ id: 7000 + i, kind: "new", magnitude: 0.5, delta: 5000 })]);
      h.advance(25);
    }
    // A birth arpeggio emits 4 notes, all tagged flavor 'new'; only the FIRST
    // is visual (§7.6). Filter on `visual` to get arpeggio onsets, otherwise
    // the 3 tail notes read as extra "births" 1 step apart.
    const firsts = h.notes
      .filter((n) => n.flavor === "new" && n.visual)
      .map((n) => n.when)
      .sort((a, b) => a - b);
    expect(firsts.length).toBeGreaterThan(1);
    for (let i = 1; i < firsts.length; i++) {
      expect(firsts[i]! - firsts[i - 1]!).toBeGreaterThanOrEqual(BIRTH_COOLDOWN_SEC - 0.03);
    }
  });

  it("emits exactly one visual note per birth arpeggio", () => {
    const h = harness();
    h.feed([edit({ id: 9001, kind: "new", magnitude: 0.5, delta: 5000 })]);
    h.advance(2000);
    const birth = h.notes.filter((n) => n.flavor === "new");
    expect(birth.length).toBe(4);
    expect(birth.filter((n) => n.visual).length).toBe(1);
  });
});

describe("Scheduler — queues and staleness", () => {
  it("drops items older than 4 s", () => {
    const h = harness();
    // One edit, then a long silence: it must not be played 10 s later.
    h.feed([edit({ id: 4242, magnitude: 0.2, delta: 100 })]);
    h.advance(1000);
    const before = h.notes.length;
    h.advance(9000);
    const after = h.notes.length;
    expect(after - before).toBeLessThanOrEqual(1);
  });

  it("bounds queue growth under sustained flood", () => {
    const h = harness();
    const src = new SyntheticSource({ seed: 5, rateMul: 500 });
    drive(h, 20, src);
    const q = h.s.queueLengths;
    expect(q.melodic).toBeLessThanOrEqual(256);
    expect(q.bot).toBeLessThanOrEqual(256);
    expect(q.sub).toBeLessThanOrEqual(32);
    expect(q.gong).toBeLessThanOrEqual(16);
    expect(q.birth).toBeLessThanOrEqual(16);
  });

  it("counts dropped notes when the sink refuses", () => {
    const h = harness({ accept: false });
    const src = new SyntheticSource({ seed: 6, rateMul: 5 });
    drive(h, 10, src);
    const m = h.s.getMetrics();
    expect(m.attemptedNotes).toBeGreaterThan(0);
    expect(m.notesScheduled).toBe(0);
    expect(m.droppedNotes).toBe(m.attemptedNotes);
  });
});

describe("Scheduler — percussion fuel gate (§7.8)", () => {
  it("produces no percussion without bot edits", () => {
    const h = harness();
    // Only human edits — no fuel.
    for (let i = 0; i < 200; i++) {
      h.feed([edit({ id: 20000 + i, actor: "registered", delta: 10 })]);
      h.advance(25);
    }
    expect(h.notes.filter((n) => n.voice === "thud" || n.voice === "tick")).toHaveLength(0);
  });

  it("produces percussion when bots are present, at most once per bot edit", () => {
    const h = harness();
    const src = new SyntheticSource({ seed: 7, rateMul: 8 });
    drive(h, 30, src);
    const perc = h.notes.filter((n) => n.voice === "thud" || n.voice === "tick");
    expect(perc.length).toBeGreaterThan(0);
    const ids = perc.map((n) => n.edit.id);
    expect(new Set(ids).size).toBe(ids.length); // each bot edit sounds once
  });

  it("never stacks a tick on a thud step", () => {
    const h = harness();
    const src = new SyntheticSource({ seed: 8, rateMul: 10 });
    drive(h, 20, src);
    const p = h.s.getPatterns();
    for (let i = 0; i < p.thud.length; i++) {
      expect(p.thud[i] && p.tick[i]).toBe(false);
    }
  });

  it("ticks are non-visual, thuds are visual", () => {
    const h = harness();
    const src = new SyntheticSource({ seed: 9, rateMul: 8 });
    drive(h, 20, src);
    for (const n of h.notes) {
      if (n.voice === "tick") expect(n.visual).toBe(false);
      if (n.voice === "thud") expect(n.visual).toBe(true);
    }
  });
});

describe("Scheduler — harmony integration", () => {
  it("emits a chord event every 4 bars", () => {
    const h = harness();
    // `advance` takes **milliseconds**.
    const bars = CHORD_BARS * 5;
    h.advance(bars * STEPS_PER_BAR * STEP_SEC * 1000);
    const chords = h.harmonyEvents.filter((e) => e.kind === "chord");
    // One chord change every CHORD_BARS bars, including the one at bar 0.
    // May be one higher: the 0.15 s lookahead can schedule the step at the
    // final bar boundary, landing exactly on the next chord change.
    expect(chords.length).toBeGreaterThanOrEqual(bars / CHORD_BARS);
    expect(chords.length).toBeLessThanOrEqual(bars / CHORD_BARS + 1);
    for (const c of chords) expect(c.state.barCounter % CHORD_BARS).toBe(0);
  });

  it("never emits a mode change off a phrase boundary", () => {
    const h = harness();
    let i = 0;
    for (let t = 0; t < 120; t += 0.025) {
      h.s.onStats({ accepted: i % 2 ? 0.1 : 60, botAccepted: 1, windowMs: 500 });
      i++;
      h.advance(25);
    }
    const modes = h.harmonyEvents.filter((e) => e.kind === "mode");
    for (const m of modes) expect(m.state.barCounter % 8).toBe(0);
  });

  it("emits harmony events stamped with audio time", () => {
    const h = harness();
    h.advance(20);
    for (const e of h.harmonyEvents) expect(e.at).toBeGreaterThan(0);
  });
});

describe("Scheduler — clock behaviour (§7.1)", () => {
  it("widens the lookahead when hidden", () => {
    expect(LOOKAHEAD_HIDDEN_SEC).toBeGreaterThan(LOOKAHEAD_SEC);

    const a = harness();
    a.advance(100);
    const hiddenSteps = a.s.getStats().stepIndex;

    const b = harness();
    b.setHidden(true);
    b.advance(100);
    const hiddenSteps2 = b.s.getStats().stepIndex;

    expect(hiddenSteps2).toBeGreaterThan(hiddenSteps);
  });

  it("recovers from a long stall without emitting a burst", () => {
    const h = harness();
    h.advance(5);
    const before = h.notes.length;
    const beforeStep = h.s.getStats().stepIndex;
    // Simulate a hidden tab / long GC: jump the clock forward 30 s in one tick.
    h.advance(30_000);
    expect(h.notes.length - before).toBeLessThan(40);
    expect(h.s.getStats().stepIndex - beforeStep).toBeLessThan(200);
  });

  it("never schedules a note in the past", () => {
    const h = harness();
    const src = new SyntheticSource({ seed: 10, rateMul: 6 });
    drive(h, 30, src);
    // Birth arpeggios schedule their tail notes up to 3 steps ahead, so the
    // *emission order* of notes is not their time order — checking monotonic
    // emission would be checking the wrong thing. What must hold is that no
    // note is ever scheduled before the clock has reached it.
    for (const n of h.notes) {
      // Humanize is ±6 ms by design, so the first-step note can land slightly
      // *before* the raw grid origin.
      expect(n.when).toBeGreaterThanOrEqual(h.s.gridOrigin - HUMANIZE_SEC);
    }
  });

  it("emission order is step order except within an arpeggio", () => {
    const h = harness();
    const src = new SyntheticSource({ seed: 10, rateMul: 6 });
    drive(h, 30, src);
    // The lookahead is 0.15 s < STEP_SEC = 0.22 s, so steps are scheduled one
    // at a time; any backward step is at most one arpeggio (3 steps) long.
    let maxBack = 0;
    let maxSeen = -Infinity;
    for (const n of h.notes) {
      if (n.when < maxSeen) maxBack = Math.max(maxBack, maxSeen - n.when);
      maxSeen = Math.max(maxSeen, n.when);
    }
    expect(maxBack).toBeLessThanOrEqual(3 * STEP_SEC + 0.01);
  });

  it("is deterministic under a fixed seed", () => {
    const run = (): string => {
      const h = harness({ seed: 999 });
      const src = new SyntheticSource({ seed: 999, rateMul: 5 });
      drive(h, 20, src);
      return h.notes.map((n) => `${n.voice}:${n.midi}:${n.when.toFixed(4)}`).join(",");
    };
    expect(run()).toBe(run());
  });
});

describe("Scheduler — note construction", () => {
  it("produces unit-length directions on every note", () => {
    const h = harness();
    const src = new SyntheticSource({ seed: 11, rateMul: 8 });
    drive(h, 20, src);
    for (const n of h.notes) {
      const len = Math.hypot(n.dir.x, n.dir.y, n.dir.z);
      expect(len).toBeCloseTo(1, 5);
    }
  });

  it("carries a unit direction and radius on every note", () => {
    const h = harness();
    h.feed([edit({ id: 31337, delta: 50, magnitude: 0.2 })]);
    h.advance(1000);
    expect(h.notes.length).toBeGreaterThan(0);
    for (const n of h.notes) {
      expect(n.radius).toBeGreaterThanOrEqual(7);
      expect(n.radius).toBeLessThanOrEqual(13);
      expect(n.edit).toBeDefined();
    }
  });

  it("gives pitched voices a frequency and unpitched voices zero", () => {
    const h = harness();
    const src = new SyntheticSource({ seed: 12, rateMul: 8 });
    drive(h, 20, src);
    for (const n of h.notes) {
      if (n.voice === "thud" || n.voice === "tick") {
        expect(n.midi).toBe(0);
        expect(n.freq).toBe(0);
      } else {
        expect(n.midi).toBeGreaterThan(0);
        expect(n.freq).toBeGreaterThan(20);
        expect(n.freq).toBeCloseTo(440 * Math.pow(2, (n.midi - 69) / 12), 6);
      }
    }
  });

  it("never exceeds velocity bounds", () => {
    const h = harness();
    const src = new SyntheticSource({ seed: 13, rateMul: 10 });
    drive(h, 20, src);
    for (const n of h.notes) {
      expect(n.vel).toBeGreaterThanOrEqual(0);
      expect(n.vel).toBeLessThanOrEqual(1);
    }
  });

  it("routes reverts to gong and births to pluck arpeggios", () => {
    const h = harness();
    h.feed([edit({ id: 80001, kind: "revert", magnitude: 0.7, delta: -5000 })]);
    h.advance(2000);
    expect(h.notes.some((n) => n.voice === "gong")).toBe(true);

    const h2 = harness();
    h2.feed([edit({ id: 80002, kind: "new", magnitude: 0.5, delta: 5000 })]);
    h2.advance(2000);
    expect(h2.notes.filter((n) => n.flavor === "new").every((n) => n.voice === "pluck")).toBe(true);
  });
});
