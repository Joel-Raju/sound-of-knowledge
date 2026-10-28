import { describe, expect, it } from "vitest";
import { VoiceAllocator, capOf, priorityOf } from "@/engine/audio/allocator";
import { makeSoftClipCurve } from "@/engine/audio/audio-engine";
import { buildVoiceParams, kindOf, type VoiceKind } from "@/engine/audio/voice-params";
import {
  GONG_MAX_CONCURRENT,
  KIND_PRIORITY_BONUS,
  SUB_MAX_CONCURRENT,
  TIER_PARAMS,
} from "@/engine/config";
import type { NoteEvent } from "@/engine/types";

// spec §13.2 row `allocator`
const BELL = 0;
const PLUCK = 1;
const SUB = 2;
const GONG = 3;
const THUD = 4;
const TICK = 5;

describe("priorityOf — spec §8.5", () => {
  it("matches importance plus the per-kind bonus", () => {
    expect(priorityOf(GONG, 0.5)).toBeCloseTo(0.5 + KIND_PRIORITY_BONUS.gong, 9);
    expect(priorityOf(SUB, 0.5)).toBeCloseTo(0.5 + KIND_PRIORITY_BONUS.sub, 9);
    expect(priorityOf(BELL, 0.5)).toBeCloseTo(0.5 + KIND_PRIORITY_BONUS.bell, 9);
    expect(priorityOf(PLUCK, 0.5)).toBeCloseTo(0.5 + KIND_PRIORITY_BONUS.pluck, 9);
    expect(priorityOf(THUD, 0.5)).toBeCloseTo(0.5 + KIND_PRIORITY_BONUS.thud, 9);
    expect(priorityOf(TICK, 0.5)).toBeCloseTo(0.5 + KIND_PRIORITY_BONUS.tick, 9);
  });

  it("ranks a rare dramatic event above a stream of ordinary ones", () => {
    // A low-importance revert must still outrank a slightly more important
    // small addition — that is the whole point of the bonus (§8.5).
    expect(priorityOf(GONG, 0.2)).toBeGreaterThan(priorityOf(BELL, 0.35));
    expect(priorityOf(SUB, 0.2)).toBeGreaterThan(priorityOf(PLUCK, 0.35));
    // But an ordinary note with much higher importance still wins.
    expect(priorityOf(GONG, 0.2)).toBeLessThan(priorityOf(BELL, 0.95));
  });
});

describe("VoiceAllocator — caps", () => {
  it("capOf matches the config table", () => {
    expect(capOf(GONG)).toBe(GONG_MAX_CONCURRENT);
    expect(capOf(GONG)).toBe(2);
    expect(capOf(SUB)).toBe(SUB_MAX_CONCURRENT);
    // §7.7 specifies 3. T3.5 raised it to 5 because §8.4 needs 8–30 % of the
    // mix's power below 80 Hz and the `sub` voice is the only *musical* source
    // of that band — see `DECISIONS.md` (T3.5).
    expect(SUB_MAX_CONCURRENT).toBe(5);
    // Everything else is uncapped.
    expect(capOf(BELL)).toBe(Number.POSITIVE_INFINITY);
    expect(capOf(PLUCK)).toBe(Number.POSITIVE_INFINITY);
    expect(capOf(THUD)).toBe(Number.POSITIVE_INFINITY);
    expect(capOf(TICK)).toBe(Number.POSITIVE_INFINITY);
  });

  it("allows at most 2 concurrent gongs", () => {
    const a = new VoiceAllocator(16);
    expect(a.allocate(GONG, 0, 9, 0.9)).toBeGreaterThanOrEqual(0);
    expect(a.allocate(GONG, 0.1, 9, 0.9)).toBeGreaterThanOrEqual(0);
    // Third concurrent gong must be refused, even with 13 free slots.
    expect(a.allocate(GONG, 0.2, 9, 0.9)).toBe(-1);
  });

  it("allows a gong again once an earlier one has ended", () => {
    const a = new VoiceAllocator(16);
    a.allocate(GONG, 0, 9, 0.9);
    a.allocate(GONG, 0.1, 9, 0.9);
    expect(a.allocate(GONG, 0.2, 9, 0.9)).toBe(-1);
    // At t = 9.5 both have ended.
    expect(a.allocate(GONG, 9.5, 9, 0.9)).toBeGreaterThanOrEqual(0);
  });

  it("allows at most SUB_MAX_CONCURRENT concurrent subs", () => {
    const a = new VoiceAllocator(16);
    for (let i = 0; i < SUB_MAX_CONCURRENT; i++) {
      expect(a.allocate(SUB, i * 0.01, 4, 0.8)).toBeGreaterThanOrEqual(0);
    }
    // All caps reached: even a very important sub cannot displace one.
    expect(a.allocate(SUB, 0.5, 4, 1)).toBe(-1);
  });

  it("does not cap bells, plucks, thuds or ticks", () => {
    for (const kind of [BELL, PLUCK, THUD, TICK] as const) {
      const a = new VoiceAllocator(8);
      for (let i = 0; i < 8; i++) {
        expect(a.allocate(kind, 0, 4, 0.5), `kind ${kind} #${i}`).toBeGreaterThanOrEqual(0);
      }
      expect(a.allocate(kind, 0, 4, 0.5)).toBe(-1);
    }
  });

  it("caps count only notes that are still sounding at `when`", () => {
    const a = new VoiceAllocator(16);
    a.allocate(GONG, 0, 2, 0.9);
    a.allocate(GONG, 0.1, 2, 0.9);
    // A gong scheduled for t=5 does not count toward the cap at t=0.
    expect(a.allocate(GONG, 5, 2, 0.9)).toBeGreaterThanOrEqual(0);
  });
});

describe("VoiceAllocator — slot reuse and stealing", () => {
  it("uses the first free slot", () => {
    const a = new VoiceAllocator(4);
    expect(a.allocate(BELL, 0, 1, 0.5)).toBe(0);
    expect(a.allocate(BELL, 0, 1, 0.5)).toBe(1);
    expect(a.allocate(BELL, 0, 1, 0.5)).toBe(2);
    // All busy at t=0, but free at t=2.
    expect(a.allocate(BELL, 2, 1, 0.5)).toBe(0);
  });

  it("reports lastWasStolen correctly", () => {
    const a = new VoiceAllocator(2);
    a.allocate(BELL, 0, 10, 0.5);
    expect(a.lastWasStolen).toBe(false);
    a.allocate(BELL, 1, 10, 0.5);
    expect(a.lastWasStolen).toBe(false);
    // Both busy; a much more important note must steal.
    const slot = a.allocate(GONG, 2, 9, 0.95);
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(a.lastWasStolen).toBe(true);
  });

  it("steals only a strictly lower priority", () => {
    const a = new VoiceAllocator(2);
    a.allocate(BELL, 0, 10, 0.8);
    a.allocate(BELL, 0, 10, 0.8);
    // Equal priority: no steal.
    expect(a.allocate(BELL, 1, 10, 0.8)).toBe(-1);
    // Lower priority: no steal.
    expect(a.allocate(BELL, 1, 10, 0.5)).toBe(-1);
    // Higher priority: steal.
    expect(a.allocate(BELL, 1, 10, 0.81)).toBeGreaterThanOrEqual(0);
  });

  it("returns -1 when nothing can be stolen", () => {
    const a = new VoiceAllocator(2);
    for (let i = 0; i < 2; i++) a.allocate(GONG, 0, 9, 1);
    expect(a.allocate(GONG, 0.1, 9, 0.1)).toBe(-1);
  });

  it("steals the *lowest* priority slot, not the first", () => {
    const a = new VoiceAllocator(3);
    a.allocate(BELL, 0, 10, 0.9); // slot 0 — high
    a.allocate(BELL, 0, 10, 0.2); // slot 1 — low
    a.allocate(BELL, 0, 10, 0.5); // slot 2 — mid
    const slot = a.allocate(BELL, 1, 10, 0.95);
    expect(slot).toBe(1); // the weakest, not slot 0
  });

  it("a stolen gong is replaced by the higher-priority note", () => {
    const a = new VoiceAllocator(2);
    a.allocate(BELL, 0, 5, 0.3);
    a.allocate(BELL, 0, 5, 0.3);
    const slot = a.allocate(GONG, 1, 9, 0.5);
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(a.getSlot(slot)!.kind).toBe(GONG);
  });
});

describe("VoiceAllocator — housekeeping", () => {
  it("activeAt counts only sounding slots", () => {
    const a = new VoiceAllocator(8);
    expect(a.activeAt(0)).toBe(0);
    a.allocate(BELL, 0, 5, 0.5);
    a.allocate(BELL, 0, 5, 0.5);
    expect(a.activeAt(1)).toBe(2);
    expect(a.activeAt(6)).toBe(0);
  });

  it("reset frees everything", () => {
    const a = new VoiceAllocator(2);
    a.allocate(BELL, 0, 10, 0.5);
    a.allocate(BELL, 0, 10, 0.5);
    a.reset();
    expect(a.activeAt(1)).toBe(0);
    expect(a.allocate(BELL, 1, 10, 0.5)).toBeGreaterThanOrEqual(0);
  });

  it("rejects a non-positive size", () => {
    expect(() => new VoiceAllocator(0)).toThrow(RangeError);
    expect(() => new VoiceAllocator(-2)).toThrow(RangeError);
  });

  it("handles the tier voice budgets from §8.12", () => {
    for (const tier of ["high", "medium", "low"] as const) {
      const n = TIER_PARAMS[tier].voices;
      const a = new VoiceAllocator(n);
      expect(a.size).toBe(n);
      // Fill it completely with uncapped notes.
      for (let i = 0; i < n; i++) expect(a.allocate(BELL, 0, 5, 0.5)).toBe(i);
      expect(a.allocate(BELL, 0, 5, 0.5)).toBe(-1);
    }
  });
});

describe("voice kinds — spec §8.5 wire encoding", () => {
  const note = (voice: NoteEvent["voice"]): NoteEvent => ({
    when: 0,
    voice,
    midi: voice === "bell" ? 84 : 72,
    freq: 440,
    vel: 0.7,
    dir: { x: 0, y: 0, z: 1 },
    radius: 9,
    flavor: "add",
    visual: true,
    edit: {
      id: 3,
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
      delta: 10,
      absDelta: 10,
      magnitude: 0.3,
      importance: 0.4,
      revNew: 1,
    },
  });

  it("maps voices to 0..5 in the spec's order", () => {
    expect(kindOf("bell")).toBe(0);
    expect(kindOf("pluck")).toBe(1);
    expect(kindOf("sub")).toBe(2);
    expect(kindOf("gong")).toBe(3);
    expect(kindOf("thud")).toBe(4);
    expect(kindOf("tick")).toBe(5);
  });

  it("buildVoiceParams always yields a kind that round-trips through the caps", () => {
    for (const v of ["bell", "pluck", "sub", "gong", "thud", "tick"] as const) {
      const vp = buildVoiceParams(note(v));
      const k = vp.kind as VoiceKind;
      expect(capOf(k)).toBe(capOf(kindOf(v)));
      expect(vp.dur).toBeGreaterThan(0);
    }
  });
});

describe("soft clip curve — spec §8.7", () => {
  it("is tanh(1.2x)/tanh(1.2) sampled at the requested resolution", () => {
    const curve = makeSoftClipCurve(2048, 1.2);
    expect(curve.length).toBe(2048);
    const norm = Math.tanh(1.2);
    for (const i of [0, 100, 512, 1024, 2000, 2047]) {
      const x = (i / 2047) * 2 - 1;
      expect(curve[i]!).toBeCloseTo(Math.tanh(1.2 * x) / norm, 5);
    }
  });

  it("is monotonic, odd, and bounded to [-1,1]", () => {
    // Odd length so that one sample lands exactly on x = 0; with an even length
    // the midpoint falls between samples and the oddness check is untestable.
    const curve = makeSoftClipCurve(1025, 1.2);
    for (let i = 1; i < curve.length; i++) expect(curve[i]!).toBeGreaterThanOrEqual(curve[i - 1]!);
    for (const v of curve) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
    const mid = (curve.length - 1) / 2;
    expect(curve[mid]!).toBeCloseTo(0, 6);
    // Odd symmetry: the curve is a saturating odd function.
    for (let i = 0; i < curve.length; i++) {
      expect(curve[i]! + curve[curve.length - 1 - i]!).toBeCloseTo(0, 6);
    }
  });
});
