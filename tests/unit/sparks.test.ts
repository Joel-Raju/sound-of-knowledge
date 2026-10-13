/**
 * Spark and ring spawn behaviour. T4.3's stated test target: "ring-buffer
 * wraparound maths (pure helper returning up-to-two ranges), spawn counts per
 * tier".
 *
 * These exercise the CPU side without a GL context. `InstancedBufferAttribute`
 * works fine headless — it is a typed array plus bookkeeping — so the spawn path
 * and its update ranges are testable for real, not just the arithmetic.
 *
 * What is *not* covered here is the shader: that a spark reaches the orb, or that
 * a ring reads as a shockwave. That is T4.3's screenshot acceptance, not this
 * file's job.
 */
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  SPARK_COUNTS,
  SPARK_DELAY_STEP,
  SPARK_KIND,
  SPARK_TARGET_RADIUS,
  Sparks,
  particleFactor,
} from "@/engine/visual/sparks";
import { RING_CAPACITY, Rings } from "@/engine/visual/rings";
import { TIER_PARAMS } from "@/engine/config";

const TIERS = ["low", "medium", "high"] as const;

const ORIGIN = new THREE.Vector3(9, 0, 0);
const TO_CORE = new THREE.Vector3(-1, 0, 0);
const COLOUR = new THREE.Color(1, 0.5, 0.25);

describe("particleFactor", () => {
  it("follows §12.3's per-tier table", () => {
    expect(particleFactor("high", 0)).toBeCloseTo(1.0);
    expect(particleFactor("medium", 0)).toBeCloseTo(0.7);
    expect(particleFactor("low", 0)).toBeCloseTo(0.5);
  });

  it("scales by 0.7 at governor level 5 and above (§9.10 L5)", () => {
    expect(particleFactor("high", 4)).toBeCloseTo(1.0);
    expect(particleFactor("high", 5)).toBeCloseTo(0.7);
    expect(particleFactor("high", 6)).toBeCloseTo(0.7);
    // The product, not a replacement — L5 is an additional reduction.
    expect(particleFactor("low", 5)).toBeCloseTo(0.5 * 0.7);
  });
});

describe("Sparks capacity", () => {
  it("uses §9.5's capacity per tier", () => {
    expect(new Sparks({ tier: "high" }).capacity).toBe(24576);
    expect(new Sparks({ tier: "medium" }).capacity).toBe(12288);
    expect(new Sparks({ tier: "low" }).capacity).toBe(6144);
  });

  it("draws every instance, dead ones clipped in the shader", () => {
    // §9.5 fixes `instanceCount = CAP`; a sparse pool would need per-frame
    // compaction, which is the simulation this design avoids.
    for (const tier of TIERS) {
      const s = new Sparks({ tier });
      expect(s.geometry.instanceCount).toBe(TIER_PARAMS[tier].sparkCapacity);
      s.dispose();
    }
  });
});

describe("Sparks spawn counts", () => {
  it("gives a streak lerp(10, 26, magnitude) at the high tier", () => {
    const s = new Sparks({ tier: "high" });
    expect(s.spawnStreak(ORIGIN, TO_CORE, COLOUR, 0)).toBe(10);
    expect(s.spawnStreak(ORIGIN, TO_CORE, COLOUR, 0.25)).toBe(14);
    expect(s.spawnStreak(ORIGIN, TO_CORE, COLOUR, 0.5)).toBe(18);
    // Just under the large-edit threshold: 10 + 16 × 0.74 = 21.84 → 22.
    expect(s.spawnStreak(ORIGIN, TO_CORE, COLOUR, 0.74)).toBe(22);
    s.dispose();
  });

  it("overrides the formula at 36 for a large edit", () => {
    // §9.5 — large and substitution edits are the ones meant to be noticed.
    const s = new Sparks({ tier: "high" });
    expect(s.spawnStreak(ORIGIN, TO_CORE, COLOUR, SPARK_COUNTS.largeMagnitude)).toBe(36);
    expect(s.spawnStreak(ORIGIN, TO_CORE, COLOUR, 1)).toBe(36);
    // Just below the threshold the formula still applies.
    expect(s.spawnStreak(ORIGIN, TO_CORE, COLOUR, 0.74)).toBe(
      Math.round(SPARK_COUNTS.streak(0.74)),
    );
    s.dispose();
  });

  it("spawns exactly one particle for a bot pulse, at every tier", () => {
    // A bot pulse is a single particle at high tier; the tier factor rounds it
    // down to one rather than to zero, because a dropped edit is worse than a
    // dense one.
    for (const tier of TIERS) {
      const s = new Sparks({ tier });
      expect(s.spawnBotPulse(ORIGIN, TO_CORE, COLOUR, 0.5)).toBe(1);
      s.dispose();
    }
  });

  it("spawns 48 particles for a burst at the high tier", () => {
    const s = new Sparks({ tier: "high" });
    expect(s.spawnBurst(ORIGIN, COLOUR, 0.5)).toBe(48);
    s.dispose();
  });

  it("scales every count by the tier factor", () => {
    expect(new Sparks({ tier: "medium" }).countFor(48)).toBe(34); // 48 * 0.7
    expect(new Sparks({ tier: "low" }).countFor(48)).toBe(24); // 48 * 0.5
  });

  it("never rounds a spawn down to zero", () => {
    const s = new Sparks({ tier: "low", governorLevel: 5 });
    // 0.5 tier × 0.7 governor = 0.35; a bot pulse would round to 0.
    expect(s.countFor(1)).toBe(1);
    expect(s.spawnBotPulse(ORIGIN, TO_CORE, COLOUR, 0)).toBe(1);
    s.dispose();
  });

  it("re-scales when the tier or governor changes", () => {
    const s = new Sparks({ tier: "high" });
    expect(s.countFor(48)).toBe(48);
    s.setScale("low", 0);
    expect(s.countFor(48)).toBe(24);
    s.setScale("high", 5);
    expect(s.countFor(48)).toBe(34);
    s.dispose();
  });
});

describe("Sparks ring buffer", () => {
  it("advances the cursor by exactly the spawn count", () => {
    const s = new Sparks({ tier: "high" });
    expect(s.cursor).toBe(0);
    expect(s.spawnStreak(ORIGIN, TO_CORE, COLOUR, 0.5)).toBe(18); // 10 + 16*0.5
    expect(s.cursor).toBe(18);
    s.dispose();
  });

  it("writes each instance exactly once when the cursor wraps", () => {
    // Stride 17 rather than the default 24, because 6144 is divisible by 24 —
    // advancing a burst-sized spawn can only ever land the cursor on a multiple
    // of 24, so it can never *straddle* the end. With 17, 361 spawns reach 6137
    // and the next one has to wrap.
    const s = new Sparks({ tier: "low" });
    s.setScale("low", 5); // factor 0.35 → countFor(48) = 17
    const K = s.countFor(48);
    expect(K).toBe(17);

    // Advance until the tail is shorter than one spawn, so the next write has to
    // cross. A fixed step count can leave a full stride of headroom instead.
    while (s.capacity - s.cursor >= K) s.spawnBurst(ORIGIN, COLOUR, 0);
    const head = s.cursor;
    expect(s.capacity - head).toBeGreaterThan(0);
    // Stamp sentinels, then spawn across the boundary and confirm every slot the
    // ranges claim was actually written — no lap-twice, no gap.
    const tm = s.aTimes.array as Float32Array;
    tm.fill(-1);
    s.spawnBurst(ORIGIN, COLOUR, 0);
    expect(s.cursor).toBe((head + K) % s.capacity);

    const written = new Set<number>();
    for (let i = 0; i < s.capacity; i++) if (tm[i * 4] !== -1) written.add(i);
    expect(written.size).toBe(K);
    for (const i of written) expect((i - head + s.capacity) % s.capacity).toBeLessThan(K);
    s.dispose();
  });

  it("flags exactly the slots it wrote as needing an update", () => {
    const s = new Sparks({ tier: "high" });
    const K = s.spawnStreak(ORIGIN, TO_CORE, COLOUR, 0.5);
    expect(s.aOrigin.updateRanges.length).toBeGreaterThanOrEqual(1);
    const total = s.aOrigin.updateRanges.reduce((n, r) => n + r.count, 0);
    expect(total).toBe(K);
    // Same on every attribute — they are written and flagged together.
    for (const attr of [s.aTarget, s.aTimes, s.aStyle, s.aColor]) {
      expect(attr.updateRanges.reduce((n, r) => n + r.count, 0)).toBe(K);
    }
    s.dispose();
  });

  it("splits into two ranges when the spawn straddles the end", () => {
    // Same stride-17 trick as above: 361 spawns leave the cursor 7 slots from the
    // end, so the next one crosses.
    const s = new Sparks({ tier: "low" });
    s.setScale("low", 5);
    const K = s.countFor(48);
    // Advance until the tail is shorter than one spawn — floor() alone can leave
    // a whole stride of headroom, which is not a straddle at all.
    while (s.capacity - s.cursor >= K) s.spawnBurst(ORIGIN, COLOUR, 0);
    expect(s.capacity - s.cursor).toBeLessThan(K); // genuinely straddles

    for (const a of [s.aOrigin, s.aTarget, s.aTimes, s.aStyle, s.aColor]) {
      a.clearUpdateRanges();
    }
    // A burst, not a streak: the stride has to match the one used to position the
    // cursor, or the "7 slots remaining" simply swallows it whole.
    expect(s.spawnBurst(ORIGIN, COLOUR, 0)).toBe(K);

    const ranges = s.aOrigin.updateRanges;
    expect(ranges.length).toBe(2);
    const [head, tail] = ranges as [{ start: number; count: number }, { start: number; count: number }];
    // The first span runs to the end of the buffer; the second restarts at 0.
    expect(head.start + head.count).toBe(s.capacity);
    expect(tail.start).toBe(0);
    expect(head.count + tail.count).toBe(K);
    s.dispose();
  });
});

describe("Sparks attribute values", () => {
  it("puts the target just outside the orb surface (§9.5)", () => {
    const s = new Sparks({ tier: "high" });
    s.spawnStreak(ORIGIN, TO_CORE, COLOUR, 0.5);
    const t = s.aTarget.array as Float32Array;
    // `target = dirToCore * 1.25`, and TO_CORE is (-1, 0, 0).
    expect(t[0]).toBeCloseTo(-SPARK_TARGET_RADIUS);
    expect(t[1]).toBeCloseTo(0);
    expect(t[2]).toBeCloseTo(0);
    s.dispose();
  });

  it("staggers a streak's particles to form a comet trail", () => {
    const s = new Sparks({ tier: "high" });
    s.spawnStreak(ORIGIN, TO_CORE, COLOUR, 0.5); // 18 particles
    const tm = s.aTimes.array as Float32Array;
    // Delays ascend in equal steps from 0 — aTimes.w is the stride slot.
    const delay = (j: number) => tm[j * 4 + 2] as number;
    expect(delay(0)).toBeCloseTo(0);
    expect(delay(1)).toBeGreaterThan(delay(0));
    expect(delay(2)).toBeGreaterThan(delay(1));
    // Equal steps, not merely increasing.
    expect(delay(1) - delay(0)).toBeCloseTo(SPARK_DELAY_STEP, 6);
    expect(delay(2) - delay(1)).toBeCloseTo(SPARK_DELAY_STEP, 6);
    s.dispose();
  });

  it("normalises jIndex01 across the spawn", () => {
    const s = new Sparks({ tier: "high" });
    s.spawnStreak(ORIGIN, TO_CORE, COLOUR, 0.5);
    const st = s.aStyle.array as Float32Array;
    expect(st[2]).toBeCloseTo(0); // j = 0
    // j = K-1 = 17 → jIndex01 = 1.
    expect(st[17 * 4 + 2]).toBeCloseTo(1);
    s.dispose();
  });

  it("records the kind in aStyle.x", () => {
    // Slot offsets follow the cursor, not a fixed index: a burst writes 48
    // particles at the high tier, so the next spawn starts 48 slots on.
    const s = new Sparks({ tier: "high" });
    const st = s.aStyle.array as Float32Array;

    const nStreak = s.spawnStreak(ORIGIN, TO_CORE, COLOUR, 0); // 10
    expect(nStreak).toBe(10);
    expect(st[0]).toBe(SPARK_KIND.streak);

    const nBurst = s.spawnBurst(ORIGIN, COLOUR, 0); // 48
    expect(nBurst).toBe(48);
    expect(st[nStreak * 4]).toBe(SPARK_KIND.burst);

    expect(s.spawnBotPulse(ORIGIN, TO_CORE, COLOUR, 0)).toBe(1); // 1
    expect(st[(nStreak + nBurst) * 4]).toBe(SPARK_KIND.botPulse);
    s.dispose();
  });

  it("spawns a burst from its own position, not from the core", () => {
    const s = new Sparks({ tier: "high" });
    s.spawnBurst(ORIGIN, COLOUR, 0.5);
    const o = s.aOrigin.array as Float32Array;
    const t = s.aTarget.array as Float32Array;
    expect(o[0]).toBeCloseTo(ORIGIN.x);
    // The vertex shader expands radially from the origin, so the target is a
    // placeholder the shader ignores for kind 2.
    expect(t[0]).toBeCloseTo(ORIGIN.x);
    s.dispose();
  });

  it("makes a small edit's streak last longer than a large one's", () => {
    // §9.5 — a long, slow arrival for a small edit; a big one lands fast.
    const s = new Sparks({ tier: "high" });
    const nSmall = s.spawnStreak(ORIGIN, TO_CORE, COLOUR, 0);
    const nLarge = s.spawnStreak(ORIGIN, TO_CORE, COLOUR, 1);
    const tm = s.aTimes.array as Float32Array;
    // Magnitude 0 → 1.1 + 0.7 = 1.8 s; magnitude 1 → 1.1 s.
    expect(tm[1]).toBeCloseTo(1.8, 5);
    expect(tm[nSmall * 4 + 1]).toBeCloseTo(1.1, 5);
    expect(nSmall).toBe(10);
    expect(nLarge).toBe(36);
    s.dispose();
  });
});

describe("Sparks clock", () => {
  it("passes uTime to the shader and stamps it as the spawn time", () => {
    // §9.5's whole model: a particle's age is `uTime − spawnTime`, so the stamp
    // written at spawn must be the clock the shader will later read.
    const s = new Sparks({ tier: "high" });
    s.update(12.5);
    s.spawnStreak(ORIGIN, TO_CORE, COLOUR, 0.5);
    expect(s.material.uniforms.uTime!.value).toBe(12.5);
    expect((s.aTimes.array as Float32Array)[0]).toBe(12.5);
    s.dispose();
  });
});

describe("Rings", () => {
  it("has §9.6's capacity of 24", () => {
    const r = new Rings();
    expect(r.geometry.instanceCount).toBe(RING_CAPACITY);
    r.dispose();
  });

  it("spawns at the given slot and advances the cursor", () => {
    const r = new Rings();
    expect(r.spawn(ORIGIN, COLOUR, 3)).toBe(0);
    expect(r.spawn(ORIGIN, COLOUR, 4)).toBe(1);
    expect(r.cursor).toBe(2);
    r.dispose();
  });

  it("overwrites the oldest slot after 24 rings", () => {
    const r = new Rings();
    for (let i = 0; i < RING_CAPACITY; i++) expect(r.spawn(ORIGIN, COLOUR, i)).toBe(i);
    expect(r.cursor).toBe(0);
    expect(r.spawn(ORIGIN, COLOUR, 99)).toBe(0);
    // Live count saturates at capacity rather than growing without bound.
    expect(r.spawned).toBe(RING_CAPACITY);
    r.dispose();
  });

  it("records start time and the §9.6 duration", () => {
    const r = new Rings();
    r.spawn(ORIGIN, COLOUR, 7);
    const t = r.aTimes.array as Float32Array;
    expect(t[0]).toBe(7);
    expect(t[1]).toBeCloseTo(2.2);
    r.dispose();
  });

  it("tracks a live count below capacity", () => {
    const r = new Rings();
    expect(r.spawned).toBe(0);
    r.spawn(ORIGIN, COLOUR, 0);
    r.spawn(ORIGIN, COLOUR, 0);
    expect(r.spawned).toBe(2);
    r.dispose();
  });
});