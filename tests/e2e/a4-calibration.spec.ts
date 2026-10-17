/**
 * A4 calibration — the wiring, in a real browser.
 *
 * `tests/unit/a4-calibration.test.ts` proves the geometry. This proves the rest, which
 * is where the actual failure modes would be:
 *
 *  - the debug handle exists on the **normal** page after Enter (not just `?debug=1`,
 *    which renders the debug harness and has no Enter button — an early version of the
 *    A4 probe got this wrong and timed out for 20 s);
 *  - `runA4Calibration` returns one step per named direction;
 *  - the stream really is paused, so the human hears six notes rather than six notes
 *    buried under ~10 per 2.5 s of live traffic;
 *  - the camera orbit really is held.
 */
import { expect, test } from "@playwright/test";
import type { SokMetrics } from "./sok-window";

interface A4StepLike {
  label: string;
  title: string;
  errorDeg: number;
  alignment: number;
}

const metrics = (page: import("@playwright/test").Page): Promise<SokMetrics> =>
  page.evaluate(() => window.__sok!.metrics!());

test.describe("A4 calibration rig", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?source=synthetic&density=sparse");
    await page.getByTestId("enter-button").click({ timeout: 20_000 });
    await page.getByTestId("hud").waitFor({ timeout: 10_000 });
  });

  test("the handle is on the normal page and returns a plan for all six directions", async ({ page }) => {
    const hasHandle = await page.evaluate(() => typeof window.__sok?.runA4Calibration);
    expect(hasHandle, "runA4Calibration must exist on the normal page after Enter").toBe("function");

    const steps = await page.evaluate(() => window.__sok!.runA4Calibration!({ gapMs: 200 }));
    expect(steps).toHaveLength(6);
    expect(steps.map((s) => (s as A4StepLike).label).sort()).toEqual([
      "ABOVE",
      "BEHIND",
      "BELOW",
      "FRONT",
      "LEFT",
      "RIGHT",
    ]);
    // Every step must name its edit after the direction it comes from — that is what
    // puts the expected answer on screen for the human.
    for (const s of steps as A4StepLike[]) {
      expect(s.title).toBe(`A4 ${s.label}`);
      expect(s.errorDeg).toBeLessThan(22);
    }

    await page.evaluate(() => window.__sok!.endA4Calibration?.());
  });

  test("the stream is genuinely paused, not merely quiet", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    // Small gaps so all six calibration notes land promptly and then it goes quiet.
    await page.evaluate(() => window.__sok!.runA4Calibration!({ gapMs: 200 }));

    // Let the six calibration notes fire (600 ms lead-in + 5 x 200 ms), then sample.
    await page.waitForTimeout(2_500);
    const a = await metrics(page);
    await page.waitForTimeout(1_800);
    const b = await metrics(page);

    // `notesScheduled`, NOT `acceptedTotal`. The pause gates delivery into the scheduler;
    // ingest itself keeps running and keeps counting what it accepts, so `acceptedTotal`
    // climbing is the documented design working, not a leak. An earlier version of this
    // test asserted on `acceptedTotal` and failed against correct behaviour.
    expect(
      b.notesScheduled - a.notesScheduled,
      "no further notes may be scheduled while the calibration holds the stream",
    ).toBe(0);

    await page.evaluate(() => window.__sok!.endA4Calibration?.());

    // And the gate must be reversible, or the piece would be left silent forever.
    await page.waitForTimeout(1_800);
    const c = await metrics(page);
    expect(c.notesScheduled, "ending the calibration must restore the stream").toBeGreaterThan(
      b.notesScheduled,
    );

    expect(errors, errors.join("; ")).toHaveLength(0);
  });

  test("the camera orbit is held for the duration and restored after", async ({ page }) => {
    const orbitYaw = () =>
      page.evaluate(() => {
        const e = window.__sok!.engine as unknown as {
          visualEngine?: { rig?: { orbitYaw: number; autoOrbitEnabled: boolean } };
        };
        const rig = e?.visualEngine?.rig;
        return rig ? { yaw: rig.orbitYaw, enabled: rig.autoOrbitEnabled } : null;
      });

    const before = await orbitYaw();
    expect(before, "the rig must be reachable for the freeze to be assertable").not.toBeNull();
    expect(before!.enabled, "auto-orbit is on by default — the freeze is opt-in").toBe(true);

    await page.evaluate(() => window.__sok!.runA4Calibration!({ gapMs: 200 }));
    await page.waitForTimeout(400);

    // The yaw accumulated before the freeze is KEPT — the freeze stops it advancing, it
    // does not rewind the camera. Asserting `yaw === 0` was wrong: by the time Enter has
    // resolved the rig has already orbited for a second or two, and that is correct.
    const atFreeze = await orbitYaw();
    expect(atFreeze!.enabled, "the calibration must freeze the orbit").toBe(false);

    await page.waitForTimeout(1_500);
    const during = await orbitYaw();
    expect(during!.yaw, "a frozen orbit must not advance").toBe(atFreeze!.yaw);

    await page.evaluate(() => window.__sok!.endA4Calibration?.());
    await page.waitForTimeout(400);
    const after = await orbitYaw();
    expect(after!.enabled, "ending the calibration must restore the orbit").toBe(true);
    expect(
      after!.yaw,
      "a restored orbit must actually resume advancing",
    ).toBeGreaterThan(during!.yaw);
  });
});
