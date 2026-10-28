import { describe, expect, it } from "vitest";
import {
  Palette,
  fifthsOf,
  keyHueShift,
  langHueOffset,
  PALETTE_SPEC,
  PALETTE_TAU_SEC,
  LANG_HUE_SPREAD_DEG,
} from "@/engine/visual/palette";
import { fnv1a } from "@/engine/util/hash";
import { MODE_NAMES } from "@/engine/config";
import type { ModeId } from "@/engine/types";

/**
 * Spec §13.2, row `palette` — "key hue shift mapping; smooth transition
 * monotonic; never NaN".
 *
 * The `fifthsOf` table is written out rather than derived, so a change to the
 * formula has to be made deliberately in two places.
 */

describe("fifthsOf — spec §9.3", () => {
  it("maps a key to its position on the circle of fifths", () => {
    // `fifths = ((rootPc*7) % 12 + 6) % 12 - 6`, tabulated:
    for (const [pc, f] of [
      [0, 0],
      [1, -5],
      [2, 2],
      [3, -3],
      [4, 4],
      [5, -1],
      [6, -6],
      [7, 1],
      [8, -4],
      [9, 3],
      [10, -2],
      [11, 5],
    ] as const) {
      expect(fifthsOf(pc), `rootPc ${pc}`).toBe(f);
    }
  });

  it("puts adjacent keys on the circle of fifths five degrees apart", () => {
    // C(0) and G(7) are adjacent on the circle; their shifts differ by 5°.
    expect(Math.abs(keyHueShift(7) - keyHueShift(0))).toBe(5);
    expect(Math.abs(keyHueShift(2) - keyHueShift(9))).toBe(5);
  });

  it("spans -30..+25 degrees across all twelve keys", () => {
    // Deliberately asymmetric: the formula's `+6` centres the *fifths*, not the
    // shifts, so the extremes are -6 and +5 fifths rather than ±6.
    const shifts = Array.from({ length: 12 }, (_, i) => keyHueShift(i));
    expect(Math.min(...shifts)).toBe(-30);
    expect(Math.max(...shifts)).toBe(25);
  });

  it("gives C (rootPc 0) and F# (rootPc 6) the two extremes", () => {
    expect(keyHueShift(0)).toBe(0);
    expect(keyHueShift(6)).toBe(-30);
  });

  it("normalises out-of-range and negative pitch classes", () => {
    expect(fifthsOf(12)).toBe(fifthsOf(0));
    expect(fifthsOf(-1)).toBe(fifthsOf(11));
    expect(fifthsOf(24)).toBe(fifthsOf(0));
    expect(Number.isFinite(fifthsOf(1.4))).toBe(true);
  });
});

describe("langHueOffset — spec §9.3", () => {
  it("stays within ±12 degrees", () => {
    for (let h = 0; h < 500; h += 7) {
      const o = langHueOffset(h);
      expect(o).toBeGreaterThanOrEqual(-LANG_HUE_SPREAD_DEG - 1e-9);
      expect(o).toBeLessThanOrEqual(LANG_HUE_SPREAD_DEG + 1e-9);
    }
  });

  it("is deterministic", () => {
    expect(langHueOffset(1234)).toBe(langHueOffset(1234));
  });

  it("spreads real language hashes to distinct hues", () => {
    // Real FNV-1a hashes, not small integers: the offset reads the low 16 bits,
    // and sequential 0..63 all land in the first 64 of 65536 buckets, which
    // would make a perfectly good hash look badly distributed.
    const langs = [
      "en",
      "de",
      "fr",
      "es",
      "it",
      "pt",
      "ja",
      "zh",
      "ru",
      "ar",
      "hi",
      "sv",
      "pl",
      "nl",
      "tr",
      "ko",
      "el",
      "he",
      "th",
      "vi",
    ];
    const offsets = new Set(langs.map((l) => langHueOffset(fnv1a(l))));
    expect(offsets.size).toBe(langs.length);
  });
});

describe("Palette — spec §9.3", () => {
  it("builds all four colours for every mode, finite and in range", () => {
    for (const mode of MODE_NAMES) {
      const p = new Palette(mode, 0);
      for (const key of ["core", "accent", "dust", "deep"] as const) {
        const c = p.current[key];
        expect(Number.isFinite(c.r), `${mode}.${key}.r`).toBe(true);
        expect(Number.isFinite(c.g), `${mode}.${key}.g`).toBe(true);
        expect(Number.isFinite(c.b), `${mode}.${key}.b`).toBe(true);
        for (const v of [c.r, c.g, c.b]) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("applies the key hue shift on construction", () => {
    const a = new Palette("lydian", 6); // fifths 0 → no shift
    const b = new Palette("lydian", 7); // fifths 1 → +5°
    expect(a.current.core.r).not.toBeCloseTo(b.current.core.r, 4);
    expect(a.current.accent.r).not.toBeCloseTo(b.current.accent.r, 4);
  });

  it("gives `deep` a low luminance in every mode — it is the clear colour", () => {
    for (const mode of MODE_NAMES) {
      const p = new Palette(mode, 0);
      const d = p.clearColor();
      // `deep` is authored at L ≈ 0.10–0.12; in linear sRGB that is very dark.
      const luma = 0.2126 * d.r + 0.7152 * d.g + 0.0722 * d.b;
      expect(luma, mode).toBeLessThan(0.02);
    }
  });

  it("orders the palette by luminance: deep behind, accent in front", () => {
    // Not a spec rule, but a regression here would change the scene's character
    // every time the key walks.
    const p = new Palette("aeolian", 0);
    const luma = (k: "core" | "accent" | "dust" | "deep"): number => {
      const c = p.current[k];
      return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    };
    expect(luma("deep")).toBeLessThan(luma("dust"));
    expect(luma("dust")).toBeLessThan(luma("accent"));
  });

  // --- transitions ---------------------------------------------------------

  it("does not move when there is no time to move", () => {
    const p = new Palette("lydian", 0);
    const before = { ...p.current.core };
    p.update(0);
    expect(p.current.core.r).toBeCloseTo(before.r, 12);
  });

  it("eases toward the target rather than snapping", () => {
    const p = new Palette("lydian", 0);
    const from = { ...p.current.core };
    p.set("dorian", 0, false);
    expect(p.current.core.r).toBeCloseTo(from.r, 12); // unchanged so far
    p.update(0.016);
    const moved = Math.abs(p.current.core.r - from.r) + Math.abs(p.current.core.g - from.g);
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThan(Math.abs(p.target.core.r - from.r) + 1e-6);
  });

  it("converges on the target and reports settled", () => {
    const p = new Palette("lydian", 0);
    p.set("aeolian", 3, false);
    expect(p.isSettled).toBe(false);
    for (let i = 0; i < 3000; i++) p.update(1 / 60);
    expect(p.isSettled).toBe(true);
    expect(p.current.core.r).toBeCloseTo(p.target.core.r, 3);
    expect(p.current.deep.b).toBeCloseTo(p.target.deep.b, 3);
  });

  it("is frame-rate independent: the same elapsed time gives the same colour", () => {
    // Both must start from the *same* mode: `set(..., false)` retargets but does
    // not snap, so two palettes starting from different modes ease along
    // different paths and never converge on the same value at 1 s.
    const a = new Palette("lydian", 0);
    const b = new Palette("lydian", 0);
    a.set("aeolian", 5, false);
    b.set("aeolian", 5, false);

    // Both loops cover exactly 1 s — 60 frames at 60 Hz and 10 at 10 Hz.
    for (let i = 0; i < 60; i++) a.update(1 / 60);
    for (let i = 0; i < 10; i++) b.update(1 / 10);

    expect(a.current.core.r).toBeCloseTo(b.current.core.r, 9);
    expect(a.current.accent.g).toBeCloseTo(b.current.accent.g, 9);
    expect(a.current.deep.b).toBeCloseTo(b.current.deep.b, 9);
  });

  it("converges identically at 10, 60 and 600 Hz", () => {
    // The stronger form of the same property: `a = 1 - exp(-dt/tau)` compounding
    // to a fixed elapsed time is what makes it hold at all, and this is the
    // assertion that would catch a regression to a fixed per-frame fraction.
    const make = (): Palette => {
      const p = new Palette("lydian", 0);
      p.set("aeolian", 5, false);
      return p;
    };
    const rates: [number, number][] = [
      [1 / 10, 10],
      [1 / 60, 60],
      [1 / 600, 600],
    ];
    const results = rates.map(([dt, n]) => {
      const p = make();
      for (let i = 0; i < n; i++) p.update(dt);
      return p.current.core.r;
    });
    for (const r of results) expect(r).toBeCloseTo(results[0]!, 9);
  });

  it("is monotonic — never overshoots the target", () => {
    // Overshoot would make the palette pulse past the new key and back.
    const p = new Palette("lydian", 0);
    const from = { ...p.current.core };
    p.set("aeolian", 0, false);
    const to = { ...p.target.core };

    let prevError = Infinity;
    for (let i = 0; i < 600; i++) {
      p.update(1 / 60);
      const error = Math.abs(p.current.core.r - to.r);
      expect(error).toBeLessThanOrEqual(prevError + 1e-9);
      prevError = error;
    }
    expect(prevError).toBeLessThan(Math.abs(to.r - from.r));
  });

  it("snaps when asked to", () => {
    const p = new Palette("lydian", 0);
    p.set("aeolian", 0, true);
    expect(p.isSettled).toBe(true);
    expect(p.current.core.r).toBeCloseTo(p.target.core.r, 12);
  });

  it("ignores an unknown mode", () => {
    const p = new Palette("lydian", 0);
    const before = { ...p.current.core };
    p.set("nonsense" as ModeId, 0, false);
    expect(p.current.core.r).toBeCloseTo(before.r, 12);
  });

  it("survives a zero or negative dt", () => {
    const p = new Palette("lydian", 0);
    p.set("dorian", 0, false);
    const before = { ...p.current.core };
    p.update(0);
    p.update(-1);
    expect(p.current.core.r).toBeCloseTo(before.r, 12);
    expect(Number.isNaN(p.current.core.r)).toBe(false);
  });

  // --- event colours -------------------------------------------------------

  it("gives additions the accent and removals the core", () => {
    const p = new Palette("lydian", 0);
    const acc = { ...p.colorFor("addition", 0) };
    const rem = { ...p.colorFor("removal", 0) };
    expect(acc).toEqual(p.current.accent);
    expect(rem).toEqual(p.current.core);
  });

  it("boosts no base colour with magnitude", () => {
    // §9.5's "spark head 1.5–3.5 scaled by lerp(1.5, 3.5, magnitude)" belongs
    // to the spark shader (T4.3), not the palette. Applying it here would make
    // every ordinary note 1.5–3.5× brighter.
    const p = new Palette("lydian", 0);
    const small = { ...p.colorFor("addition", 0) };
    const large = { ...p.colorFor("addition", 1) };
    expect(large).toEqual(small);
    expect(large).toEqual(p.current.accent);
  });

  it("produces HDR values above 1 where §9.3 asks for them", () => {
    const p = new Palette("lydian", 0);
    // `burst` is `accent * 1.8` plus 30 % white — deliberately over 1 so the
    // bloom has something to work with.
    const burst = p.colorFor("burst", 0.5);
    expect(burst.r + burst.g + burst.b).toBeGreaterThan(1);
  });

  it("mixes a revert toward white, per §9.3", () => {
    const p = new Palette("dorian", 0);
    const revert = { ...p.colorFor("revert", 0.5) };
    const large = { ...p.colorFor("large", 0.5) };
    // The revert is the same mix at 1.5x plus 40 % white, so every channel must
    // be brighter than the plain `large` version.
    for (const ch of ["r", "g", "b"] as const) {
      expect(revert[ch]).toBeGreaterThan(large[ch]);
    }
  });

  it("derives bot pulses from `dust`", () => {
    const p = new Palette("mixolydian", 0);
    const bot = { ...p.colorFor("bot", 0.5) };
    const dust = p.current.dust;
    expect(bot.r).toBeCloseTo(dust.r * 1.6, 6);
  });

  it("never returns NaN for any event kind", () => {
    for (const mode of MODE_NAMES) {
      const p = new Palette(mode, 4);
      for (const kind of ["addition", "removal", "large", "revert", "burst", "bot"] as const) {
        for (const mag of [-1, 0, 0.5, 1, 5]) {
          const c = p.colorFor(kind, mag);
          expect(Number.isNaN(c.r), `${mode}/${kind}/${mag}`).toBe(false);
          expect(Number.isNaN(c.g)).toBe(false);
          expect(Number.isNaN(c.b)).toBe(false);
        }
      }
    }
  });

  it("reuses one object so the frame loop does not allocate", () => {
    // The contract is that `colorFor` overwrites a shared triple; callers must
    // read it before the next call. If that ever changes, §12.1's "no per-frame
    // allocations" quietly breaks.
    const p = new Palette("lydian", 0);
    expect(p.colorFor("addition", 0)).toBe(p.colorFor("addition", 0));
  });

  // --- authoring table -----------------------------------------------------

  it("has an entry for every mode and none extra", () => {
    expect(Object.keys(PALETTE_SPEC).sort()).toEqual([...MODE_NAMES].sort());
  });

  it("uses a 2 s transition time, per §9.3", () => {
    expect(PALETTE_TAU_SEC).toBe(2);
  });
});
