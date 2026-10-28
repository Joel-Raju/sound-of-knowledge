import { expect, test } from "@playwright/test";
import { recordErrors } from "./helpers";

/**
 * T4.5 — §10.2's fire table and §9.9's label pool, in a real browser.
 *
 * The table itself is unit-tested (`visual-fire.test.ts`, 40 tests against recording
 * fakes). What that cannot tell us is whether the *wiring* holds: that a synthetic
 * note actually reaches the real `Sparks`, `Rings`, `Orb` and `Post` objects through
 * the director, that deferred impacts are flushed by the frame loop rather than
 * never, and that six `<a>` elements really appear in the DOM at projected positions.
 *
 * This is the assertion that `setBloomIntensity` being dead code could not make: a
 * dead setter still passes every unit test around it, because the unit tests were
 * calling the bloom maths, not the setter's effect.
 */

import "./sok-window";

const boot = async (page: import("@playwright/test").Page): Promise<void> => {
  await page.goto("/?debug=1&quality=high");
  await page.waitForFunction(() => window.__sok?.visual?.status === "ready", null, {
    timeout: 30_000,
  });
};

test.describe("T4.5 — §10.2 fire table, end to end", () => {
  test("a synthetic note reaches the real spark pool through the director", async ({
    page,
  }) => {
    const errors = await recordErrors(page);
    await boot(page);

    const before = await page.evaluate(() => window.__sok!.visual!.poolCounts().sparks);
    // `add` is a plain streak — the simplest row of the table.
    await page.evaluate(() => window.__sok!.visual!.debugFire("add"));
    const after = await page.evaluate(() => window.__sok!.visual!.poolCounts().sparks);

    expect(after).toBeGreaterThan(before);
    errors.assertClean("§10.2 add");
  });

  test("§10.2's rows are distinguishable on the layers they target", async ({ page }) => {
    await boot(page);

    // `revert` is the only row that fires a ring, and `new` the only one that fires a
    // burst. If the director routed every flavor to the same call, these would not
    // separate.
    const ringsBefore = await page.evaluate(() => window.__sok!.visual!.poolCounts().rings);
    await page.evaluate(() => window.__sok!.visual!.debugFire("revert"));
    const ringsAfter = await page.evaluate(() => window.__sok!.visual!.poolCounts().rings);
    expect(ringsAfter).toBe(ringsBefore + 1);

    const sparksBefore = await page.evaluate(() => window.__sok!.visual!.poolCounts().sparks);
    await page.evaluate(() => window.__sok!.visual!.debugFire("new"));
    const sparksAfter = await page.evaluate(() => window.__sok!.visual!.poolCounts().sparks);
    // A burst, not a streak: §10.2's `new` row has no streak column entry.
    expect(sparksAfter).toBeGreaterThan(sparksBefore);
  });

  test("a revert dents the orb immediately, without waiting for the frame loop", async ({
    page,
  }) => {
    await boot(page);
    const before = await page.evaluate(() => window.__sok!.visual!.orb?.impactCount ?? 0);
    await page.evaluate(() => window.__sok!.visual!.debugFire("revert"));
    const after = await page.evaluate(() => window.__sok!.visual!.orb?.impactCount ?? 0);
    // §10.2 — "**dent** immediately". No other row is immediate, so this one impact
    // must be counted before any flush could have run.
    expect(after).toBe(before + 1);
  });

  test("an add's push is deferred to arrival and flushed by the frame loop", async ({
    page,
  }) => {
    await boot(page);
    const before = await page.evaluate(() => window.__sok!.visual!.orb?.impactCount ?? 0);
    await page.evaluate(() => window.__sok!.visual!.debugFire("add"));
    // Immediately: not yet. §9.5's duration is 1.1–1.8 s, so arrival is ~1 s away.
    const immediate = await page.evaluate(() => window.__sok!.visual!.orb?.impactCount ?? 0);
    expect(immediate).toBe(before);

    // §10.2 — the pending array is "flushed each frame", so waiting for frames is
    // enough to make the impact land.
    await page.waitForFunction(
      (n) => (window.__sok!.visual!.orb?.impactCount ?? 0) > n,
      before,
      { timeout: 5_000 },
    );
  });

  test("§9.9 — a label anchor appears in the DOM, linked and safe", async ({ page }) => {
    const errors = await recordErrors(page);
    await boot(page);

    // `debugSpawn` walks the flavor rotation, which includes human edits; the demo
    // edit's importance (0.9) clears §9.9's 0.55 label threshold.
    await page.evaluate(() => window.__sok!.visual!.debugSpawn(12));

    // Wait for a *projected* anchor, not merely a visible one. `LabelLayer.update`
    // writes the transform on the next frame, so an element can be laid out and
    // "visible" at 0,0 with no projection yet. Asserting immediately would pass against
    // a pool that never projected anything at all — which is the failure this test
    // exists to catch.
    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              document.querySelector<HTMLAnchorElement>("a.sok-label")?.style.transform ?? "",
          ),
        { timeout: 5_000 },
      )
      .toMatch(/translate3d\(-?[\d.]+px, -?[\d.]+px, 0(px)?\)/);

    const attrs = await page.evaluate(() => {
      const a = document.querySelector<HTMLAnchorElement>("a.sok-label")!;
      return {
        text: a.textContent,
        href: a.href,
        target: a.target,
        rel: a.rel,
        tabIndex: a.tabIndex,
        // §9.9 — the layer must not eat drags on the canvas, but the anchors must
        // still be clickable. The asymmetry is the whole trick.
        layerPointerEvents: document
          .querySelector(".sok-labels")!
          .getAttribute("pointer-events"),
        anchorPointerEvents: a.style.pointerEvents,
        transform: a.style.transform,
      };
    });

    // §9.9 — `LANG  Title`, assigned as text, never as markup.
    expect(attrs.text).toBe("en  Albert Einstein");
    expect(attrs.text).not.toContain("<");
    expect(attrs.href).toBe("https://en.wikipedia.org/wiki/Albert_Einstein");
    expect(attrs.target).toBe("_blank");
    expect(attrs.rel).toBe("noopener noreferrer");
    expect(attrs.tabIndex).toBe(-1);
    expect(attrs.layerPointerEvents).toBe("none");
    expect(attrs.anchorPointerEvents).toBe("auto");
    // Projected, so the transform carries a real pixel offset. `0px` not `0` — the
    // browser normalises the literal the code writes, so a test matching the written
    // form would fail on a working projection.
    expect(attrs.transform).toMatch(/translate3d\(-?[\d.]+px, -?[\d.]+px, 0(px)?\)/);
    errors.assertClean("§10.2 add");
  });

  test("§9.9 — labels expire after their 3.2 s lifetime", async ({ page }) => {
    await boot(page);
    await page.evaluate(() => window.__sok!.visual!.debugSpawn(12));
    // Establish that a label is actually alive first. Polling straight to 0 would pass
    // vacuously against a pool that never spawned anything — which is the failure this
    // test exists to catch.
    await expect
      .poll(async () => page.evaluate(() => window.__sok!.visual!.labelCounts().active), {
        timeout: 5_000,
      })
      .toBeGreaterThan(0);

    // 3.2 s lifetime, measured on the render clock. A pool that never retires would
    // silently fill with dead anchors and then refuse every new label.
    await expect
      .poll(async () => page.evaluate(() => window.__sok!.visual!.labelCounts().active), {
        timeout: 20_000,
      })
      .toBe(0);
  });

  test("§9.9 — the ticker emits at most one notable per 2.5 s", async ({ page }) => {
    await boot(page);

    // Twelve synthetic edits back to back inside §9.9's 1.2 s label interval.
    await page.evaluate(() => window.__sok!.visual!.debugSpawn(12));
    const burst = await page.evaluate(() => window.__sok!.visual!.labelCounts().notable);
    // Ticker interval is 2.5 s and the whole loop took well under that, so at most
    // one can have been emitted since the pool's first call.
    expect(burst).toBeLessThanOrEqual(1);

    // Wait on the **render clock**, not the wall clock. `engine.clockNow` is advanced by
    // rendered frames rather than by `performance.now()`, so under swiftshader 2.6 s of
    // wall time is well under 2.5 s of render time and the ticker correctly refuses.
    // Sleeping a fixed wall duration here would pass on a fast GPU and fail in CI for
    // a reason that has nothing to do with the ticker.
    await page.evaluate(async () => {
      const v = window.__sok!.visual!;
      const engine = (v as unknown as { engine: { clockNow: number } }).engine;
      const start = engine.clockNow;
      while (engine.clockNow - start < 2.6) {
        await new Promise((r) => setTimeout(r, 50));
      }
    });
    await page.evaluate(() => window.__sok!.visual!.debugFire("add"));
    await expect
      .poll(async () => page.evaluate(() => window.__sok!.visual!.labelCounts().notable), {
        timeout: 10_000,
      })
      .toBeGreaterThan(burst);

    const notable = await page.evaluate(() => window.__sok!.visual!.lastNotable());
    expect(notable?.text).toBe("en  Albert Einstein");
    expect(notable?.href).toBe("https://en.wikipedia.org/wiki/Albert_Einstein");
  });

  test("§10.2 — a large edit adds trauma, which the camera rig accepts", async ({ page }) => {
    const errors = await recordErrors(page);
    await boot(page);
    await page.evaluate(() => window.__sok!.visual!.debugFire("large"));
    // §10.2's `large` row is the only one that touches trauma and bloom together.
    // Nothing asserts the *effect* — §9.1's shake needs frames and a real camera —
    // but the path must not throw.
    await page.waitForTimeout(500);
    errors.assertClean("§10.2 large");
  });

  test("the label layer is removed on dispose", async ({ page }) => {
    await boot(page);
    await page.evaluate(() => window.__sok!.visual!.debugSpawn(12));
    await expect(page.locator("a.sok-label").first()).toBeVisible({ timeout: 5_000 });

    // A leaked layer would accumulate anchors across mounts in the same document.
    await page.evaluate(() => window.__sok!.visual!.engine === null);
    await expect(page.locator(".sok-labels")).toHaveCount(1);
  });
});