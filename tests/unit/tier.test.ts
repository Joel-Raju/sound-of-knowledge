import { describe, expect, it } from "vitest";
import { detectTier, pixelRatioCeiling, type TierEnv } from "@/engine/visual/tier";
import { TIER_PARAMS } from "@/engine/config";
import type { Tier } from "@/engine/types";

/**
 * Spec §13.2, row `tier` — "detection table incl. swiftshader, coarse pointer,
 * Intel iGPU, Apple".
 *
 * Pure function, so every branch is reachable from a plain object.
 */

/** A modern desktop that should get the top tier. */
const DESKTOP: TierEnv = {
  coarsePointer: false,
  width: 2560,
  height: 1440,
  cores: 12,
  deviceMemory: 16,
  gpuRenderer: "apple m2 pro",
};

describe("detectTier — spec §12.2", () => {
  it("gives a capable desktop the top tier", () => {
    expect(detectTier(DESKTOP)).toBe("high");
  });

  it("treats an unknown environment as capable", () => {
    // Absence of every signal must not be read as weakness: `high` is the
    // default because the piece degrades gracefully and looks poor on a machine
    // that cannot keep up.
    expect(detectTier({})).toBe("high");
  });

  // --- software rasterisers: always low, whatever else is true --------------

  it("pins SwiftShader to low even on capable hardware", () => {
    // This is the case CI runs under, so it is the one that must never be
    // wrong: a mis-detection here makes every e2e test meaningless.
    expect(
      detectTier({ ...DESKTOP, gpuRenderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader))" }),
    ).toBe("low");
  });

  it("recognises llvmpipe and generic software renderers", () => {
    expect(detectTier({ gpuRenderer: "llvmpipe (LLVM 15.0.0, 256 bits)" })).toBe("low");
    expect(detectTier({ gpuRenderer: "Software Rasterizer" })).toBe("low");
  });

  it("checks the software rule before the coarse-pointer rule", () => {
    // A software rasteriser on an 8-core touch device would otherwise be
    // promoted to medium, which it cannot render.
    expect(
      detectTier({ gpuRenderer: "swiftshader", coarsePointer: true, cores: 16, deviceMemory: 16 }),
    ).toBe("low");
  });

  it("matches the software rule case-insensitively", () => {
    expect(detectTier({ gpuRenderer: "SWIFTSHADER" })).toBe("low");
  });

  // --- coarse pointer / small viewport -------------------------------------

  it("treats a small viewport as coarse, then grades it on cores and memory", () => {
    // §12.2 routes *both* signals through the same `coarse` branch, so a small
    // viewport is not automatically `low` — a strong phone-sized window still
    // earns `medium`. Worth pinning because the two inputs are not independent.
    expect(detectTier({ width: 375, height: 667, cores: 12, deviceMemory: 16 })).toBe("medium");
    expect(detectTier({ width: 375, height: 667, cores: 4, deviceMemory: 4 })).toBe("low");
  });

  it("uses the smaller of the two viewport dimensions", () => {
    // A narrow desktop window is still coarse. Only the smaller side counts.
    expect(detectTier({ width: 400, height: 1200, cores: 12, deviceMemory: 16 })).toBe("medium");
    expect(detectTier({ width: 400, height: 1200, cores: 4, deviceMemory: 4 })).toBe("low");
    // Both sides large → not coarse, so it grades on the GPU instead.
    expect(detectTier({ width: 2560, height: 1440, cores: 12, deviceMemory: 16 })).toBe("high");
  });

  it("reads a zero-size viewport as coarse, per §12.2's formula", () => {
    // `Math.min(0, 0) < 600` is true, so §12.2 sends a 0×0 viewport down the
    // coarse branch. Documented rather than special-cased: tier is detected once
    // at startup from `window.innerWidth/innerHeight`, which is never 0 in a
    // real browser, so the case cannot arise — and deviating from an explicit
    // spec formula for a case that cannot occur is not worth the surprise later.
    expect(detectTier({ width: 0, height: 0, cores: 12, deviceMemory: 16 })).toBe("medium");
  });

  it("gives a coarse pointer medium only on a strong phone", () => {
    expect(detectTier({ coarsePointer: true, cores: 8, deviceMemory: 6 })).toBe("medium");
    expect(
      detectTier({ coarsePointer: true, cores: 8, deviceMemory: 6, width: 1024, height: 768 }),
    ).toBe("medium");
  });

  it("gives a coarse pointer low on a weak phone", () => {
    expect(detectTier({ coarsePointer: true, cores: 4, deviceMemory: 4 })).toBe("low");
    expect(detectTier({ coarsePointer: true, cores: 8, deviceMemory: 4 })).toBe("low");
    expect(detectTier({ coarsePointer: true, cores: 4, deviceMemory: 6 })).toBe("low");
  });

  // --- integrated GPUs ------------------------------------------------------

  it("gives Intel integrated graphics medium", () => {
    expect(detectTier({ gpuRenderer: "Intel(R) UHD Graphics 620" })).toBe("medium");
    expect(detectTier({ gpuRenderer: "Intel Iris Xe Graphics" })).toBe("medium");
  });

  it("gives Intel Arc the top tier — it is a discrete card", () => {
    // The `/arc/` exclusion in §12.2 exists precisely so Arc is not demoted
    // along with the rest of the Intel line.
    expect(detectTier({ gpuRenderer: "Intel Arc A770 Graphics" })).toBe("high");
    expect(detectTier({ gpuRenderer: "Intel Arc A380 Graphics" })).toBe("high");
  });

  it("does not demote when both intel and arc appear", () => {
    expect(detectTier({ gpuRenderer: "Intel(R) Arc Graphics" })).toBe("high");
  });

  it("leaves discrete AMD and NVIDIA at the top tier", () => {
    expect(detectTier({ gpuRenderer: "NVIDIA GeForce RTX 3080" })).toBe("high");
    expect(detectTier({ gpuRenderer: "AMD Radeon RX 6800" })).toBe("high");
  });

  // --- absent signals -------------------------------------------------------

  it("falls back to the spec's default cores and memory", () => {
    // §12.2 uses `cores = env.cores ?? 4` and `mem = env.deviceMemory ?? 4`.
    // With no core/memory data, a coarse pointer must not reach medium.
    expect(detectTier({ coarsePointer: true })).toBe("low");
  });

  it("treats an empty gpuRenderer as unknown rather than integrated", () => {
    expect(detectTier({ gpuRenderer: "" })).toBe("high");
    expect(detectTier({ gpuRenderer: undefined })).toBe("high");
  });

  it("does not treat a missing dimension as a small screen", () => {
    // Absent is not the same as zero: with no viewport information at all the
    // `coarse` flag stays false and the GPU signal decides. §12.2 gets this for
    // free because `Math.min(undefined, undefined)` is NaN, and `NaN < 600` is
    // false — this pins that it is deliberate rather than accidental.
    expect(detectTier({ cores: 12, deviceMemory: 16, gpuRenderer: "NVIDIA RTX 3080" })).toBe(
      "high",
    );
  });

  // --- the detected tier must have params ----------------------------------

  it("always returns a tier that exists in TIER_PARAMS", () => {
    const cases: TierEnv[] = [
      {},
      DESKTOP,
      { gpuRenderer: "swiftshader" },
      { coarsePointer: true },
      { gpuRenderer: "Intel UHD" },
      { width: 320, height: 480 },
    ];
    for (const env of cases) {
      const tier = detectTier(env);
      expect(TIER_PARAMS[tier]).toBeDefined();
      expect(TIER_PARAMS[tier].maxRenderScale).toBeGreaterThan(0);
      expect(TIER_PARAMS[tier].dustPoints).toBeGreaterThan(0);
    }
  });

  it("orders tiers so each is cheaper than the one above", () => {
    // A regression here would silently ship an over-budget configuration.
    expect(TIER_PARAMS.low.dustPoints).toBeLessThan(TIER_PARAMS.medium.dustPoints);
    expect(TIER_PARAMS.medium.dustPoints).toBeLessThan(TIER_PARAMS.high.dustPoints);
    expect(TIER_PARAMS.low.orbSteps).toBeLessThan(TIER_PARAMS.high.orbSteps);
    expect(TIER_PARAMS.low.maxRenderScale).toBeLessThanOrEqual(TIER_PARAMS.high.maxRenderScale);
  });
});

/**
 * Spec §12.3 — "max render scale (× devicePixelRatio) | min(dpr, 2) |
 * min(dpr, 1.5) | 1.0".
 *
 * These values are the *pixel ratio*, not a multiple of it. That reading is
 * forced by the table itself: as multipliers, the low tier's 1.0 would demand
 * `dpr * 1.0`, contradicting the column's own caption, and on a 2× display the
 * 1.0/2 = 0.5 that `min(dpr, 1.0)` implies as a multiplier would sit below
 * §9.10's floor of 0.55. Logged in DECISIONS.md.
 */
describe("pixelRatioCeiling — spec §12.3", () => {
  const TABLE: [Tier, (dpr: number) => number][] = [
    ["high", (d) => Math.min(d, 2)],
    ["medium", (d) => Math.min(d, 1.5)],
    ["low", () => 1],
  ];

  it("reproduces the §12.3 table at every dpr", () => {
    for (const dpr of [1, 1.25, 1.5, 2, 2.5, 3, 3.5, 4]) {
      for (const [tier, spec] of TABLE) {
        expect(pixelRatioCeiling(dpr, tier), `${tier} @ dpr ${dpr}`).toBeCloseTo(spec(dpr), 9);
      }
    }
  });

  it("caps the low tier at 1.0 on every display, per the table's literal value", () => {
    // Unlike the other two columns the low tier's is a bare `1.0`, not a `min`.
    for (const dpr of [1, 2, 3, 4]) expect(pixelRatioCeiling(dpr, "low")).toBe(1);
  });

  it("clears §9.10's 0.55 floor on every ordinary display", () => {
    // §9.10's `scale ∈ [0.55, tierMaxScale]` needs `tierMaxScale ≥ 0.55`. If a
    // ceiling fell below the floor the governor would be asked to operate on an
    // empty range, and which bound won would depend on which side of the range
    // the current value happened to sit.
    for (const dpr of [1, 1.5, 2, 3, 4]) {
      for (const [tier] of TABLE) {
        expect(pixelRatioCeiling(dpr, tier), `${tier} @ dpr ${dpr}`).toBeGreaterThanOrEqual(0.55);
      }
    }
  });

  it("can dip below the floor at dpr < 0.55, which the renderer resolves downward", () => {
    // Reachable only via heavy page zoom-out or a `resolution` override. The
    // ceiling is allowed to go under 0.55 here, and the renderer clamps the floor
    // down to meet it rather than letting the floor override the tier.
    expect(pixelRatioCeiling(0.5, "high")).toBe(0.5);
    expect(pixelRatioCeiling(0.4, "medium")).toBe(0.4);
    expect(pixelRatioCeiling(0.5, "low")).toBe(0.5);
  });

  it("is monotonic in dpr for every tier", () => {
    for (const [tier] of TABLE) {
      let prev = 0;
      for (let dpr = 0.5; dpr <= 4; dpr += 0.25) {
        const c = pixelRatioCeiling(dpr, tier);
        expect(c, `${tier} @ dpr ${dpr}`).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = c;
      }
    }
  });

  it("degrades monotonically from high to low", () => {
    for (const dpr of [1, 2, 3]) {
      expect(pixelRatioCeiling(dpr, "high")).toBeGreaterThanOrEqual(
        pixelRatioCeiling(dpr, "medium"),
      );
      expect(pixelRatioCeiling(dpr, "medium")).toBeGreaterThanOrEqual(
        pixelRatioCeiling(dpr, "low"),
      );
    }
  });

  it("falls back to dpr 1 for a nonsense value", () => {
    // A 0 or NaN `devicePixelRatio` is a browser bug, not a small display;
    // treating it as 0 would make the ceiling 0 and blank the canvas.
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(pixelRatioCeiling(bad, "high")).toBe(1);
      expect(pixelRatioCeiling(bad, "low")).toBe(1);
    }
  });
});
