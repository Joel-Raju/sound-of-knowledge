/**
 * The HUD's mode and key must reflect the *live* harmony, and the energy behind them
 * must be live too.
 *
 * Three separate defects were found here, all of them the same shape — a value is read
 * somewhere, and the thing that should write it is never wired:
 *
 *  1. `metrics.mode` and `metrics.keyName` were **assigned nowhere**. The HUD showed
 *     the hardcoded initial values — `"lydian"` and `"—"` — for the whole session.
 *  2. The scheduler's `EnergyTracker` was **never fed**, so `E` was permanently 0.
 *  3. Once it was fed, it divided the **cumulative** ingest total by the window, so `E`
 *     saturated at 1.000.
 *
 * With (1) the readout lied; with (2) and (3) the harmony itself was a constant — and
 * the mode is a function of the energy, so the mode never drifted either.
 */
import { expect, test } from "@playwright/test";

const HarmonyStats = () => {
  const w = window as unknown as {
    __sok?: {
      metrics?: () => { mode: string; keyName: string };
      engine?: {
        getHarmonyStats?: () => {
          mode: string;
          keyName: string;
          energy: number;
          bar: number;
        } | null;
      };
    };
  };
  return {
    hud: w.__sok!.metrics!(),
    harmony: w.__sok!.engine!.getHarmonyStats?.() ?? null,
  };
};

test.describe("the HUD's harmony readout is live", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?source=synthetic&density=sparse");
    await page.getByTestId("enter-button").click({ timeout: 20_000 });
    await page.getByTestId("hud").waitFor({ timeout: 10_000 });
  });

  test("the reported key is a real key, not the placeholder", async ({ page }) => {
    // `rootPc` starts at 0 (C), so the very first report must be a note name. The
    // placeholder was "—".
    //
    // The wait matters: the audio clock is suspended until Enter resumes it, and the
    // scheduler's first bar only happens once the clock runs. Reading the metric
    // immediately after the click reads the placeholder, which looks like a failure of
    // the fix rather than of the timing.
    const key = await page.evaluate(async () => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const k = (window.__sok!.metrics!() as { keyName: string }).keyName;
        if (k !== "—") return k;
        await new Promise((r) => setTimeout(r, 200));
      }
      return (window.__sok!.metrics!() as { keyName: string }).keyName;
    });
    expect(key, "the key must become a note name").not.toBe("—");
    expect(key).toMatch(/^[A-G]#?$/);
  });

  test("the reported key matches the engine's own harmony state", async ({ page }) => {
    // The HUD readout and the source of truth must agree. If the readout is a
    // placeholder this fails immediately; if it is merely stale, it fails too.
    const both = await page.evaluate(async () => {
      const deadline = Date.now() + 20_000;
      let hud = { mode: "", keyName: "" };
      let harmony: { mode: string; keyName: string } | null = null;
      while (Date.now() < deadline) {
        const w = window as unknown as {
          __sok?: {
            metrics?: () => { mode: string; keyName: string };
            engine?: { getHarmonyStats?: () => { mode: string; keyName: string } | null };
          };
        };
        hud = w.__sok!.metrics!();
        harmony = w.__sok!.engine!.getHarmonyStats?.() ?? null;
        if (hud.keyName !== "—" && harmony) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      return { hud, harmony };
    });
    expect(both.harmony, "the engine must expose its harmony state").not.toBeNull();
    expect(both.hud.keyName, "the HUD key must match the harmony's key").toBe(
      both.harmony!.keyName,
    );
    expect(both.hud.mode, "the HUD mode must match the harmony's mode").toBe(
      both.harmony!.mode,
    );
  });

  test("the energy is live, not pinned at zero and not saturated", async ({ page }) => {
    // The `EnergyTracker` was never fed, so `E` was permanently 0 — which pins the
    // mode at aeolian, the note density at its floor and the pad's cutoff at its
    // quietest. Then, once it WAS fed, the cumulative total was divided by the
    // window, which pinned `E` at 1.000 instead.
    //
    // Either way the energy was a constant. This asserts it is neither.
    //
    // `?rateMul=0.2` scales the synthetic source's arrival rate, because the
    // synthetic source at its default rate is a *stress test*: it saturates `E` at
    // 1.000 legitimately, which would make this assertion meaningless.
    await page.goto("/?source=synthetic&rateMul=0.2");
    await page.getByTestId("enter-button").click({ timeout: 20_000 });
    await page.getByTestId("hud").waitFor({ timeout: 10_000 });

    const e = await page.evaluate(async () => {
      const deadline = Date.now() + 40_000;
      const seen: number[] = [];
      while (Date.now() < deadline) {
        const h = (
          window.__sok!.engine as unknown as {
            getHarmonyStats?: () => { energy: number } | null;
          }
        ).getHarmonyStats?.();
        if (h) seen.push(h.energy);
        if (seen.length > 30) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      return seen;
    });
    expect(e.length, "the energy must be readable").toBeGreaterThan(5);
    // The first samples are discarded: the tracker is seeded with 0 because a single
    // cumulative total carries no rate — the difference between two totals does. The
    // warm-up is a second or two, and asserting on it would be asserting on the
    // tracker's start-up rather than on its behaviour.
    const warm = e.slice(4);
    expect(warm.length, "there must be samples after the warm-up").toBeGreaterThan(3);
    const min = Math.min(...warm);
    const max = Math.max(...warm);
    console.log(`      energy range (after warm-up): ${min.toFixed(3)} … ${max.toFixed(3)}`);
    expect(max, "the energy must not be pinned at 1.0 (a saturated tracker)").toBeLessThan(1);
    expect(min, "the energy must not be pinned at 0 (an unfed tracker)").toBeGreaterThan(0);
  });

  test("the mode is not stuck at the initial value forever", async ({ page }) => {
    // The mode is a function of energy (§7.4), so with live traffic the energy moves,
    // and the mode must move with it.
    const modes = new Set<string>();
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(1_000);
      const m = await page.evaluate(
        () =>
          (
            window.__sok!.engine as unknown as {
              getHarmonyStats?: () => { mode: string } | null;
            }
          ).getHarmonyStats?.()?.mode ?? "n/a",
      );
      modes.add(m);
      if (modes.size > 1) break;
    }
    console.log(`      modes seen: ${[...modes].join(", ")}`);
    expect(
      modes.size,
      "the harmony mode must be able to change — a permanently frozen mode means the " +
        "energy is a constant, and the mode is a function of it",
    ).toBeGreaterThan(1);
  });
});
