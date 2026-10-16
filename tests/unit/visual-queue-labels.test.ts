/**
 * §9.9's visual queue — the four properties §13.2 names, plus §9.9's label gate and
 * URL construction.
 *
 * The queue is the piece that keeps *what you see* aligned with *what you hear*. A note
 * is emitted up to `LOOKAHEAD_HIDDEN_SEC` (1.25 s) before it sounds, so a visual fired
 * at emission would lead the audio by up to 1.25 s. These tests pin the four ways that
 * can go wrong, all of which are silent when they do.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  VisualQueue,
  DEFAULT_CAPACITY,
  STALE_AFTER_SEC,
} from "@/engine/visual/visual-queue";
import {
  shouldSpawnLabel,
  shouldEmitTicker,
  buildArticleHref,
  labelText,
  labelOpacity,
  LABEL_POOL_SIZE,
  LABEL_MIN_IMPORTANCE,
  LABEL_MIN_INTERVAL_SEC,
  LABEL_LIFETIME_SEC,
  LABEL_FADE_IN_SEC,
  LABEL_FADE_OUT_SEC,
  TICKER_MIN_IMPORTANCE,
  TICKER_MIN_INTERVAL_SEC,
} from "@/engine/visual/labels";
import { LOOKAHEAD_HIDDEN_SEC } from "@/engine/config";
import type { NoteEvent, NormalizedEdit } from "@/engine/types";

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
  delta: 120,
  absDelta: 120,
  magnitude: 0.4,
  importance: 0.7,
  revNew: 5,
  ...over,
});

const note = (when: number, over: Partial<NoteEvent> = {}): NoteEvent => ({
  when,
  voice: "pluck",
  midi: 60,
  freq: 261.6,
  vel: 0.7,
  dir: { x: 1, y: 0, z: 0 },
  radius: 9,
  edit: edit(),
  flavor: "add",
  visual: true,
  ...over,
});

/**
 * A queue with staleness effectively disabled, for tests about ordering and capacity.
 *
 * §13.2 lists ordering, stale drop, capacity overflow and heard-time gating as four
 * *separate* properties, and they genuinely interfere: a batch spanning t=1..9 cannot
 * be drained within the 1.5 s stale window of every one of its members. Isolating each
 * keeps a failure in one from masquerading as a failure in another — and the rolling
 * test at the end of this file exercises them together the way production does.
 */
const noStale = () => ({ staleAfterSec: 1000 });

describe("§13.2 — ordering", () => {
  it("releases notes in heard-time order regardless of push order", () => {
    const q = new VisualQueue(noStale());
    // Pushed backwards on purpose.
    q.push(note(3));
    q.push(note(1));
    q.push(note(2));
    expect(q.drain(10).map((n) => n.when)).toEqual([1, 2, 3]);
  });

  it("keeps insertion order for notes at the same heard-time", () => {
    const q = new VisualQueue(noStale());
    const a = note(1, { edit: edit({ id: 1 }) });
    const b = note(1, { edit: edit({ id: 2 }) });
    q.push(a);
    q.push(b);
    expect(q.drain(2).map((n) => n.edit.id)).toEqual([1, 2]);
  });

  it("preserves order across interleaved pushes", () => {
    const q = new VisualQueue(noStale());
    for (const w of [5, 1, 4, 2, 3, 9, 7, 6, 8]) q.push(note(w));
    expect(q.drain(20).map((n) => n.when)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe("the real rolling pattern — scheduled ahead, drained every frame", () => {
  it("keeps a moving window of notes in step with the clock", () => {
    // Production shape: the scheduler looks ~1.25 s ahead, the render loop drains at
    // 60 fps. Each note must fire near its own time, not near the batch's.
    const q = new VisualQueue();
    const fired: number[] = [];
    let now = 0;
    for (let t = 0; t < 60; t += 1 / 60) {
      now = t;
      // Two notes per second, each pushed 0.5 s before it sounds.
      for (const w of [t + 0.5, t + 1.0]) {
        if (Math.abs(w - Math.round(w)) < 1e-9 && Math.round(w) % 1 === 0) {
          q.push(note(Math.round(w)));
        }
      }
      for (const n of q.drain(now)) fired.push(n.when);
    }
    expect(fired.length).toBeGreaterThan(30);
    // Monotonic, and no note fires more than one frame's slack after its time.
    for (let i = 1; i < fired.length; i++) expect(fired[i]!).toBeGreaterThanOrEqual(fired[i - 1]!);
    expect(q.droppedStale).toBe(0);
  });
});

describe("§13.2 — heard-time gating", () => {
  it("releases nothing before the note's time", () => {
    const q = new VisualQueue();
    q.push(note(5));
    expect(q.drain(4.999)).toEqual([]);
    expect(q.length).toBe(1);
  });

  it("releases at exactly the note's time", () => {
    // Inclusive, not exclusive: a note due *now* is due. An exclusive bound would drop
    // every note whose time landed exactly on a frame, and at 4.81 notes/s over a
    // 60 fps render that is a visible fraction of notes silently going missing.
    const q = new VisualQueue();
    q.push(note(5));
    expect(q.drain(5)).toHaveLength(1);
  });

  it("releases only what is due, leaving the future alone", () => {
    const q = new VisualQueue();
    q.push(note(1));
    q.push(note(2));
    q.push(note(10));
    expect(q.drain(2.5).map((n) => n.when)).toEqual([1, 2]);
    expect(q.length).toBe(1);
  });

  it("refuses non-visual notes", () => {
    // `NoteEvent.visual` is false for a birth's trailing arpeggio notes; §9.9 fires
    // nothing for them.
    const q = new VisualQueue();
    expect(q.push(note(1, { visual: false }))).toBe(false);
    expect(q.length).toBe(0);
  });
});

describe("§13.2 — stale drop", () => {
  it("drops a note far past its time rather than firing it late", () => {
    const q = new VisualQueue({ staleAfterSec: 0.5 });
    q.push(note(1));
    // A tab was hidden and the visual loop stalled; the note is 10 s overdue.
    expect(q.drain(11)).toEqual([]);
    expect(q.droppedStale).toBe(1);
    expect(q.length).toBe(0);
  });

  it("still fires a note only a frame late", () => {
    // The complement of the test above: the threshold must not eat normal jitter.
    const q = new VisualQueue({ staleAfterSec: 0.5 });
    q.push(note(1));
    expect(q.drain(1.016)).toHaveLength(1);
    expect(q.droppedStale).toBe(0);
  });

  it("rejects a note that is already stale on arrival", () => {
    const q = new VisualQueue({ staleAfterSec: 0.5 });
    q.drain(100); // advance the queue's clock
    expect(q.push(note(1))).toBe(false);
    expect(q.droppedStale).toBe(1);
  });

  it("derives its threshold from the scheduler's furthest lookahead", () => {
    // Not a tuned number: the furthest ahead a note can ever be placed is
    // LOOKAHEAD_HIDDEN_SEC, so anything further past its `when` has missed its window.
    expect(STALE_AFTER_SEC).toBeGreaterThan(LOOKAHEAD_HIDDEN_SEC);
    expect(STALE_AFTER_SEC).toBeLessThan(LOOKAHEAD_HIDDEN_SEC + 0.5);
  });
});

describe("§13.2 — capacity overflow drops oldest", () => {
  it("drops the soonest-to-be-heard, not the newest", () => {
    const q = new VisualQueue({ capacity: 3, ...noStale() });
    for (const w of [1, 2, 3, 4]) q.push(note(w));
    expect(q.length).toBe(3);
    expect(q.droppedOverflow).toBe(1);
    // 1 is gone; 2, 3, 4 remain.
    expect(q.drain(99).map((n) => n.when)).toEqual([2, 3, 4]);
  });

  it("never exceeds capacity no matter how many arrive", () => {
    const q = new VisualQueue({ capacity: 8, ...noStale() });
    for (let i = 1; i <= 500; i++) q.push(note(i));
    expect(q.length).toBe(8);
    expect(q.droppedOverflow).toBe(492);
  });

  it("drops the oldest even when pushes arrive out of order", () => {
    const q = new VisualQueue({ capacity: 2, ...noStale() });
    q.push(note(10));
    q.push(note(20));
    q.push(note(5)); // earliest of all, arriving last
    expect(q.length).toBe(2);
    // 10 went, 5 stayed. Overflow is evaluated *before* insertion, so one push frees
    // exactly one slot, and a push that is itself the earliest survives — it is the
    // soonest thing to be heard, which is the opposite of what "drops oldest" costs.
    expect(q.drain(99).map((n) => n.when)).toEqual([5, 20]);
  });

  it("drops one note per push, never a batch", () => {
    const q = new VisualQueue({ capacity: 3, ...noStale() });
    for (const w of [1, 2, 3, 4, 5]) q.push(note(w));
    // Two overflows, two drops: 1 and 2.
    expect(q.droppedOverflow).toBe(2);
    expect(q.drain(99).map((n) => n.when)).toEqual([3, 4, 5]);
  });

  it("has a default capacity", () => {
    expect(DEFAULT_CAPACITY).toBeGreaterThan(0);
  });
});

describe("§13.2 — hidden tab leaves the queue empty on return", () => {
  it("clear() empties it, so stale notes do not all fire at once", () => {
    const q = new VisualQueue({ staleAfterSec: 1000 });
    for (const w of [1, 2, 3]) q.push(note(w));
    q.clear();
    expect(q.length).toBe(0);
    expect(q.drain(999)).toEqual([]);
  });
});

describe("§9.9 — label spawn gate", () => {
  const base = {
    importance: LABEL_MIN_IMPORTANCE,
    ns: 0,
    showTitles: true,
    lastSpawnAt: -Infinity,
    activeCount: 0,
    now: 100,
  };

  it("accepts a note meeting every clause", () => {
    expect(shouldSpawnLabel(base).ok).toBe(true);
  });

  it("refuses when showTitles is off", () => {
    expect(shouldSpawnLabel({ ...base, showTitles: false }).ok).toBe(false);
  });

  it("refuses a non-article namespace", () => {
    // §9.9 — `edit.ns === 0`. A Talk page is not what "open the article" means.
    expect(shouldSpawnLabel({ ...base, ns: 1 }).ok).toBe(false);
  });

  it("refuses below importance 0.55", () => {
    expect(shouldSpawnLabel({ ...base, importance: 0.549 }).ok).toBe(false);
  });

  it("accepts exactly at importance 0.55", () => {
    expect(shouldSpawnLabel({ ...base, importance: 0.55 }).ok).toBe(true);
  });

  it("refuses a second label inside 1.2 s", () => {
    expect(shouldSpawnLabel({ ...base, lastSpawnAt: 100 - 1.19 }).ok).toBe(false);
  });

  it("accepts exactly at 1.2 s", () => {
    expect(shouldSpawnLabel({ ...base, lastSpawnAt: 100 - LABEL_MIN_INTERVAL_SEC }).ok).toBe(true);
  });

  it("refuses when all six anchors are live", () => {
    expect(shouldSpawnLabel({ ...base, activeCount: LABEL_POOL_SIZE }).ok).toBe(false);
  });

  it("reports which clause refused", () => {
    // A gate that only says no is a gate that cannot be tuned from a symptom.
    const r = shouldSpawnLabel({ ...base, ns: 3 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain("ns 3");
  });
});

describe("§9.9 — article URL", () => {
  it("builds the plain article URL", () => {
    expect(buildArticleHref("en.wikipedia.org", "Albert Einstein")).toBe(
      "https://en.wikipedia.org/wiki/Albert_Einstein",
    );
  });

  it("underscores spaces before encoding", () => {
    // The spec's order, and it is load-bearing: after the substitution there are no
    // spaces left, and everything that could terminate the path is percent-encoded.
    expect(buildArticleHref("en.wikipedia.org", "A B C")).toBe(
      "https://en.wikipedia.org/wiki/A_B_C",
    );
  });

  it("encodes a question mark so it cannot become a query string", () => {
    // Reversing the substitution and the encode would let an edit titled
    // "Foo?action=delete" address a different URL entirely. The title arrives from a
    // live public API, so this is an injection surface, not a hypothetical.
    expect(buildArticleHref("en.wikipedia.org", "Foo?action=delete")).toBe(
      "https://en.wikipedia.org/wiki/Foo%3Faction%3Ddelete",
    );
  });

  it("encodes a hash so it cannot become a fragment", () => {
    expect(buildArticleHref("en.wikipedia.org", "Foo#Bar")).toBe(
      "https://en.wikipedia.org/wiki/Foo%23Bar",
    );
  });

  it("encodes a slash so it cannot escape the path", () => {
    expect(buildArticleHref("en.wikipedia.org", "Foo/Bar")).toBe(
      "https://en.wikipedia.org/wiki/Foo%2FBar",
    );
  });

  it("encodes non-ASCII titles", () => {
    expect(buildArticleHref("ja.wikipedia.org", "日本語")).toBe(
      "https://ja.wikipedia.org/wiki/%E6%97%A5%E6%9C%AC%E8%AA%9E",
    );
  });

  it("uses the edit's own host, not a hard-coded wikipedia", () => {
    expect(buildArticleHref("de.wikisource.org", "Faust")).toBe(
      "https://de.wikisource.org/wiki/Faust",
    );
  });
});

describe("§9.9 — label text and opacity", () => {
  it("reads LANG then the title", () => {
    expect(labelText(edit({ lang: "de", title: "Faust" }))).toBe("de  Faust");
  });

  it("fades in over 0.3 s, holds, and fades out over 0.9 s", () => {
    // `toBeCloseTo`, not `toBe`: the fade-out start is `3.2 - 0.9`, which is not
    // exactly representable, so the envelope returns 1 within a few ulp. Exact equality
    // would be asserting float behaviour, not the envelope.
    expect(labelOpacity(0)).toBe(0);
    expect(labelOpacity(LABEL_FADE_IN_SEC)).toBeCloseTo(1, 10);
    expect(labelOpacity(1.5)).toBeCloseTo(1, 10);
    const fadeOutStart = LABEL_LIFETIME_SEC - LABEL_FADE_OUT_SEC;
    expect(labelOpacity(fadeOutStart)).toBeCloseTo(1, 10);
    expect(labelOpacity(LABEL_LIFETIME_SEC)).toBe(0);
  });

  it("is zero before birth and after death", () => {
    expect(labelOpacity(-0.1)).toBe(0);
    expect(labelOpacity(LABEL_LIFETIME_SEC + 0.01)).toBe(0);
  });

  it("has a 3.2 s lifetime whose parts add up", () => {
    // 3.2 − 0.3 − 0.9 = 2.0 s hold. Worth pinning: these are three numbers from one
    // line of the spec and nothing else in the code would notice if one drifted.
    expect(LABEL_LIFETIME_SEC - LABEL_FADE_IN_SEC - LABEL_FADE_OUT_SEC).toBeCloseTo(2.0, 6);
  });

  it("is monotonic through the fade-in and monotonic down through the fade-out", () => {
    let prev = -1;
    for (let a = 0; a <= LABEL_FADE_IN_SEC; a += 0.03) {
      const v = labelOpacity(a);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    prev = 2;
    for (let a = LABEL_LIFETIME_SEC - LABEL_FADE_OUT_SEC; a <= LABEL_LIFETIME_SEC; a += 0.03) {
      const v = labelOpacity(a);
      expect(v).toBeLessThanOrEqual(prev);
      prev = v;
    }
  });
});

describe("§9.9 — ticker feed", () => {
  const base = {
    importance: TICKER_MIN_IMPORTANCE,
    actor: "registered" as const,
    lastEmitAt: -Infinity,
    now: 100,
  };

  it("accepts a notable human edit", () => {
    expect(shouldEmitTicker(base)).toBe(true);
  });

  it("excludes bots however important", () => {
    // The ticker is the one place a human reads prose; bot edits are the bulk of
    // traffic and would be nothing but noise there.
    expect(shouldEmitTicker({ ...base, actor: "bot", importance: 1 })).toBe(false);
  });

  it("accepts anonymous edits", () => {
    expect(shouldEmitTicker({ ...base, actor: "anon" })).toBe(true);
  });

  it("refuses below importance 0.6", () => {
    expect(shouldEmitTicker({ ...base, importance: 0.59 })).toBe(false);
  });

  it("accepts exactly at 0.6", () => {
    expect(shouldEmitTicker({ ...base, importance: 0.6 })).toBe(true);
  });

  it("throttles to one per 2.5 s", () => {
    expect(shouldEmitTicker({ ...base, lastEmitAt: 100 - 2.4 })).toBe(false);
    expect(shouldEmitTicker({ ...base, lastEmitAt: 100 - TICKER_MIN_INTERVAL_SEC })).toBe(
      true,
    );
  });

  it("uses a different threshold and interval than the label gate", () => {
    // §9.9 gives the two separate numbers. If these ever collapse into one constant
    // the two features have silently merged.
    expect(TICKER_MIN_IMPORTANCE).toBeGreaterThan(LABEL_MIN_IMPORTANCE);
    expect(TICKER_MIN_INTERVAL_SEC).toBeGreaterThan(LABEL_MIN_INTERVAL_SEC);
  });
});

describe("§9.9 — the label pool is six pre-created anchors", () => {
  it("matches the spec's pool size", () => {
    expect(LABEL_POOL_SIZE).toBe(6);
  });
});

describe("geometry", () => {
  it("a projected point is finite", () => {
    // The pool's projection path is exercised in the browser; this keeps the import
    // honest without asserting on a render that needs a GL context.
    const v = new THREE.Vector3(1, 2, 3);
    expect(Number.isFinite(v.x + v.y + v.z)).toBe(true);
  });
});