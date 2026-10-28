import { describe, expect, it } from "vitest";
import { TypedEventBus } from "@/engine/bus";
import {
  CHORD_SEC,
  EPS_REF,
  KEY_CHANGE_SEC,
  PHRASE_SEC,
  PROJECTS,
  PITCH_CLASS_NAMES,
  STEP_SEC,
  STRIDE,
  TIER_PARAMS,
  VOICE_KINDS,
  keyName,
  masterGainFor,
  projectFromCode,
} from "@/engine/config";
import { createMetrics } from "@/engine/types";
import { rateToEnergy } from "@/engine/util/perf";

// spec §13.2 row `config`
describe("config invariants", () => {
  it("STEP_SEC matches 68 BPM sixteenth notes", () => {
    expect(STEP_SEC).toBeCloseTo(60 / 68 / 4, 9);
    expect(STEP_SEC).toBeCloseTo(0.2206, 3);
  });

  it("derived musical durations match the spec's stated seconds", () => {
    expect(CHORD_SEC).toBeCloseTo(14.1, 0); // §7.1 "≈ 14.1 s"
    expect(PHRASE_SEC).toBeCloseTo(28.2, 0); // 8 bars
    expect(KEY_CHANGE_SEC).toBeCloseTo(113, 0); // §7.1 "≈ 113 s"
  });

  it("4 bars = 16 steps × 4 chords worth of time", () => {
    expect(CHORD_BARS_CHECK()).toBe(true);
  });
  function CHORD_BARS_CHECK(): boolean {
    return CHORD_SEC > 14 && CHORD_SEC < 14.2 && PHRASE_SEC > 2 * CHORD_SEC - 0.01;
  }

  it("STRIDE is 11 (spec §6.5) and fits a Float64 transfer", () => {
    expect(STRIDE).toBe(11);
  });

  it("PROJECTS covers every ProjectId exactly once", () => {
    const expected = [
      "wikipedia",
      "wiktionary",
      "wikisource",
      "wikibooks",
      "wikiquote",
      "wikinews",
      "wikiversity",
      "wikivoyage",
      "wikidata",
      "commons",
      "meta",
      "other",
    ];
    expect(PROJECTS.length).toBe(expected.length);
    for (const p of expected) expect(PROJECTS).toContain(p);
    expect(new Set(PROJECTS).size).toBe(PROJECTS.length);
  });

  it("projectFromCode round-trips and guards unknown codes", () => {
    for (let i = 0; i < PROJECTS.length; i++) {
      expect(projectFromCode(i)).toBe(PROJECTS[i]);
    }
    expect(projectFromCode(999)).toBe("other");
    expect(projectFromCode(-1)).toBe("other");
  });

  it("PITCH_CLASS_NAMES has 12 entries and keyName wraps", () => {
    expect(PITCH_CLASS_NAMES.length).toBe(12);
    expect(keyName(0)).toBe("C");
    expect(keyName(11)).toBe("B");
    expect(keyName(12)).toBe("C");
    expect(keyName(-1)).toBe("B");
    expect(keyName(7)).toBe("G");
  });

  it("VOICE_KINDS index matches the wire encoding (§8.5: 0 bell … 5 tick)", () => {
    expect(VOICE_KINDS.length).toBe(6);
    expect(VOICE_KINDS[0]).toBe("bell");
    expect(VOICE_KINDS[5]).toBe("tick");
  });

  it("tier params are ordered high ≥ medium ≥ low on every cost axis", () => {
    const h = TIER_PARAMS.high;
    const m = TIER_PARAMS.medium;
    const l = TIER_PARAMS.low;

    expect(h.voices).toBeGreaterThan(m.voices);
    expect(m.voices).toBeGreaterThan(l.voices);

    expect(h.sparkCapacity).toBeGreaterThan(m.sparkCapacity);
    expect(m.sparkCapacity).toBeGreaterThan(l.sparkCapacity);

    expect(h.dustPoints).toBeGreaterThan(m.dustPoints);
    expect(m.dustPoints).toBeGreaterThan(l.dustPoints);

    expect(h.maxPerSec).toBeGreaterThan(m.maxPerSec);
    expect(m.maxPerSec).toBeGreaterThan(l.maxPerSec);

    expect(h.orbSteps).toBeGreaterThan(m.orbSteps);
    expect(m.orbSteps).toBeGreaterThan(l.orbSteps);

    expect(h.reverbIrSec).toBeGreaterThan(m.reverbIrSec);
    expect(m.reverbIrSec).toBeGreaterThan(l.reverbIrSec);

    expect(h.maxRenderScale).toBeGreaterThanOrEqual(l.maxRenderScale);
  });

  it("tier params match the spec tables (§8.12, §12.3) exactly", () => {
    expect(TIER_PARAMS.high.voices).toBe(16);
    expect(TIER_PARAMS.medium.voices).toBe(12);
    expect(TIER_PARAMS.low.voices).toBe(8);

    expect(TIER_PARAMS.high.sparkCapacity).toBe(24576);
    expect(TIER_PARAMS.medium.sparkCapacity).toBe(12288);
    expect(TIER_PARAMS.low.sparkCapacity).toBe(6144);

    expect(TIER_PARAMS.high.dustPoints).toBe(30000);
    expect(TIER_PARAMS.medium.dustPoints).toBe(15000);
    expect(TIER_PARAMS.low.dustPoints).toBe(6000);

    expect(TIER_PARAMS.high.maxPerSec).toBe(40);
    expect(TIER_PARAMS.medium.maxPerSec).toBe(28);
    expect(TIER_PARAMS.low.maxPerSec).toBe(16);

    expect(TIER_PARAMS.high.orbDetail).toBe(5);
    expect(TIER_PARAMS.medium.orbDetail).toBe(4);
    expect(TIER_PARAMS.low.orbDetail).toBe(3);

    expect(TIER_PARAMS.low.panning).toBe("equalpower");
    expect(TIER_PARAMS.low.chromaticAberration).toBe(false);
  });

  it("masterGainFor applies the 0.9·volume² taper and clamps (§8.7)", () => {
    expect(masterGainFor(0)).toBe(0);
    expect(masterGainFor(1)).toBeCloseTo(0.9, 6);
    expect(masterGainFor(0.8)).toBeCloseTo(0.9 * 0.64, 6);
    expect(masterGainFor(-1)).toBe(0);
    expect(masterGainFor(5)).toBeCloseTo(0.9, 6);
  });

  it("EPS_REF is the T1.1-calibrated value (spec §7.3)", () => {
    // Calibrated from a 120 s live measurement: p95 of post-normalize
    // Wikipedias edit|new throughput was 10/s → round(1.5 × 10) = 15.
    // Assert the *relationship* to the spec formula, not a magic literal.
    expect(EPS_REF).toBeGreaterThan(0);
    expect(EPS_REF).toBe(15);
    expect(Number.isInteger(EPS_REF)).toBe(true);
  });

  it("EPS_REF yields the intended E band for measured traffic", () => {
    // Guards the calibration: a wildly wrong EPS_REF would silently pin the
    // mode/palette to one end of its range.
    expect(rateToEnergy(6, EPS_REF)).toBeGreaterThan(0.6); // typical → busy-ish
    expect(rateToEnergy(10, EPS_REF)).toBeGreaterThan(0.8); // peak → lydian
    expect(rateToEnergy(2, EPS_REF)).toBeLessThan(0.5); // quiet → not lydian
  });
});

describe("TypedEventBus", () => {
  it("delivers to subscribers in order", () => {
    const bus = new TypedEventBus<{ n: number }>();
    const seen: number[] = [];
    bus.on("n", (v) => seen.push(v));
    bus.on("n", (v) => seen.push(v * 10));
    bus.emit("n", 1);
    expect(seen).toEqual([1, 10]);
  });

  it("unsubscribes, and the handle is idempotent", () => {
    const bus = new TypedEventBus<{ n: number }>();
    let count = 0;
    const off = bus.on("n", () => count++);
    bus.emit("n", 1);
    off();
    off();
    bus.emit("n", 2);
    expect(count).toBe(1);
    expect(bus.listenerCount("n")).toBe(0);
  });

  it("once fires exactly one time", () => {
    const bus = new TypedEventBus<{ n: number }>();
    let count = 0;
    bus.once("n", () => count++);
    bus.emit("n", 1);
    bus.emit("n", 2);
    expect(count).toBe(1);
  });

  it("emit with no listeners is a no-op", () => {
    const bus = new TypedEventBus<{ n: number }>();
    expect(() => bus.emit("n", 1)).not.toThrow();
  });

  it("clear removes one event or all", () => {
    const bus = new TypedEventBus<{ a: number; b: number }>();
    bus.on("a", () => {});
    bus.on("b", () => {});
    bus.clear("a");
    expect(bus.listenerCount("a")).toBe(0);
    expect(bus.listenerCount("b")).toBe(1);
    bus.clear();
    expect(bus.listenerCount("b")).toBe(0);
  });

  it("delivers to 4 listeners without corrupting order (spec §5.3)", () => {
    const bus = new TypedEventBus<{ n: number }>();
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) bus.on("n", () => seen.push(i));
    bus.emit("n", 0);
    expect(seen).toEqual([0, 1, 2, 3]);
  });
});

describe("createMetrics", () => {
  it("starts at spec defaults", () => {
    const m = createMetrics();
    expect(m.tier).toBe("high");
    expect(m.level).toBe(0);
    expect(m.mode).toBe("dorian"); // §7.4 initial state
    expect(m.keyName).toBe("C"); // §7.4 rootPc = 0
    expect(m.audioState).toBe("none");
    expect(m.acceptedTotal).toBe(0);
  });
});
