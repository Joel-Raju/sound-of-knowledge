/**
 * The EnergyTracker must treat the ingest counters as **cumulative**.
 *
 * `IngestCore.counters.accepted` is incremented per event and never reset — it is a
 * lifetime total. The first version of `update()` divided that total by the window,
 * which produced a "rate" that grew without bound: at 20 s the total was ~300 and the
 * window 0.5 s, so the rate read 600/s. `rateToEnergy` clamps to 1, so `E` was pinned at
 * **1.000** within seconds.
 *
 * That pinned the mode at lydian, the note density at its maximum, and the pad's
 * cutoff at its brightest — and it was invisible because the tracker was **never fed at
 * all**. It only became visible once `Engine.onIngestStats` started feeding it, and
 * then it showed up as a *saturated* energy rather than as an obviously wrong number.
 */
import { describe, expect, it } from "vitest";
import { EnergyTracker } from "../../engine/music/density";
import { rateToEnergy } from "../../engine/util/perf";
import { EPS_REF } from "../../engine/config";

describe("EnergyTracker — cumulative counters", () => {
  it("computes the rate from the DELTA, not the lifetime total", () => {
    const t = new EnergyTracker();
    // 60 accepted, then 30 more per 500 ms window.
    t.update({ accepted: 60, botAccepted: 10, windowMs: 500 });
    for (let i = 0; i < 40; i++) {
      t.update({ accepted: 90 + (i + 1) * 30, botAccepted: 14 + (i + 1) * 4, windowMs: 500 });
    }

    // 30 events in 0.5 s = 60/s. The EMA has τ = 6 s, so it needs a couple of dozen
    // windows to converge — asserting on a single window would be asserting on the
    // filter, not on the rate.
    expect(t.eps).toBeGreaterThan(45);
    expect(t.eps).toBeLessThan(70);
  });

  it("does not let the lifetime total leak into the rate", () => {
    const t = new EnergyTracker();
    // A long session: the total climbs into the thousands while the rate stays at 20/s.
    let total = 0;
    for (let i = 0; i < 100; i++) {
      total += 10; // 10 events per 500 ms = 20/s
      t.update({ accepted: total, botAccepted: total / 2, windowMs: 500 });
    }
    expect(t.eps).toBeGreaterThan(15);
    expect(t.eps).toBeLessThan(25);
  });

  it("a steady 6 edits/s gives a sensible energy, not a saturated one", () => {
    const t = new EnergyTracker();
    let total = 0;
    for (let i = 0; i < 60; i++) {
      total += 3; // 3 events per 500 ms = 6/s
      t.update({ accepted: total, botAccepted: 1, windowMs: 500 });
    }
    const e = t.eps;
    // 6/s at EPS_REF 15 is E = log10(7)/log10(16) = 0.70.
    expect(e).toBeGreaterThan(4);
    expect(e).toBeLessThan(9);
    const energy = rateToEnergy(e, EPS_REF);
    expect(energy, "the energy must not be pinned at 1").toBeLessThan(0.95);
    expect(energy).toBeGreaterThan(0.3);
  });

  it("the first message seeds the EMAs rather than dividing a total by a window", () => {
    const t = new EnergyTracker();
    // A first message with a large total must not read as a huge rate.
    t.update({ accepted: 5000, botAccepted: 2500, windowMs: 500 });
    expect(t.eps).toBe(0);
  });

  it("a counter that goes backwards is clamped, not turned into a negative rate", () => {
    const t = new EnergyTracker();
    t.update({ accepted: 100, botAccepted: 10, windowMs: 500 });
    t.update({ accepted: 100, botAccepted: 10, windowMs: 500 });
    expect(t.eps).toBeGreaterThanOrEqual(0);
  });
});
