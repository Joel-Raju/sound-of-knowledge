import { describe, expect, it } from "vitest";
import { ImportanceSampler } from "@/engine/ingest/sampler";
import { SseClient, type EventSourceLike, type StreamState } from "@/engine/ingest/sse-client";
import { mulberry32 } from "@/engine/util/random";
import {
  STREAM_BACKOFF_MS,
  STREAM_FAILURES_BEFORE_REPLAY,
  STREAM_WATCHDOG_MS,
} from "@/engine/config";
import type { NormalizedEdit } from "@/engine/types";

function mk(i: number, importance: number): NormalizedEdit {
  return {
    id: i,
    ts: 0,
    wiki: "enwiki",
    host: "en.wikipedia.org",
    lang: "en",
    project: "wikipedia",
    ns: 0,
    title: `T${i}`,
    actor: "registered",
    kind: "edit",
    minor: false,
    delta: 10,
    absDelta: 10,
    magnitude: importance,
    importance,
    revNew: 1,
  };
}

function candidates(n: number, lo = 0, hi = 1): NormalizedEdit[] {
  const out: NormalizedEdit[] = [];
  for (let i = 0; i < n; i++) out.push(mk(i, lo + ((hi - lo) * i) / Math.max(n - 1, 1)));
  return out;
}

// spec §13.2 row `sampler`
describe("ImportanceSampler", () => {
  it("never exceeds the token budget", () => {
    const s = new ImportanceSampler(40, mulberry32(1));
    let selected = 0;
    // 10 s at 40 eps max = at most 400 events, even offering 10 000.
    for (let t = 0; t < 200; t++) {
      s.refill(50 / 1000);
      selected += s.select(candidates(100)).length;
    }
    expect(selected).toBeLessThanOrEqual(400);
    expect(selected).toBeGreaterThan(300); // but should actually use the budget
  });

  it("caps the bucket at maxPerSec × 0.5", () => {
    const s = new ImportanceSampler(40, mulberry32(1));
    s.refill(1000); // a 1 s stall must not accumulate a huge backlog
    expect(s.available).toBeCloseTo(20, 6); // 40 × 0.5
  });

  it("keeps the highest-importance events when over budget", () => {
    const s = new ImportanceSampler(10, mulberry32(7));
    s.refill(0.5); // full bucket = 5 tokens
    const out = s.select(candidates(100));
    expect(out.length).toBeLessThanOrEqual(5);
    // Budget 5 = 1 random reserve + 4 by importance. So exactly 4 of the 5
    // must come from the top-importance tail (indices ≥ 90 here); the 5th is
    // the deliberately-random reserve pick, which may be any index at all.
    const high = out.filter((e) => e.importance >= 0.9).length;
    expect(high).toBeGreaterThanOrEqual(4);
  });

  it("reserves ≥ 25 % of the budget for uniform random picks", () => {
    const s = new ImportanceSampler(40, mulberry32(3));
    s.refill(0.5); // 20 tokens → 5 random + 15 importance
    // Importance rises strictly with index, so the random reserve must pick
    // from *outside* the top 15.
    const out = s.select(candidates(100));
    expect(out.length).toBe(20);
    const idxs = out.map((e) => e.id).sort((a, b) => a - b);
    const lowPick = idxs.filter((i) => i < 85).length;
    expect(lowPick).toBeGreaterThanOrEqual(4); // ~5 reserved
  });

  it("is deterministic for a fixed seed", () => {
    const run = (): string => {
      const s = new ImportanceSampler(40, mulberry32(99));
      const ids: number[] = [];
      for (let t = 0; t < 50; t++) {
        s.refill(0.05);
        for (const e of s.select(candidates(60))) ids.push(e.id);
      }
      return ids.join(",");
    };
    expect(run()).toBe(run());
  });

  it("passes everything through when under budget", () => {
    const s = new ImportanceSampler(40, mulberry32(1));
    s.refill(0.5);
    const out = s.select(candidates(10));
    expect(out.length).toBe(10);
    expect(s.getStats().dropped).toBe(0);
  });

  it("drops everything when the bucket is empty", () => {
    const s = new ImportanceSampler(40, mulberry32(1));
    const out = s.select(candidates(50));
    expect(out).toHaveLength(0);
    expect(s.getStats().dropped).toBe(50);
    expect(s.getStats().offered).toBe(50);
  });

  it("returns arrivals in order, not importance order", () => {
    const s = new ImportanceSampler(40, mulberry32(5));
    s.refill(0.5);
    const out = s.select(candidates(40));
    const ids = out.map((e) => e.id);
    const sorted = [...ids].sort((a, b) => a - b);
    expect(ids).toEqual(sorted);
  });

  it("counts stats independently of sampling", () => {
    // §2.3.4 "honest data": `offered`/`dropped` reflect every candidate,
    // while `selected` is what the sampler let through.
    const s = new ImportanceSampler(10, mulberry32(2));
    s.refill(0.5);
    for (let t = 0; t < 20; t++) {
      s.refill(0.05);
      s.select(candidates(30));
    }
    const st = s.getStats();
    expect(st.offered).toBe(600);
    expect(st.selected + st.dropped).toBe(st.offered);
  });

  it("handles an empty candidate list", () => {
    const s = new ImportanceSampler(40, mulberry32(1));
    s.refill(0.1);
    expect(s.select([])).toEqual([]);
    expect(s.getStats().offered).toBe(0);
  });

  it("reset clears counters and tokens", () => {
    const s = new ImportanceSampler(40, mulberry32(1));
    s.refill(0.5);
    s.select(candidates(20));
    s.reset();
    expect(s.getStats().offered).toBe(0);
    expect(s.available).toBe(0);
  });

  it("setMaxPerSec ignores invalid values", () => {
    const s = new ImportanceSampler(40, mulberry32(1));
    s.setMaxPerSec(-5);
    expect(s.available).toBe(0);
    s.setMaxPerSec(10);
    s.refill(0.1);
    expect(s.available).toBeCloseTo(1, 6);
  });
});

// spec §13.2 row `sse-client`
describe("SseClient", () => {
  interface Fake {
    client: SseClient;
    advance: (ms: number) => void;
    open: () => void;
    message: (data: string) => void;
    fail: () => void;
    sources: EventSourceLike[];
    closed: number;
    statuses: StreamState[];
    data: string[];
    fallbacks: string[];
    now: number;
  }

  function setup(opts: { autoOpen?: boolean } = {}): Fake {
    const sources: EventSourceLike[] = [];
    const timers = new Map<number, { at: number; fn: () => void }>();
    let nextHandle = 1;
    let closed = 0;
    let now = 0;
    const statuses: StreamState[] = [];
    const data: string[] = [];
    const fallbacks: string[] = [];

    const client = new SseClient(
      "https://example/stream",
      {
        createEventSource: (): EventSourceLike => {
          const es: EventSourceLike = {
            onopen: null,
            onerror: null,
            onmessage: null,
            close: () => {
              closed++;
            },
          };
          sources.push(es);
          return es;
        },
        setTimeout: (fn, ms) => {
          const h = nextHandle++;
          timers.set(h, { at: now + ms, fn });
          return h;
        },
        clearTimeout: (h) => {
          timers.delete(h);
        },
        now: () => now,
      },
      {
        onData: (d) => data.push(d),
        onStatus: (s) => statuses.push(s),
        onFallbackToReplay: (d) => fallbacks.push(d),
      },
    );

    client.start();

    const advance = (ms: number) => {
      now += ms;
      // Fire due timers in time order.
      for (;;) {
        let dueHandle = 0;
        let dueAt = Infinity;
        for (const [h, t] of timers) {
          if (t.at <= now && t.at < dueAt) {
            dueAt = t.at;
            dueHandle = h;
          }
        }
        if (dueHandle === 0) break;
        const t = timers.get(dueHandle)!;
        timers.delete(dueHandle);
        t.fn();
      }
    };

    return {
      client,
      advance,
      open: () => sources[sources.length - 1]?.onopen?.(),
      message: (d) => {
        sources[sources.length - 1]?.onmessage?.({ data: d });
      },
      fail: () => sources[sources.length - 1]?.onerror?.(),
      sources,
      get closed() {
        return closed;
      },
      statuses,
      data,
      fallbacks,
      get now() {
        return now;
      },
    };
    void opts;
  }

  it("connects, goes live on open, and forwards data", () => {
    const f = setup();
    expect(f.statuses[0]).toBe("connecting");
    f.open();
    expect(f.statuses).toContain("live");
    f.message("hello");
    expect(f.data).toEqual(["hello"]);
  });

  it("reconnects with the 1/2/4/8/15/30 s backoff ladder", () => {
    const f = setup();
    const delays: number[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      const d = f.client.backoffDelay(attempt);
      delays.push(d);
    }
    // §6.6 ladder, allowing the ±20 % jitter band.
    const ladder = STREAM_BACKOFF_MS;
    for (let i = 0; i < ladder.length; i++) {
      const base = ladder[i]!;
      expect(delays[i]).toBeGreaterThanOrEqual(base * 0.8);
      expect(delays[i]).toBeLessThanOrEqual(base * 1.2);
    }
    // Monotonically non-decreasing.
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]!).toBeGreaterThanOrEqual(delays[i - 1]! - 1);
    }
  });

  it("caps the backoff at the last rung", () => {
    const f = setup();
    const last = STREAM_BACKOFF_MS[STREAM_BACKOFF_MS.length - 1]!;
    expect(f.client.backoffDelay(50)).toBeLessThanOrEqual(last * 1.2);
  });

  it("closes the old EventSource before reconnecting", () => {
    // LEGACY-NOTES §3.4: not closing causes a double connection.
    const f = setup();
    f.fail();
    expect(f.closed).toBeGreaterThanOrEqual(1);
  });

  it("reconnects after an error", () => {
    const f = setup();
    f.open();
    f.fail();
    expect(f.statuses).toContain("reconnecting");
    f.advance(2000);
    expect(f.sources.length).toBeGreaterThanOrEqual(2);
  });

  it("reconnects on the 20 s watchdog when no data arrives", () => {
    expect(STREAM_WATCHDOG_MS).toBe(20000);
    const f = setup();
    f.open();
    const before = f.sources.length;
    // The watchdog fires at t=20 s; the reconnect it schedules lands ~1 s
    // later, so two advances are needed to observe the new EventSource.
    f.advance(STREAM_WATCHDOG_MS + 1000);
    expect(f.statuses.some((s) => s === "reconnecting")).toBe(true);
    f.advance(5000);
    expect(f.sources.length).toBeGreaterThan(before);
  });

  it("does not fire the watchdog while data keeps arriving", () => {
    const f = setup();
    f.open();
    for (let i = 0; i < 6; i++) {
      f.advance(10000);
      f.message("tick");
    }
    expect(f.statuses).not.toContain("reconnecting");
  });

  /**
   * One explicit connection failure, with a keepalive in between so the
   * 20 s watchdog does not add failures of its own — that keeps the
   * `failures` count attributable to explicit `fail()` calls alone.
   */
  function failOnce(f: Fake): void {
    f.open();
    f.message("keepalive"); // marks the connection healthy, resets the watchdog
    f.fail();
    f.advance(500);
    f.message("keepalive");
    f.advance(700);
  }

  it("falls back to replay after 3 failures inside 60 s", () => {
    expect(STREAM_FAILURES_BEFORE_REPLAY).toBe(3);
    const f = setup();
    failOnce(f);
    failOnce(f);
    failOnce(f);
    expect(f.fallbacks.length).toBeGreaterThanOrEqual(1);
    expect(f.client.isInReplay).toBe(true);
    expect(f.fallbacks[0]).toContain("replay");
  });

  it("keeps retrying live while in replay", () => {
    const f = setup();
    failOnce(f);
    failOnce(f);
    failOnce(f);
    expect(f.client.isInReplay).toBe(true);
    const before = f.sources.length;
    f.advance(40000);
    expect(f.sources.length).toBeGreaterThan(before);
  });

  it("does not fall back when failures are spread beyond the 60 s window", () => {
    const f = setup();
    // Each failure is followed by a >60 s healthy stretch, so the earlier
    // failures age out of the window before the next one is recorded.
    for (let i = 0; i < 3; i++) {
      failOnce(f);
      f.advance(65000);
      for (let k = 0; k < 7; k++) {
        f.advance(10000);
        f.message("keepalive");
      }
    }
    expect(f.fallbacks).toHaveLength(0);
  });

  it("reset the backoff after a healthy stretch", () => {
    const f = setup();
    f.fail();
    f.advance(2000);
    const afterOne = f.client.backoffDelay(f.client.retryCount);
    expect(afterOne).toBeGreaterThan(0);
    // Open and stay healthy past the reset threshold.
    f.open();
    for (let i = 0; i < 5; i++) {
      f.advance(10000);
      f.message("keepalive");
    }
    expect(f.client.retryCount).toBe(0);
  });

  it("stop() prevents any further connection", () => {
    const f = setup();
    f.client.stop();
    const before = f.sources.length;
    f.advance(60000);
    expect(f.sources.length).toBe(before);
  });

  it("survives an EventSource constructor that throws", () => {
    const statuses: StreamState[] = [];
    let now = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    let h = 1;
    const client = new SseClient(
      "https://example/stream",
      {
        createEventSource: () => {
          throw new Error("blocked by policy");
        },
        setTimeout: (fn, ms) => {
          const id = h++;
          timers.set(id, { at: now + ms, fn });
          return id;
        },
        clearTimeout: (id) => {
          timers.delete(id);
        },
        now: () => now,
      },
      { onData: () => {}, onStatus: (s) => statuses.push(s), onFallbackToReplay: () => {} },
    );
    expect(() => client.start()).not.toThrow();
    expect(statuses).toContain("connecting");
    now += 5000;
  });
});
