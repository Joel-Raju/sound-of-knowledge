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

  test("all six notes ACTUALLY become notes — and exactly six, not more", async ({ page }) => {
    // The assertion whose absence cost the human two attempts. The rig looked correct,
    // returned a six-step plan, and fired six callbacks on schedule — and still played
    // only one note, because the scheduler is a probabilistic sampler and the edits were
    // queued behind pre-pause backlog that `pickBest`'s lookahead could not reach.
    // "returns six steps" checks the plan; "the stream is paused" checks the gate.
    // Neither checks that anything was *heard*.
    const before = (await metrics(page)).notesScheduled;

    await page.evaluate(() => window.__sok!.runA4Calibration!({ gapMs: 700 }));

    const fired = await page.evaluate(async () => {
      const deadline = Date.now() + 40_000;
      while (Date.now() < deadline) {
        const f = (window.__sok!.getA4Fired?.() ?? []) as string[];
        if (f.length >= 6) return f;
        await new Promise((r) => setTimeout(r, 250));
      }
      return (window.__sok!.getA4Fired?.() ?? []) as string[];
    });
    expect(fired, "every calibration step must reach the scheduler").toEqual([
      "FRONT",
      "RIGHT",
      "LEFT",
      "BEHIND",
      "ABOVE",
      "BELOW",
    ]);

    // Six callbacks is not six notes — this is the assertion that would have caught it.
    // Wait for the schedule to settle, not for a fixed period: the steps are chained,
    // so the last note lands long after the first.
    await page.waitForTimeout(3_000);
    const delta = (await metrics(page)).notesScheduled - before;

    // And it must not be MANY more than six. The re-offer loop used to leave a copy of
    // each edit in the queue on every retry, so all of them eventually played: **22
    // notes** for six steps.
    //
    // It was worse than noise. `pickBest` scores `importance + 0.1·age`, so the OLDEST
    // queued edit wins: FRONT's retry copies always beat RIGHT/LEFT, which sat behind
    // them where the lookahead could not reach them. The human heard one direction and
    // one title, forever.
    //
    // The count is a range, not an exact number: a note already in flight when the
    // calibration starts can land on either side of the boundary, and the sampler may
    // not have picked the last step yet when the window closes. Measured 5-7 when
    // correct, 8-10 when the retries accumulate.
    expect(delta, "the calibration must produce six notes, not one and not many").toBeGreaterThanOrEqual(5);
    expect(delta, "retries must replace the queued copy, not add another").toBeLessThanOrEqual(8);

    await page.evaluate(() => window.__sok!.endA4Calibration?.());
  });

  test("the human's own configuration also produces six — the regression that hid here", async ({ page }) => {
    // The test above uses `density=sparse`, and that configuration **masks** the
    // duplicate-copy bug: the melodic gate's probability `p` is higher, so the sampler
    // usually picks the edit on the first offer and no copy is left behind. The human
    // ran the default URL, where the same defect produced 22 notes.
    //
    // So the defect is re-tested in the configuration that exposed it. Measured with the
    // bug present: 10 notes. With the fix: 6.
    await page.goto("/?source=synthetic&density=normal");
    await page.getByTestId("enter-button").click({ timeout: 20_000 });
    await page.getByTestId("hud").waitFor({ timeout: 10_000 });
    // Long enough for the energy tracker to settle, which is what lowers `p` and makes
    // the retries multiply.
    await page.waitForTimeout(10_000);

    const before = (await metrics(page)).notesScheduled;
    await page.evaluate(() => window.__sok!.runA4Calibration!({ gapMs: 900 }));

    // Wait for all SIX to have been scheduled, not for a fixed period. The steps are
    // **chained** — each waits for the previous note to be scheduled and then for it
    // to decay (a bell rings 3.5 s) — so the whole sequence takes ~35 s, and a fixed
    // 12 s window caught only three steps.
    const fired = await page.evaluate(async () => {
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const f = (window.__sok!.getA4Fired?.() ?? []) as string[];
        if (f.length >= 6) return f;
        await new Promise((r) => setTimeout(r, 250));
      }
      return (window.__sok!.getA4Fired?.() ?? []) as string[];
    });
    expect(fired, "all six steps must be reached").toHaveLength(6);

    // Let the last note be scheduled.
    await page.waitForTimeout(2_000);
    const delta = (await metrics(page)).notesScheduled - before;

    expect(delta, "six steps, and the retries must not multiply them").toBeLessThanOrEqual(8);
    expect(delta, "six steps must produce at least six notes").toBeGreaterThanOrEqual(5);

    await page.evaluate(() => window.__sok!.endA4Calibration?.());
  });

  test("the on-screen readout names every step — the reference the human judges against", async ({ page }) => {
    // The 3D label CANNOT be the reference. §9.1 puts the camera at radius 5.5 inside
    // the 7-13 edit shell, so five of the six calibration directions project OUTSIDE the
    // frustum: RIGHT at 118% of screen width, LEFT at -16%, BEHIND behind the camera,
    // ABOVE at -88%, BELOW at 198%. Only FRONT is ever visible in the scene — which is
    // exactly what the human reported seeing.
    //
    // The HUD ticker is DOM and always visible, but it is throttled at 2.5 s and
    // REPLACES rather than queues, so it showed 3 of 6 steps.
    //
    // So the calibration needs its own always-visible readout, and it must show every
    // step. This is the assertion that makes the human's task possible at all.
    await page.evaluate(() => window.__sok!.runA4Calibration!({ gapMs: 700 }));

    // Read the data attribute, NOT the rendered text. The first version parsed the
    // text content and broke on the concatenation of the styled spans
    // ("6BELOWlisten:"), which cost a debugging cycle and would have been flaky at
    // every label boundary.
    const seen = await page.evaluate(async () => {
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const el = document.querySelector('[data-testid="a4-readout"]');
        const attr = el?.getAttribute("data-a4-seen");
        if (attr) {
          const parts = attr.split(",").filter(Boolean);
          if (parts.length >= 6) return parts;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      const el = document.querySelector('[data-testid="a4-readout"]');
      return (el?.getAttribute("data-a4-seen") ?? "").split(",").filter(Boolean);
    });

    expect(
      seen.sort(),
      "every calibration direction must be named on screen",
    ).toEqual(["ABOVE", "BEHIND", "BELOW", "FRONT", "LEFT", "RIGHT"]);

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
    const pose = () =>
      page.evaluate(() => {
        const e = window.__sok!.engine as unknown as {
          visualEngine?: {
            rig?: {
              orbitYaw: number;
              autoOrbitEnabled: boolean;
              freezePoseEnabled: boolean;
              position: { x: number; y: number; z: number };
              forward: { x: number; y: number; z: number };
            };
          };
        };
        const rig = e?.visualEngine?.rig;
        return rig
          ? {
              yaw: rig.orbitYaw,
              enabled: rig.autoOrbitEnabled,
              frozen: rig.freezePoseEnabled,
              pos: { ...rig.position },
              fwd: { ...rig.forward },
            }
          : null;
      });

    const before = await pose();
    expect(before, "the rig must be reachable for the freeze to be assertable").not.toBeNull();
    expect(before!.enabled, "auto-orbit is on by default — the freeze is opt-in").toBe(true);

    await page.evaluate(() => window.__sok!.runA4Calibration!({ gapMs: 700 }));
    await page.waitForTimeout(400);

    // The yaw accumulated before the freeze is KEPT — the freeze stops it advancing, it
    // does not rewind the camera. Asserting `yaw === 0` was wrong: by the time Enter has
    // resolved the rig has already orbited for a second or two, and that is correct.
    const atFreeze = await pose();
    expect(atFreeze!.enabled, "the calibration must freeze the orbit").toBe(false);
    expect(atFreeze!.frozen, "the calibration must freeze the whole pose").toBe(true);

    await page.waitForTimeout(2_000);
    const during = await pose();
    expect(during!.yaw, "a frozen orbit must not advance").toBe(atFreeze!.yaw);
    // The listener's POSITION must not move either — the entrance dolly and the drift
    // both change the direction a fixed world source is heard from.
    expect(during!.pos.x).toBe(atFreeze!.pos.x);
    expect(during!.pos.y).toBe(atFreeze!.pos.y);
    expect(during!.pos.z).toBe(atFreeze!.pos.z);
    expect(during!.fwd.x).toBe(atFreeze!.fwd.x);
    expect(during!.fwd.y).toBe(atFreeze!.fwd.y);
    expect(during!.fwd.z).toBe(atFreeze!.fwd.z);

    await page.evaluate(() => window.__sok!.endA4Calibration?.());
    await page.waitForTimeout(400);
    const after = await pose();
    expect(after!.enabled, "ending the calibration must restore the orbit").toBe(true);
    expect(after!.frozen, "ending the calibration must release the pose").toBe(false);
    expect(
      after!.yaw,
      "a restored orbit must actually resume advancing",
    ).toBeGreaterThan(during!.yaw);
  });
});
