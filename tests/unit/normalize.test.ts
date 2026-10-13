import { describe, expect, it } from "vitest";
import fixtures from "../fixtures/recentchange-samples.json";
import {
  classifyActor,
  importanceOf,
  isRevert,
  magnitudeOf,
  normalize,
  normalizeTitle,
  parseHost,
  wikiFromLang,
} from "@/engine/ingest/normalize";
import { encodeBatch, decodeBatch, STRIDE } from "@/engine/ingest/encode";
import { DedupeRing, passes, DEFAULT_FILTERS, FilterConfig } from "@/engine/ingest/filters";
import { DEDUPE_CAPACITY, REVERT_PATTERNS } from "@/engine/config";
import { mulberry32 } from "@/engine/util/random";
import type { NormalizedEdit } from "@/engine/types";

const raw = (k: string): unknown => (fixtures as Record<string, unknown>)[k];

// spec §13.2 row `normalize`
describe("normalize — fixtures", () => {
  it("normalises a normal edit", () => {
    const e = normalize(raw("normalEdit"))!;
    expect(e).not.toBeNull();
    expect(e.id).toBe(1790000001);
    expect(e.project).toBe("wikipedia");
    expect(e.lang).toBe("en");
    expect(e.wiki).toBe("enwiki");
    expect(e.host).toBe("en.wikipedia.org");
    expect(e.ns).toBe(0);
    expect(e.title).toBe("Albert Einstein");
    expect(e.actor).toBe("registered");
    expect(e.kind).toBe("edit");
    expect(e.minor).toBe(true);
    expect(e.delta).toBe(67); // 10301 - 10234
    expect(e.absDelta).toBe(67);
    expect(e.ts).toBe(1790000000 * 1000);
    expect(e.revNew).toBe(112);
  });

  it("treats a `new` event as kind 'new' with missing length.old = 0", () => {
    const e = normalize(raw("newPage"))!;
    expect(e.kind).toBe("new");
    expect(e.delta).toBe(8421); // old defaults to 0
    expect(e.absDelta).toBe(8421);
    // log2(8422)/14 = 0.931 — large, but not yet saturated.
    expect(e.magnitude).toBeCloseTo(0.9314, 3);
    // 0.15 + 0.6*0.9314 + 0.35 (new) + 0.10 (ns 0) = 1.159 → clamped to 1
    expect(e.importance).toBe(1);
  });

  it("classifies a bot", () => {
    expect(normalize(raw("botEdit"))!.actor).toBe("bot");
  });

  it("classifies IPv4, IPv6 and temporary accounts as anon", () => {
    expect(normalize(raw("anonIpv4"))!.actor).toBe("anon");
    expect(normalize(raw("anonIpv6"))!.actor).toBe("anon");
    expect(normalize(raw("tempAccount"))!.actor).toBe("anon");
  });

  it("detects reverts in English and German", () => {
    expect(normalize(raw("revertEnglish"))!.kind).toBe("revert");
    expect(normalize(raw("revertGerman"))!.kind).toBe("revert");
  });

  describe("revert patterns from the 20-minute live capture", () => {
    /**
     * Every case below is a **verbatim summary** observed in `probe-reverts.ts`'s
     * 1 200 s capture (6 428 edits, 2 659 distinct summaries), recorded in
     * `DECISIONS.md`. A pattern written from imagination rather than from a real
     * summary is a guess about what Wikipedia editors type.
     *
     * The negatives are as load-bearing as the positives: two of the eighteen
     * candidates were summaries *about* reverts that were not themselves reverts,
     * and they are why nothing here un-anchors an existing stem.
     */
    const matches = (summary: string): boolean =>
      REVERT_PATTERNS.some((p) => p.test(summary));

    it.each([
      [
        "Reverting edit(s) by [[Special:Contributions/~2026-54976-92|~2026-54976-92]]",
        "the present participle, ×3 in the sample",
      ],
      [
        "Reverting possible vandalism by [[Special:Contribs/~2026-54890-71|~2026-54890-71]] to version by [[User:X|X]]",
        "the other participle form",
      ],
      [
        // An ordinary human summary, not a bot announcement. This one used to sit in
        // the negative list as an anchoring example; the capture showed the present
        // participle is the commonest revert phrasing there is, so it belongs here.
        "reverting to the previous version of the intro",
        "an ordinary human revert",
      ],
      [
        "Bot: Undo 1379821109, [[:File:Park Jinyoung at 2026 Baeksang Art Awards, May 8, 2026 01.jpg]] de",
        "a bot's own undo summary",
      ],
      ["S-revert:2-0.2.09", "Snatch's revert bot"],
      ["rv, [[WP:NOTFORUM|Wikipedia is not a forum]]", "the editor shorthand, with a comma"],
      ["Rv. fringe view.", "the editor shorthand, with a full stop"],
      [
        'partial revert seemingly bold edits. "that\'s what [[Special:WhatLinksHere]] is for"',
        "a deliberate partial revert",
      ],
      [
        "Undid 2 revisions from [[Special:Diff/8805681|8805681]] until [[Special:Diff/8807674|8807674]]",
        "the plural the spec's pattern never matched",
      ],
      [
        "[[WP:LRC|LiveRC]] : Annullate le modifiche di [[Special:Contributions/Huhjhk|Huhjhk]]",
        "Italian plural behind a bot signature",
      ],
    ])("matches %s", (summary) => {
      expect(matches(summary)).toBe(true);
    });

    it.each([
      ["/* Clarification Regarding Reverted Edits to the Hastinapur Article */ Reply", "talks about reverts; is not one"],
      ["/* Clarification Regarding Reverted Edits to the Hastinapur Article */", "the same, without the reply tag"],
      ["RV sales up 4% in Q3", "starts with the two letters, is not a revert"],
      ["The undid count field was empty", "a field name, not a past-tense verb"],
      ["Rückgängig machen mit dem Layout", "must keep matching — German is already un-anchored"],
    ])("does not match %s (%s)", (summary) => {
      // The first two are the reason the new patterns are anchored. The German one
      // is the known false-positive risk §6.2.6's un-anchored /Rückgängig/ carries.
      if (summary.startsWith("Rückgängig")) {
        expect(matches(summary)).toBe(true);
      } else {
        expect(matches(summary)).toBe(false);
      }
    });

    it("keeps every new pattern anchored to the start of the summary", () => {
      // If a future edit relaxes an anchor, this fails — which is the point. The
      // German pattern is exempt: §6.2.6 ships it un-anchored and that is a
      // recorded, separate question.
      const exempt = /Rückgängig/;
      for (const p of REVERT_PATTERNS) {
        if (exempt.test(p.source)) continue;
        expect(p.source.startsWith("^") || p.source.startsWith("\\b")).toBe(true);
      }
    });
  });

  it("parses the host table", () => {
    expect(parseHost("en.wikipedia.org")).toEqual({ lang: "en", project: "wikipedia" });
    expect(parseHost("de.wikipedia.org")).toEqual({ lang: "de", project: "wikipedia" });
    expect(parseHost("simple.wikipedia.org")).toEqual({ lang: "simple", project: "wikipedia" });
    expect(parseHost("en.wiktionary.org")).toEqual({ lang: "en", project: "wiktionary" });
    expect(parseHost("fr.wikisource.org")).toEqual({ lang: "fr", project: "wikisource" });
    expect(parseHost("www.wikidata.org")).toEqual({ lang: "wikidata", project: "wikidata" });
    expect(parseHost("commons.wikimedia.org")).toEqual({ lang: "commons", project: "commons" });
    expect(parseHost("meta.wikimedia.org")).toEqual({ lang: "meta", project: "meta" });
    expect(parseHost("some.other.example.org")).toEqual({ lang: "other", project: "other" });
    expect(parseHost("")).toEqual({ lang: "other", project: "other" });
  });

  it("ignores non-edit/new types without counting a parse error", () => {
    const stats = { parseErrors: 0 };
    expect(normalize(raw("ignoredLog"), stats)).toBeNull();
    expect(stats.parseErrors).toBe(0); // expected ignore, not malformed
  });

  it("rejects an edit with missing length", () => {
    const stats = { parseErrors: 0 };
    expect(normalize(raw("missingLength"), stats)).toBeNull();
    expect(stats.parseErrors).toBe(1);
  });

  it("falls back to server_url when server_name is absent", () => {
    const e = normalize(raw("serverUrlFallback"))!;
    expect(e.host).toBe("fr.wikipedia.org");
    expect(e.lang).toBe("fr");
    expect(e.project).toBe("wikipedia");
  });

  it("handles the meta host", () => {
    const e = normalize(raw("unknownHost"))!;
    expect(e.project).toBe("meta");
    expect(e.lang).toBe("meta");
  });

  it("keeps non-article namespaces", () => {
    const e = normalize(raw("commons"))!;
    expect(e.ns).toBe(6);
    expect(e.title).toBe("File:Einstein 1921.jpg");
  });

  it("never throws and returns null for garbage", () => {
    const garbage: unknown[] = [
      null,
      undefined,
      42,
      "string",
      [],
      {},
      { type: "edit" },
      { type: "edit", id: "notanumber", title: "x", length: { new: 1 } },
      { type: "edit", id: 1, title: "", length: { new: 1 } },
      { type: "edit", id: 1, title: "x", length: { new: "big" } },
    ];
    for (const g of garbage) {
      expect(() => normalize(g)).not.toThrow();
      expect(normalize(g)).toBeNull();
    }
  });

  it("carries no user identifier (spec §14.2)", () => {
    const e = normalize(raw("anonIpv4"))!;
    const serialised = JSON.stringify(e);
    expect(serialised).not.toContain("192.0.2.17");
    expect(e).not.toHaveProperty("user");
  });
});

// spec §13.2 row `normalize` — unit-level
describe("classifyActor", () => {
  it("bot flag wins", () => {
    expect(classifyActor("ExampleUser", true)).toBe("bot");
    expect(classifyActor("192.0.2.1", true)).toBe("bot");
  });

  it("detects IPv4 literals", () => {
    expect(classifyActor("192.0.2.1", false)).toBe("anon");
    expect(classifyActor("10.0.0.255", false)).toBe("anon");
  });

  it("detects IPv6-like strings with >= 2 colons", () => {
    expect(classifyActor("2001:db8::a3f1", false)).toBe("anon");
    expect(classifyActor("fe80::1", false)).toBe("anon");
    expect(classifyActor("dead:beef", false)).toBe("registered"); // only one colon
  });

  it("detects temporary accounts", () => {
    expect(classifyActor("~2025-1-abcde", false)).toBe("anon");
  });

  it("treats normal usernames as registered", () => {
    expect(classifyActor("ExampleUser", false)).toBe("registered");
    expect(classifyActor("Jimbo Wales", false)).toBe("registered");
    expect(classifyActor("", false)).toBe("registered");
    expect(classifyActor(undefined, false)).toBe("registered");
  });
});

describe("isRevert", () => {
  it("matches positives", () => {
    for (const c of [
      "Reverted edits by [[User:X]]",
      "reverted",
      "Undo",
      "Undid revision 12345 by X",
      "mw-rollback: whatever",
      "Rollback",
      "Revertido",
      "Revertidos",
      "Rückgängig gemacht",
      "Révocation",
      "Annulation",
      "Annullata",
      "Ripristino",
      "Desfeita",
      "Откат",
      "Отмена",
    ]) {
      expect(isRevert(c), c).toBe(true);
    }
  });

  it("does not match ordinary edit summaries", () => {
    for (const c of [
      "/* Early life */ fix typo",
      "added a citation",
      // Anchoring still holds: a revert word *mid-sentence* in a summary that is
      // not itself a revert must not match. This case used to be
      // "reverting to the previous version of the intro" // not anchored, which
      // §E3's capture retired — that summary *is* a revert, and `/^Reverting\b/i`
      // now matches it by shape rather than by luck. The anchoring property is
      // still worth asserting, so it is asserted on a summary that is not a revert.
      "/* Prose */ I am reverting the change I made earlier today",
      "typo",
      "",
    ]) {
      expect(isRevert(c), c).toBe(false);
    }
  });

  it("handles null/undefined", () => {
    expect(isRevert(null)).toBe(false);
    expect(isRevert(undefined)).toBe(false);
  });
});

describe("normalizeTitle", () => {
  it("replaces underscores with spaces", () => {
    expect(normalizeTitle("Albert_Einstein")).toBe("Albert Einstein");
  });

  it("truncates to 80 chars with an ellipsis", () => {
    const long = "A".repeat(200);
    const t = normalizeTitle(long);
    expect(t.length).toBe(80);
    expect(t.endsWith("…")).toBe(true);
  });

  it("leaves short titles alone", () => {
    expect(normalizeTitle("Short")).toBe("Short");
  });
});

describe("magnitudeOf — spec §6.2.9 reference points", () => {
  it("0 bytes → 0", () => {
    expect(magnitudeOf(0)).toBe(0);
    expect(magnitudeOf(-5)).toBe(0);
  });

  it("1 byte ≈ 0.07", () => {
    expect(magnitudeOf(1)).toBeCloseTo(0.0718, 3);
  });

  it("100 bytes ≈ 0.48", () => {
    // Spec §6.2.9 says "100 bytes ≈ 0.48"; the exact value is log2(101)/14.
    expect(magnitudeOf(100)).toBeCloseTo(0.4756, 3);
    expect(magnitudeOf(100)).toBeCloseTo(0.48, 1);
  });

  it("16384 bytes ≈ 1.0", () => {
    expect(magnitudeOf(16384)).toBeCloseTo(1.0, 5);
  });

  it("clamps above 16 KB", () => {
    expect(magnitudeOf(1_000_000)).toBe(1);
  });
});

describe("importanceOf — spec §6.2.10", () => {
  it("stays within [0,1]", () => {
    for (const mag of [0, 0.25, 0.5, 0.75, 1]) {
      for (const kind of ["edit", "new", "revert"] as const) {
        for (const actor of ["bot", "anon", "registered"] as const) {
          const imp = importanceOf(mag, kind, 0, actor);
          expect(imp).toBeGreaterThanOrEqual(0);
          expect(imp).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("ranks new > revert > plain edit at the same magnitude", () => {
    const n = importanceOf(0.3, "new", 0, "registered");
    const r = importanceOf(0.3, "revert", 0, "registered");
    const e = importanceOf(0.3, "edit", 0, "registered");
    expect(n).toBeGreaterThan(r);
    expect(r).toBeGreaterThan(e);
  });

  it("penalises bots", () => {
    expect(importanceOf(0.5, "edit", 0, "bot")).toBeLessThan(
      importanceOf(0.5, "edit", 0, "registered"),
    );
  });

  it("rewards article namespace", () => {
    expect(importanceOf(0.5, "edit", 0, "registered")).toBeGreaterThan(
      importanceOf(0.5, "edit", 6, "registered"),
    );
  });

  it("matches the formula exactly for a known input", () => {
    // 0.15 + 0.60*0.5 + 0 (edit) + 0.10 (ns 0) - 0.15 (bot) = 0.40
    expect(importanceOf(0.5, "edit", 0, "bot")).toBeCloseTo(0.4, 6);
  });
});

describe("wikiFromLang", () => {
  it("derives wiki database names", () => {
    expect(wikiFromLang("en")).toBe("enwiki");
    expect(wikiFromLang("commons")).toBe("commonswiki");
    expect(wikiFromLang("wikidata")).toBe("wikidatawiki");
    expect(wikiFromLang("other")).toBe("other");
    expect(wikiFromLang("")).toBe("other");
  });
});

// spec §13.2 row `filters`
describe("passes — source axis", () => {
  const edit = (over: Partial<NormalizedEdit>): NormalizedEdit =>
    ({
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
      delta: 1,
      absDelta: 1,
      magnitude: 0.1,
      importance: 0.3,
      revNew: 1,
      ...over,
    }) as NormalizedEdit;

  it("'wikipedias' (default) keeps only the wikipedia family", () => {
    const cfg: FilterConfig = { ...DEFAULT_FILTERS, namespaces: "all" };
    expect(passes(edit({}), cfg)).toBe(true);
    expect(passes(edit({ project: "wiktionary", lang: "en" }), cfg)).toBe(false);
    expect(passes(edit({ project: "wikidata", lang: "wikidata" }), cfg)).toBe(false);
    expect(passes(edit({ project: "commons", lang: "commons" }), cfg)).toBe(false);
  });

  it("'no-wikidata' drops wikidata but keeps the rest", () => {
    const cfg: FilterConfig = { source: "no-wikidata", langs: [], namespaces: "all" };
    expect(passes(edit({ project: "wikidata", lang: "wikidata" }), cfg)).toBe(false);
    expect(passes(edit({ project: "wikipedia", lang: "en" }), cfg)).toBe(true);
    expect(passes(edit({ project: "commons", lang: "commons" }), cfg)).toBe(true);
  });

  it("'all' passes everything", () => {
    const cfg: FilterConfig = { source: "all", langs: [], namespaces: "all" };
    expect(passes(edit({ project: "wikidata", lang: "wikidata" }), cfg)).toBe(true);
    expect(passes(edit({ project: "meta", lang: "meta" }), cfg)).toBe(true);
  });
});

describe("passes — langs and namespaces", () => {
  const base: FilterConfig = { source: "all", langs: [], namespaces: "all" };

  it("empty langs passes everything", () => {
    expect(passes({ lang: "zh" } as NormalizedEdit, base)).toBe(true);
  });

  it("non-empty langs restricts to the list", () => {
    const cfg: FilterConfig = { ...base, langs: ["en", "de"] };
    expect(passes({ lang: "en" } as NormalizedEdit, cfg)).toBe(true);
    expect(passes({ lang: "de" } as NormalizedEdit, cfg)).toBe(true);
    expect(passes({ lang: "fr" } as NormalizedEdit, cfg)).toBe(false);
  });

  it("namespaces 'main' keeps only ns 0", () => {
    const cfg: FilterConfig = { ...base, namespaces: "main" };
    expect(passes({ lang: "en", ns: 0 } as NormalizedEdit, cfg)).toBe(true);
    expect(passes({ lang: "en", ns: 6 } as NormalizedEdit, cfg)).toBe(false);
    expect(passes({ lang: "en", ns: 1 } as NormalizedEdit, cfg)).toBe(false);
  });

  it("namespaces 'all' keeps every namespace", () => {
    const cfg: FilterConfig = { ...base, namespaces: "all" };
    expect(passes({ lang: "en", ns: 6 } as NormalizedEdit, cfg)).toBe(true);
    expect(passes({ lang: "en", ns: 0 } as NormalizedEdit, cfg)).toBe(true);
  });
});

describe("DedupeRing — spec §6.3", () => {
  it("uses the spec capacity of 2000", () => {
    expect(DEDUPE_CAPACITY).toBe(2000);
    expect(new DedupeRing(DEDUPE_CAPACITY).capacity).toBe(2000);
  });

  it("drops exact duplicates", () => {
    const d = new DedupeRing(8);
    expect(d.seenOrAdd(42)).toBe(false);
    expect(d.seenOrAdd(42)).toBe(true);
    expect(d.seenOrAdd(43)).toBe(false);
  });

  it("evicts in FIFO order once full", () => {
    const d = new DedupeRing(3);
    d.seenOrAdd(1);
    d.seenOrAdd(2);
    d.seenOrAdd(3);
    expect(d.seenOrAdd(1)).toBe(true);
    d.seenOrAdd(4);
    expect(d.seenOrAdd(1)).toBe(false); // evicted
  });

  it("never grows past capacity", () => {
    const d = new DedupeRing(64);
    for (let i = 0; i < 5000; i++) d.seenOrAdd(i);
    expect(d.size).toBe(64);
  });
});

// spec §13.2 row `encode`
describe("encode / decode round-trip", () => {
  const rng = mulberry32(20261010);
  const make = (i: number): NormalizedEdit => {
    const id = Math.floor(rng() * 2_000_000_000);
    const host =
      rng() < 0.7 ? "en.wikipedia.org" : rng() < 0.5 ? "de.wikipedia.org" : "commons.wikimedia.org";
    const e = normalize({
      id,
      type: rng() < 0.1 ? "new" : "edit",
      namespace: rng() < 0.8 ? 0 : 6,
      title: `Title_${i}_with_underscores`,
      comment: rng() < 0.2 ? "Reverted something" : "ordinary edit",
      timestamp: 1790000000 + i,
      user: rng() < 0.3 ? "192.0.2.5" : "ExampleUser",
      bot: rng() < 0.25,
      minor: rng() < 0.5,
      length: { old: Math.floor(rng() * 5000), new: Math.floor(rng() * 5000) },
      revision: { old: i, new: i + 1 },
      server_name: host,
      wiki: "enwiki",
    })!;
    return e;
  };

  it("round-trips 1000 random edits exactly", () => {
    const edits: NormalizedEdit[] = [];
    for (let i = 0; i < 1000; i++) edits.push(make(i));

    const batch = encodeBatch(edits);
    expect(batch.n).toBe(1000);
    expect(batch.num.length).toBe(1000 * STRIDE);
    expect(batch.titles.length).toBe(1000);
    expect(batch.hosts.length).toBe(1000);

    const back = decodeBatch(batch);
    expect(back.length).toBe(1000);

    for (let i = 0; i < 1000; i++) {
      const a = edits[i]!;
      const b = back[i]!;
      expect(b.id).toBe(a.id);
      expect(b.ts).toBe(a.ts);
      expect(b.ns).toBe(a.ns);
      expect(b.kind).toBe(a.kind);
      expect(b.actor).toBe(a.actor);
      expect(b.minor).toBe(a.minor);
      expect(b.delta).toBe(a.delta);
      expect(b.absDelta).toBe(a.absDelta);
      expect(b.magnitude).toBeCloseTo(a.magnitude, 12);
      expect(b.importance).toBeCloseTo(a.importance, 12);
      expect(b.title).toBe(a.title);
      expect(b.host).toBe(a.host);
      expect(b.lang).toBe(a.lang);
      expect(b.project).toBe(a.project);
      expect(b.revNew).toBe(a.revNew);
    }
  });

  it("uses the documented field offsets (spec §6.5)", () => {
    const e = normalize(raw("normalEdit"))!;
    const b = encodeBatch([e]);
    expect(b.num[0]).toBe(e.id); // F_ID
    expect(b.num[1]).toBe(e.ts); // F_TS
    expect(b.num[2]).toBe(e.ns); // F_NS
    expect(b.num[3]).toBe(0); // F_KIND: edit = 0
    expect(b.num[4]).toBe(0); // F_ACTOR: registered = 0
    expect(b.num[5]).toBe(1); // F_MINOR
    expect(b.num[6]).toBe(67); // F_DELTA
    expect(b.num[9]).toBe(0); // F_PROJECT: wikipedia = index 0
    expect(b.num[10]).toBe(112); // F_REVNEW
    expect(b.num.length).toBe(STRIDE);
  });

  it("encodes the kind/actor/project codes the spec defines", () => {
    const bot = normalize(raw("botEdit"))!;
    const nw = normalize(raw("newPage"))!;
    const wd = normalize(raw("wikidata"))!;
    const rv = normalize(raw("revertEnglish"))!;

    expect(encodeBatch([nw]).num[3]).toBe(1); // new
    expect(encodeBatch([rv]).num[3]).toBe(2); // revert
    expect(encodeBatch([bot]).num[4]).toBe(2); // bot
    expect(encodeBatch([normalize(raw("anonIpv4"))!]).num[4]).toBe(1); // anon
    // wikidata is index 8 in PROJECTS
    expect(encodeBatch([wd]).num[9]).toBe(8);
  });

  it("handles an empty batch", () => {
    const b = encodeBatch([]);
    expect(b.n).toBe(0);
    expect(b.num.length).toBe(0);
    expect(decodeBatch(b)).toEqual([]);
  });

  it("never carries a username across the wire (spec §14.2)", () => {
    const e = normalize(raw("anonIpv4"))!;
    const b = encodeBatch([e]);
    expect(JSON.stringify(Array.from(b.num))).not.toContain("192.0.2");
    expect(b.titles[0]).not.toContain("192.0.2");
    expect(b.hosts[0]).not.toContain("192.0.2");
  });
});

describe("fixture coverage", () => {
  it("covers every case §T1.1 requires", () => {
    for (const k of [
      "normalEdit",
      "newPage",
      "botEdit",
      "anonIpv4",
      "anonIpv6",
      "tempAccount",
      "revertEnglish",
      "wikidata",
      "commons",
      "ignoredLog",
      "missingLength",
    ] as const) {
      expect(fixtures[k], k).toBeDefined();
    }
  });
});
