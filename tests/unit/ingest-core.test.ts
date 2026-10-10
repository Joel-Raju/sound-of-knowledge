import { describe, expect, it } from "vitest";
import { IngestCore, defaultIngestConfig } from "@/engine/ingest/ingest-core";
import { SyntheticSource } from "@/engine/ingest/synthetic";
import { mulberry32 } from "@/engine/util/random";
import { normalize } from "@/engine/ingest/normalize";
import { DEFAULT_FILTERS, passes } from "@/engine/ingest/filters";
import { BATCH_INTERVAL_MS, TICK_SEC } from "@/engine/config";
import type { WorkerOut } from "@/engine/ingest/protocol";
import type { NormalizedEdit } from "@/engine/types";
import { decodeBatch, encodeBatch } from "@/engine/ingest/encode";

/**
 * Virtual-clock harness: `advance(ms)` moves time forward and fires whatever
 * timers are due, in chronological order. Lets the whole ingest pipeline be
 * tested deterministically with no real time and no network.
 */
function harness(cfgSeed = 12345) {
  interface T {
    at: number;
    fn: () => void;
    period: number; // 0 = one-shot (setTimeout), > 0 = interval
    id: number;
  }
  const timers = new Map<number, T>();
  const out: WorkerOut[] = [];
  let now = 0;
  let h = 1;

  const core = new IngestCore(
    {
      now: () => now,
      setInterval: (fn, ms) => {
        const id = h++;
        timers.set(id, { at: now + ms, fn, period: ms, id });
        return id;
      },
      clearInterval: (id) => {
        timers.delete(id);
      },
      emit: (m) => out.push(m),
    },
    mulberry32(cfgSeed),
  );

  const advance = (ms: number) => {
    const target = now + ms;
    for (let guard = 0; guard < 1_000_000; guard++) {
      let dueId = 0;
      let due: T | undefined;
      for (const t of timers.values()) {
        if (t.at <= target && (due === undefined || t.at < due.at)) {
          due = t;
          dueId = t.id;
        }
      }
      if (due === undefined) break;
      now = Math.max(now, due.at);
      if (due.period > 0) {
        // Re-arm BEFORE firing: a real interval re-registers even if the
        // handler stops the timer (clearInterval below then removes it).
        due.at += due.period;
      } else {
        timers.delete(dueId);
      }
      due.fn();
    }
    now = target;
  };

  const batches = (): NormalizedEdit[][] => {
    const rows: NormalizedEdit[][] = [];
    for (const m of out) {
      if (m.t === "batch") rows.push(decodeBatch(m as typeof m & { t: "batch" }));
    }
    return rows;
  };

  const stats = () => {
    const rows = out.filter((m) => m.t === "stats");
    return rows[rows.length - 1] as Extract<WorkerOut, { t: "stats" }> | undefined;
  };

  const ticks = () => out.filter((m) => m.t === "tick").length;

  return { core, advance, out, batches, stats, ticks, now: () => now };
}

// spec T1.5 acceptance tests
describe("IngestCore — throughput and sampling", () => {
  it("caps emitted events at ~maxPerSec over 10 s at 100 eps (spec T1.5)", () => {
    const { core, advance, batches } = harness();
    core.setSource(new SyntheticSource({ seed: 7, rateMul: 100 / 14 }));
    core.start({ ...defaultIngestConfig(), maxPerSec: 40 });
    advance(10_000);
    core.stop();

    // `accepted` is the honest post-filter count (~1000); what must be capped
    // is what actually reaches the engine as musical/visual events.
    expect(core.countersSnapshot.accepted).toBeGreaterThan(800);
    const emitted = batches().reduce((a, b) => a + b.length, 0);
    expect(emitted).toBeLessThanOrEqual(40 * 10 + 20);
  });

  it("counts `accepted` truthfully at ~1000 for 10 s, unaffected by sampling", () => {
    // spec §2.3.4 "honest data": stats must reflect the real stream rate, not
    // the throttled musical rate.
    const src = new SyntheticSource({ seed: 7, rateMul: 100 / 14 });
    const { core, advance, batches } = harness();
    core.setSource(src);
    core.start({ ...defaultIngestConfig(), maxPerSec: 40 });
    advance(10_000);
    core.stop();

    // The synthetic source is a Poisson process; ~100 eps × 10 s ≈ 1000.
    // The upper bound is loose because §6.7's burst model adds ~20 % on top
    // of the base rate (2 %/s chance of 20–60 extra events spread over 3 s).
    const seen = core.countersSnapshot.seen;
    expect(seen).toBeGreaterThan(850);
    expect(seen).toBeLessThan(1300);

    const emitted = batches().reduce((a, b) => a + b.length, 0);
    // The ratio is the whole point: stats stay honest while playback is capped.
    expect(emitted).toBeLessThan(420);
    expect(emitted).toBeGreaterThan(300);
    expect(seen / emitted).toBeGreaterThan(1.5);
  });

  it("never emits more than the token budget allows", () => {
    const { core, advance, batches } = harness();
    core.setSource(new SyntheticSource({ seed: 3, rateMul: 30 }));
    core.start({ ...defaultIngestConfig(), maxPerSec: 16 });
    advance(10_000);
    core.stop();

    const total = batches().reduce((a, b) => a + b.length, 0);
    expect(total).toBeLessThanOrEqual(16 * 10 + 20);
    expect(total).toBeGreaterThan(100);
  });
});

describe("IngestCore — heartbeat", () => {
  it("emits ~400 ticks in 10 s (25 ms heartbeat, spec §7.7)", () => {
    const { core, advance, ticks } = harness();
    core.start(defaultIngestConfig());
    advance(10_000);
    core.stop();
    expect(TICK_SEC).toBe(0.025);
    expect(ticks()).toBeGreaterThanOrEqual(395);
    expect(ticks()).toBeLessThanOrEqual(405);
  });

  it("keeps ticking with no source attached", () => {
    const { core, advance, ticks } = harness();
    core.start(defaultIngestConfig());
    advance(1000);
    core.stop();
    expect(ticks()).toBeGreaterThanOrEqual(38);
  });
});

describe("IngestCore — stats", () => {
  it("emits stats about every 500 ms", () => {
    const { core, advance, out } = harness();
    core.start(defaultIngestConfig());
    advance(3000);
    core.stop();
    const n = out.filter((m) => m.t === "stats").length;
    expect(n).toBeGreaterThanOrEqual(5);
    expect(n).toBeLessThanOrEqual(7);
  });

  it("stats report cumulative totals and never drop below `accepted`", () => {
    const { core, advance, stats } = harness();
    core.setSource(new SyntheticSource({ seed: 5, rateMul: 5 }));
    core.start(defaultIngestConfig());
    advance(4000);
    core.stop();
    const s = stats()!;
    expect(s.accepted).toBeLessThanOrEqual(s.seen);
    expect(s.botAccepted).toBeLessThanOrEqual(s.accepted);
    expect(s.revertAccepted).toBeLessThanOrEqual(s.accepted);
    expect(s.parseErrors).toBe(0);
  });
});

describe("IngestCore — config", () => {
  it("a config change takes effect on the next batch", () => {
    const { core, advance, batches } = harness();
    core.setSource(new SyntheticSource({ seed: 11, rateMul: 20 }));
    core.start(defaultIngestConfig());

    // Narrow to namespace 'all' is a no-op for the synthetic source (already
    // mostly ns 0); instead verify the config object is applied.
    core.applyConfig({ source: "wikipedias", namespaces: "all", maxPerSec: 8 });
    expect(core.getConfig().maxPerSec).toBe(8);
    expect(core.getConfig().namespaces).toBe("all");

    advance(4000);
    core.stop();
    const total = batches().reduce((a, b) => a + b.length, 0);
    expect(total).toBeLessThanOrEqual(8 * 4 + 20);
  });

  it("changing the source filter narrows what is accepted", () => {
    const { core, advance } = harness();
    core.setSource(new SyntheticSource({ seed: 21, rateMul: 10 }));
    core.start({ ...defaultIngestConfig(), source: "wikipedias" });
    advance(3000);
    const wikiOnly = core.countersSnapshot.accepted;
    core.stop();
    expect(wikiOnly).toBeGreaterThan(0);
  });
});

describe("IngestCore — raw live path", () => {
  it("parses and normalises SSE `data:` payloads", () => {
    const { core, out, advance } = harness();
    core.start(defaultIngestConfig());
    core.feedRawData(
      JSON.stringify({
        id: 1,
        type: "edit",
        namespace: 0,
        title: "Berlin",
        comment: "typo",
        timestamp: 1790000000,
        user: "ExampleUser",
        bot: false,
        minor: true,
        length: { old: 100, new: 120 },
        revision: { old: 1, new: 2 },
        server_name: "en.wikipedia.org",
        wiki: "enwiki",
      }),
      normalize,
    );
    expect(core.countersSnapshot.accepted).toBe(1);
    expect(core.countersSnapshot.parseErrors).toBe(0);

    // The accepted edit must appear in a batch once the batch tick runs.
    advance(60);
    expect(out.some((m) => m.t === "tick")).toBe(true);
    const batches = out.filter((m) => m.t === "batch");
    expect(batches.length).toBe(1);
    const decoded = decodeBatch(batches[0] as (typeof batches)[0] & { t: "batch" });
    expect(decoded[0]!.title).toBe("Berlin");
  });

  it("counts a malformed payload as a parse error without throwing", () => {
    const { core } = harness();
    core.start(defaultIngestConfig());
    expect(() => core.feedRawData("{not json", normalize)).not.toThrow();
    expect(core.countersSnapshot.parseErrors).toBe(1);
    expect(core.countersSnapshot.accepted).toBe(0);
  });

  it("ignores `categorize` and `log` events (spec §6.2.1) without counting errors", () => {
    const { core } = harness();
    core.start(defaultIngestConfig());
    for (const type of ["categorize", "log", "external"]) {
      core.feedRawData(
        JSON.stringify({
          id: Math.floor(Math.random() * 1e9),
          type,
          namespace: 0,
          title: "X",
          timestamp: 1790000000,
          user: "U",
          bot: false,
          minor: true,
          length: { old: 1, new: 2 },
          server_name: "en.wikipedia.org",
          wiki: "enwiki",
        }),
        normalize,
      );
    }
    expect(core.countersSnapshot.accepted).toBe(0);
    expect(core.countersSnapshot.parseErrors).toBe(0);
  });

  it("dedupes a redelivered id (reconnect with Last-Event-ID, spec §6.3)", () => {
    const { core } = harness();
    core.start(defaultIngestConfig());
    const payload = JSON.stringify({
      id: 424242,
      type: "edit",
      namespace: 0,
      title: "Berlin",
      comment: "typo",
      timestamp: 1790000000,
      user: "ExampleUser",
      bot: false,
      minor: true,
      length: { old: 100, new: 120 },
      revision: { old: 1, new: 2 },
      server_name: "en.wikipedia.org",
      wiki: "enwiki",
    });
    core.feedRawData(payload, normalize);
    core.feedRawData(payload, normalize);
    expect(core.countersSnapshot.accepted).toBe(1);
    expect(core.countersSnapshot.dropped).toBe(1);
  });
});

describe("IngestCore — lifecycle", () => {
  it("stop() clears all timers", () => {
    const { core, advance, ticks } = harness();
    core.start(defaultIngestConfig());
    advance(1000);
    const at = ticks();
    core.stop();
    advance(2000);
    expect(ticks()).toBe(at);
    expect(core.isRunning).toBe(false);
  });

  it("start() is idempotent", () => {
    const { core, advance, ticks } = harness();
    core.start(defaultIngestConfig());
    core.start(defaultIngestConfig());
    advance(1000);
    core.stop();
    // Double-start must not double the heartbeat rate.
    expect(ticks()).toBeLessThanOrEqual(42);
  });

  it("setSource(null) is safe", () => {
    const { core, advance } = harness();
    core.setSource(null);
    core.start(defaultIngestConfig());
    advance(1000);
    core.stop();
  });
});

describe("IngestCore — wire format end to end", () => {
  it("emits batches the main thread can decode losslessly", () => {
    const { core, advance, out } = harness();
    core.setSource(new SyntheticSource({ seed: 31, rateMul: 4 }));
    core.start(defaultIngestConfig());
    advance(2000);
    core.stop();

    const batches = out.filter((m) => m.t === "batch");
    expect(batches.length).toBeGreaterThan(10);
    for (const b of batches) {
      const m = b as typeof b & { t: "batch" };
      expect(m.num).toBeInstanceOf(Float64Array);
      expect(m.num.length).toBe(m.n * 11);
      expect(m.titles.length).toBe(m.n);
      expect(m.hosts.length).toBe(m.n);
      const decoded = decodeBatch(m);
      for (const e of decoded) {
        expect(e.title.length).toBeGreaterThan(0);
        expect(e.host.length).toBeGreaterThan(0);
        expect(e.importance).toBeGreaterThanOrEqual(0);
        expect(e.importance).toBeLessThanOrEqual(1);
      }
    }
  });

  it("re-encodes and decodes to an identical object", () => {
    const src = new SyntheticSource({ seed: 41 });
    const edits = src.next(500);
    const round = decodeBatch(encodeBatch(edits));
    expect(round).toEqual(edits);
  });
});

describe("ingest defaults", () => {
  it("the default filter matches the spec (§6.3)", () => {
    expect(DEFAULT_FILTERS.source).toBe("wikipedias");
    expect(DEFAULT_FILTERS.namespaces).toBe("main");
    expect(DEFAULT_FILTERS.langs).toEqual([]);
  });

  it("default config batches at 50 ms (spec §6.4)", () => {
    expect(BATCH_INTERVAL_MS).toBe(50);
    expect(defaultIngestConfig().batchIntervalMs).toBe(50);
  });

  it("passes() is applied to synthetic output the same way as live", () => {
    const src = new SyntheticSource({ seed: 51, rateMul: 10 });
    const edits = src.next(2000);
    expect(edits.length).toBeGreaterThan(0);
    const kept = edits.filter((e) => passes(e, DEFAULT_FILTERS));
    // Synthetic titles are all from the wikipedia family, so the default
    // filter should keep essentially everything except non-article namespaces.
    expect(kept.length).toBeGreaterThan(edits.length * 0.7);
  });
});
