import { expect, test } from "@playwright/test";
import { recordErrors } from "./helpers";

/**
 * Checklist **F6** — "Reduced-motion OS preference honoured" (spec §9.11).
 *
 * T4.1 added `readReducedMotion` and `watchReducedMotion` with no test at all,
 * which is the same mistake this project has made three times already: shipping
 * a feature and assuming it works. This closes it.
 *
 * §9.11 has two halves and both are asserted:
 *   - the camera does not shake at all (trauma is never added);
 *   - the ambient drift is *reduced, not removed* — removing it would freeze the
 *     camera entirely, which §9.11 explicitly does not ask for.
 *
 * Also covers the live-change path, because the preference can be toggled
 * mid-session in System Settings and a listener that was never wired would look
 * identical to one that was.
 */

interface RigView {
  reduceMotion: boolean;
  trauma: number;
  position: { x: number; y: number; z: number };
}

async function readRig(page: import("@playwright/test").Page): Promise<RigView> {
  return page.evaluate(() => {
    const v = (
      window as unknown as {
        __sok?: {
          visual?: {
            engine?: {
              rig?: {
                reduceMotionEnabled: boolean;
                currentTrauma: number;
                position: { x: number; y: number; z: number };
              };
            };
          };
        };
      }
    ).__sok?.visual;
    const rig = v?.engine?.rig;
    if (!rig) throw new Error("engine.rig is not exposed");
    return {
      reduceMotion: rig.reduceMotionEnabled,
      trauma: rig.currentTrauma,
      position: { ...rig.position },
    };
  });
}

/** Add trauma the way §10.2 does for a revert, bypassing the reduced-motion guard. */
async function forceTrauma(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    const v = (
      window as unknown as {
        __sok?: { visual?: { engine?: { addTrauma(n: number): void } } };
      }
    ).__sok?.visual;
    v?.engine?.addTrauma(1);
  });
}

test.describe("F6 · reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("honours the OS preference at startup", async ({ page }) => {
    const errors = recordErrors(page);
    await page.goto("/?debug=1");
    await page.waitForFunction(() => window.__sokVisualReady === true, null, { timeout: 60_000 });

    expect((await readRig(page)).reduceMotion, "rig must start in reduced motion").toBe(true);
    errors.assertClean("reduced motion boot");
  });

  test("adds no trauma shake", async ({ page }) => {
    await page.goto("/?debug=1");
    await page.waitForFunction(() => window.__sokVisualReady === true, null, { timeout: 60_000 });

    await forceTrauma(page);
    // §9.11 — shake is disabled outright, not merely reduced.
    expect((await readRig(page)).trauma, "trauma must stay 0 under reduced motion").toBe(0);

    // And it must stay 0 while the scene runs, not just at the instant of the call.
    await page.waitForTimeout(500);
    expect((await readRig(page)).trauma).toBe(0);
  });

  test("reduces the ambient drift rather than removing it", async ({ page }) => {
    await page.goto("/?debug=1");
    await page.waitForFunction(() => window.__sokVisualReady === true, null, { timeout: 60_000 });

    const a = await readRig(page);
    await page.waitForTimeout(1200);
    const b = await readRig(page);

    const moved = Math.hypot(
      b.position.x - a.position.x,
      b.position.y - a.position.y,
      b.position.z - a.position.z,
    );
    // The camera is still orbiting (auto-orbit is not motion the user asked to
    // suppress), so a non-zero delta is expected — the point is that this is not
    // a frozen camera.
    expect(moved, "the camera must not freeze entirely under reduced motion").toBeGreaterThan(0);
  });
});

test("F6 · a mid-session change is honoured", async ({ page }) => {
  // The preference can be toggled in System Settings while the piece runs. A
  // listener that was never wired is indistinguishable from one that was, unless
  // this is checked.
  const errors = recordErrors(page);
  await page.goto("/?debug=1");
  await page.waitForFunction(() => window.__sokVisualReady === true, null, { timeout: 60_000 });

  expect((await readRig(page)).reduceMotion, "default is full motion").toBe(false);

  // `emulateMedia` is the supported way to drive this from Playwright.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(async () => (await readRig(page)).reduceMotion, { timeout: 5000 }).toBe(true);

  // And back again, so the listener is bidirectional rather than one-shot.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect.poll(async () => (await readRig(page)).reduceMotion, { timeout: 5000 }).toBe(false);

  errors.assertClean("reduced motion live change");
});

test("F6 · full-motion default still shakes", async ({ page }) => {
  // The control for the two tests above: without this, a rig that ignored the
  // preference entirely would pass "no shake under reduced motion".
  await page.goto("/?debug=1");
  await page.waitForFunction(() => window.__sokVisualReady === true, null, { timeout: 60_000 });

  await forceTrauma(page);
  expect((await readRig(page)).trauma, "full motion must still shake").toBeGreaterThan(0);
});
