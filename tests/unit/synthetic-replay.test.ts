import { describe, expect, it } from "vitest";
import { SyntheticSource, SYNTH_TITLES } from "@/engine/ingest/synthetic";
import { ReplaySource } from "@/engine/ingest/replay";
import { DedupeRing } from "@/engine/ingest/filters";
import { mulberry32 } from "@/engine/util/random";
import { SYNTH_LANGS, REPLAY_MAX_BYTES } from "@/engine/config";
import type { NormalizedEdit } from "@/engine/types";

// spec §13.2 row `synthetic / replay`
describe("SyntheticSource — determinism", () => {
  it("is byte-identical for the same seed", () => {
    const a = new SyntheticSource({ seed: 42 });
    const b = new SyntheticSource({ seed: 42 });
    for (let t = 0; t < 5000; t += 50) {
      const ea = a.next(50);
      const eb = b.next(50);
      expect(JSON.stringify(ea)).toBe(JSON.stringify(eb));
    }
  });

  it("differs for different seeds", () => {
    const a = new SyntheticSource({ seed: 1 });
    const b = new SyntheticSource({ seed: 2 });
    const ja = JSON.stringify(a.next(2000));
    const jb = JSON.stringify(b.next(2000));
    expect(ja).not.toBe(jb);
  });

  it("is stable across interleaved step sizes for the same seed", () => {
    // Same seed, different tick granularity → the aggregate stream should be
    // near-identical in character (exact equality is not required because the
    // Poisson accumulator lands on different step boundaries).
    const a = new SyntheticSource({ seed: 7 });
    const b = new SyntheticSource({ seed: 7 });
    const ea: NormalizedEdit[] = [];
    const eb: NormalizedEdit[] = [];
    for (let t = 0; t < 20000; t += 50) ea.push(...a.next(50));
    for (let t = 0; t < 20000; t += 200) eb.push(...b.next(200));
    const rateA = ea.length / 20;
    const rateB = eb.length / 20;
    expect(Math.abs(rateA - rateB) / Math.max(rateA, rateB)).toBeLessThan(0.15);
  });
});

describe("SyntheticSource — model shape (spec §6.7)", () => {
  function sample(seed: number, seconds: number, rateMul = 1): NormalizedEdit[] {
    const s = new SyntheticSource({ seed, rateMul });
    const all: NormalizedEdit[] = [];
    for (let t = 0; t < seconds * 1000; t += 50) all.push(...s.next(50));
    return all;
  }

  it("produces a plausible arrival rate", () => {
    const edits = sample(11, 300);
    const eps = edits.length / 300;
    expect(eps).toBeGreaterThan(5);
    expect(eps).toBeLessThan(60);
  });

  it("honours rateMul", () => {
    const eps1 = sample(11, 120, 1).length / 120;
    const eps3 = sample(11, 120, 3).length / 120;
    expect(eps3 / eps1).toBeGreaterThan(2.4);
    expect(eps3 / eps1).toBeLessThan(3.6);
  });

  it("matches the actor mix (20 % bot, 22 % anon ± 3) over 20 000 events", () => {
    const all = sample(99, 300, 5);
    expect(all.length).toBeGreaterThanOrEqual(20000);
    const edits = all.slice(0, 20000);
    let bot = 0;
    let anon = 0;
    for (const e of edits) {
      if (e.actor === "bot") bot++;
      else if (e.actor === "anon") anon++;
    }
    const n = edits.length;
    expect(bot / n).toBeCloseTo(0.2, 1);
    expect(anon / n).toBeCloseTo(0.22, 1);
    expect(Math.abs(bot / n - 0.2)).toBeLessThan(0.03);
    expect(Math.abs(anon / n - 0.22)).toBeLessThan(0.03);
  });

  it("matches the kind mix (3 % revert, 3 % new ± 1) over 20 000 events", () => {
    const all = sample(99, 300, 5);
    expect(all.length).toBeGreaterThanOrEqual(20000);
    const edits = all.slice(0, 20000);
    let reverts = 0;
    let news = 0;
    for (const e of edits) {
      if (e.kind === "revert") reverts++;
      else if (e.kind === "new") news++;
    }
    const n = edits.length;
    expect(Math.abs(reverts / n - 0.03)).toBeLessThan(0.01);
    expect(Math.abs(news / n - 0.03)).toBeLessThan(0.01);
  });

  it("is mostly positive with negative-biased reverts", () => {
    const edits = sample(5, 120);
    let pos = 0;
    let total = 0;
    let revertPos = 0;
    let revertTotal = 0;
    for (const e of edits) {
      if (e.kind === "revert") {
        revertTotal++;
        if (e.delta > 0) revertPos++;
      } else {
        total++;
        if (e.delta > 0) pos++;
      }
    }
    expect(pos / total).toBeGreaterThan(0.55);
    expect(pos / total).toBeLessThan(0.7);
    // Reverts should be mostly negative (70 %).
    expect(revertPos / revertTotal).toBeLessThan(0.4);
  });

  it("clamps |delta| into the spec range", () => {
    const edits = sample(3, 120);
    for (const e of edits) {
      expect(e.absDelta).toBeGreaterThanOrEqual(1);
      expect(e.absDelta).toBeLessThanOrEqual(60000);
      expect(e.magnitude).toBeGreaterThanOrEqual(0);
      expect(e.magnitude).toBeLessThanOrEqual(1);
      expect(e.importance).toBeGreaterThanOrEqual(0);
      expect(e.importance).toBeLessThanOrEqual(1);
    }
  });

  it("only emits languages from the spec list", () => {
    const edits = sample(8, 60);
    const allowed = new Set<string>(SYNTH_LANGS);
    for (const e of edits) expect(allowed.has(e.lang)).toBe(true);
  });

  it("follows a Zipf distribution over languages (en most common)", () => {
    const edits = sample(13, 300, 4);
    const counts = new Map<string, number>();
    for (const e of edits) counts.set(e.lang, (counts.get(e.lang) ?? 0) + 1);
    // en is rank 0 in SYNTH_LANGS and must be the most common.
    let best = "";
    let bestN = -1;
    for (const [lang, n] of counts) {
      if (n > bestN) {
        bestN = n;
        best = lang;
      }
    }
    expect(best).toBe("en");
    // Rank 1 (de) should beat rank 5 (ru).
    expect(counts.get("de") ?? 0).toBeGreaterThan(counts.get("ru") ?? 0);
  });

  it("always produces titles from the built-in pool with spaces", () => {
    const edits = sample(17, 30);
    for (const e of edits) {
      expect(e.title).not.toContain("_");
      expect(e.title.length).toBeGreaterThan(0);
    }
    expect(SYNTH_TITLES.length).toBeGreaterThan(100);
  });

  it("gives every event a unique, increasing id", () => {
    const edits = sample(23, 30);
    for (let i = 1; i < edits.length; i++) {
      expect(edits[i]!.id).toBeGreaterThan(edits[i - 1]!.id);
    }
  });

  it("never emits NaN or negative timestamps", () => {
    const edits = sample(29, 30);
    for (const e of edits) {
      expect(Number.isFinite(e.ts)).toBe(true);
      expect(e.ts).toBeGreaterThan(0);
      expect(Number.isFinite(e.revNew)).toBe(true);
    }
  });

  it("returns nothing for a non-positive dt", () => {
    const s = new SyntheticSource({ seed: 1 });
    expect(s.next(0)).toEqual([]);
    expect(s.next(-100)).toEqual([]);
  });

  it("carries no username (spec §14.2)", () => {
    const edits = sample(31, 10);
    for (const e of edits) {
      expect(e).not.toHaveProperty("user");
      expect(JSON.stringify(e)).not.toContain("192.0.2");
    }
  });
});

describe("ReplaySource — spec §6.7", () => {
  const mkLines = (): string => {
    const base: NormalizedEdit = {
      id: 0,
      ts: 0,
      wiki: "enwiki",
      host: "en.wikipedia.org",
      lang: "en",
      project: "wikipedia",
      ns: 0,
      title: "Replay Test",
      actor: "registered",
      kind: "edit",
      minor: false,
      delta: 10,
      absDelta: 10,
      magnitude: 0.3,
      importance: 0.4,
      revNew: 1,
    };
    const { id: _i, ts: _t, ...rest } = base;
    void _i;
    void _t;
    return [
      JSON.stringify({ dt: 50, e: rest }),
      JSON.stringify({ dt: 100, e: rest }),
      JSON.stringify({ dt: 0, e: rest }),
    ].join("\n");
  };

  it("parses NDJSON and skips blank/corrupt lines without throwing", () => {
    const text = `${mkLines()}\n\nnot json\n{"dt":"x"}\n`;
    const r = ReplaySource.fromText(text);
    expect(r.length).toBe(3);
  });

  it("emits events as time advances", () => {
    const r = ReplaySource.fromText(mkLines());
    expect(r.next(50)).toHaveLength(1);
    expect(r.next(100)).toHaveLength(1);
    expect(r.next(10)).toHaveLength(1); // dt:0 line emits immediately
  });

  it("holds a line back until its dt gap has elapsed", () => {
    const r = ReplaySource.fromText(mkLines());
    expect(r.next(20)).toHaveLength(0);
    expect(r.next(40)).toHaveLength(1);
  });

  it("assigns strictly increasing ids across loops, so dedupe cannot suppress it", () => {
    const r = ReplaySource.fromText(mkLines());
    const seen: number[] = [];
    for (let i = 0; i < 20; i++) {
      for (const e of r.next(200)) seen.push(e.id);
    }
    expect(seen.length).toBeGreaterThanOrEqual(10);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]!).toBeGreaterThan(seen[i - 1]!);
    }
    // No duplicates — the whole point of re-issuing ids.
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("survives the ingest dedupe ring over multiple laps", () => {
    const r = ReplaySource.fromText(mkLines());
    const d = new DedupeRing(2000);
    const kept: number[] = [];
    for (let i = 0; i < 30; i++) {
      for (const e of r.next(200)) {
        if (!d.seenOrAdd(e.id)) kept.push(e.id);
      }
    }
    // Every emitted event must survive dedupe.
    expect(kept.length).toBeGreaterThanOrEqual(10);
    expect(new Set(kept).size).toBe(kept.length);
  });

  it("preserves the edit fields through the round-trip", () => {
    const r = ReplaySource.fromText(mkLines());
    const e = r.next(50)[0]!;
    expect(e.title).toBe("Replay Test");
    expect(e.host).toBe("en.wikipedia.org");
    expect(e.lang).toBe("en");
    expect(e.project).toBe("wikipedia");
    expect(e.id).toBeGreaterThan(0);
    expect(e.ts).toBeGreaterThan(0);
  });

  it("handles an empty recording without hanging", () => {
    const r = ReplaySource.fromText("");
    expect(r.length).toBe(0);
    expect(r.next(1000)).toEqual([]);
  });

  it("is deterministic for identical text", () => {
    const a = ReplaySource.fromText(mkLines());
    const b = ReplaySource.fromText(mkLines());
    for (let i = 0; i < 10; i++) {
      expect(JSON.stringify(a.next(200))).toBe(JSON.stringify(b.next(200)));
    }
  });
});

describe("replay budget", () => {
  it("the spec budget is 300 KB (asserted so a regression is noticed)", () => {
    expect(REPLAY_MAX_BYTES).toBe(300 * 1024);
  });

  it("mulberry32 is available for seeded generator scripts", () => {
    const r = mulberry32(1);
    expect(r()).toBeGreaterThanOrEqual(0);
  });
});
