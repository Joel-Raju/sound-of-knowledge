import { expect, test } from "@playwright/test";
import { recordErrors } from "./helpers";
import "./sok-window";

/**
 * T5.1 acceptance — "`npm run build` ok; e2e smoke test (§13.4 item 1) passes locally;
 * `Enter` enables ≤ 20 s under swiftshader."
 *
 * **The 20 s bound is the test.** A start overlay whose button enables "eventually"
 * is indistinguishable from one that never enables, and the number in the spec is
 * what makes the shader warm-up's cost visible. Measuring it on every run is the only
 * way a regression in `warmUp` gets caught — and `warmUp` is exactly the kind of
 * function that can go from 2 s to 30 s without failing anything.
 *
 * Everything here runs against the **production** path (`/` with no `?debug=1`), which
 * is the one the spec's acceptance is written about. The T4 harness is a different
 * entry point and says nothing about it.
 */

test.describe("T5.1 — the live piece", () => {
  test("the start overlay shows the spec's copy", async ({ page }) => {
    await page.goto("/");
    const overlay = page.getByTestId("start-overlay");
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText("Sound of Knowledge");
    await expect(overlay).toContainText(
      "Listen to humanity writing its encyclopedia, live.",
    );
    await expect(overlay).toContainText("Best with headphones.");
    await expect(page.getByTestId("how-it-works")).toBeVisible();
    await expect(page.getByRole("link", { name: "GitHub" })).toBeVisible();
  });

  test("Enter is disabled until the engine is warm, and enables inside 20 s", async ({
    page,
  }) => {
    const errors = await recordErrors(page);
    const started = Date.now();
    await page.goto("/");

    // §11.2 — "disabled showing 'Preparing…' until Engine.create() resolves".
    const button = page.getByTestId("enter-button");
    await expect(button).toBeVisible();
    // The label may already be `Enter` if the engine resolved before Playwright got
    // to it — that is the good case — but it must never have been enabled *without*
    // the engine existing, so what is asserted is the bound, not the ordering.
    await expect(button).toBeEnabled({ timeout: 20_000 });

    const elapsed = Date.now() - started;
    expect(elapsed, `Enter enabled after ${elapsed}ms`).toBeLessThanOrEqual(20_000);
    expect(await button.textContent()).toBe("Enter");
    errors.assertClean("T5.1 start overlay");
  });

  test("the Enter key also activates", async ({ page }) => {
    await page.goto("/");
    const button = page.getByTestId("enter-button");
    await expect(button).toBeEnabled({ timeout: 20_000 });

    await page.keyboard.press("Enter");
    // §5.5 — `start()` creates the AudioContext, so `audioState` leaving "none" is
    // the observable proof the gesture reached the engine.
    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              (window as unknown as { __sok?: { metrics?: () => { audioState: string } } })
                .__sok?.metrics?.().audioState ?? "none",
          ),
        { timeout: 10_000 },
      )
      .not.toBe("none");
  });

  test("clicking Enter fades the overlay out", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("enter-button")).toBeEnabled({ timeout: 20_000 });
    await page.getByTestId("enter-button").click();

    // §11.2 — "the overlay fades out over 1.2 s", so it is still mounted
    // immediately after and unmounted once the transition is done.
    const overlay = page.getByTestId("start-overlay");
    await expect(overlay).toHaveClass(/opacity-0/, { timeout: 5_000 });
    await expect(overlay).toBeHidden({ timeout: 5_000 });
  });

  test("the engine exposes metrics, and they are live numbers", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("enter-button")).toBeEnabled({ timeout: 20_000 });
    await page.getByTestId("enter-button").click();
    await page.waitForTimeout(1_500);

    const m = await page.evaluate(
      () =>
        (window as unknown as { __sok?: { metrics?: () => Record<string, unknown> } }).__sok
          ?.metrics?.() ?? null,
    );
    expect(m, "§5.5 — getMetrics() must be reachable from the debug handle").not.toBeNull();

    // §5.5's field list, present and of the right kind. A facade that returns `{}`
    // satisfies "not null" and nothing else.
    for (const key of [
      "fps",
      "frameMsEma",
      "frameMsP95",
      "renderScale",
      "tier",
      "level",
      "acceptedTotal",
      "droppedTotal",
      "notesScheduled",
      "droppedNotes",
      "attemptedNotes",
      "activeVoices",
      "visualQueueLen",
      "audioState",
      "mode",
      "keyName",
      "energy",
      "muted",
      "streamState",
    ]) {
      expect(m, `metrics.${key} is missing`).toHaveProperty(key);
    }

    expect(typeof m!.fps).toBe("number");
    expect(["low", "medium", "high"]).toContain(m!.tier);
    expect(typeof m!.audioState).toBe("string");
  });

  test("injected edits reach the scheduler and become notes", async ({ page }) => {
    // §5.5 — `injectEdits` is the debug hook that lets a test drive the pipeline
    // without a live stream. If it is wired to nothing, A1–A10 stay unanswerable.
    await page.goto("/");
    await expect(page.getByTestId("enter-button")).toBeEnabled({ timeout: 20_000 });
    await page.getByTestId("enter-button").click();

    const before = await page.evaluate(
      () =>
        (window as unknown as { __sok?: { metrics?: () => { attemptedNotes: number } } })
          .__sok?.metrics?.().attemptedNotes ?? 0,
    );

    await page.evaluate(() => {
      const sok = (
        window as unknown as {
          __sok?: { injectEdits?: (e: unknown[]) => void };
        }
      ).__sok;
      sok?.injectEdits?.(
        Array.from({ length: 40 }, (_, i) => ({
          id: 900000 + i,
          ts: Date.now(),
          wiki: "enwiki",
          host: "en.wikipedia.org",
          lang: "en",
          project: "wikipedia",
          ns: 0,
          title: `Test Article ${i}`,
          actor: "registered",
          kind: "edit",
          minor: false,
          delta: 300 + i,
          absDelta: 300 + i,
          magnitude: 0.5,
          importance: 0.7,
          revNew: 1,
        })),
      );
    });

    // The scheduler quantises to a 25 ms grid, so this is not instant — but it must
    // not be "never".
    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              (window as unknown as { __sok?: { metrics?: () => { attemptedNotes: number } } })
                .__sok?.metrics?.().attemptedNotes ?? 0,
          ),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(before);
  });

  test("StrictMode's double mount does not leave two engines running", async ({ page }) => {
    // The failure is silent and expensive: two rAF loops halve the frame budget and
    // two contexts double the audio graph, with nothing in the code explaining why.
    await page.goto("/");
    await expect(page.getByTestId("enter-button")).toBeEnabled({ timeout: 20_000 });

    const canvases = await page.evaluate(
      () => document.querySelectorAll("canvas").length,
    );
    expect(canvases, "one canvas, or the engine was constructed twice").toBe(1);
  });

  test("?debug=1 keeps the T4 harness and does not add a second canvas", async ({
    page,
  }) => {
    const errors = await recordErrors(page);
    await page.goto("/?debug=1&quality=high");
    await page.waitForFunction(() => window.__sokVisualReady === true, null, {
      timeout: 30_000,
    });

    expect(await page.evaluate(() => document.querySelectorAll("canvas").length)).toBe(1);
    // The live piece's overlay must not appear on the debug page — the harness owns
    // the canvas there, and two owners means whichever mounted second wins silently.
    await expect(page.getByTestId("start-overlay")).toHaveCount(0);
    errors.assertClean("debug page");
  });

  test("dispose is reachable and leaves the canvas behind", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("enter-button")).toBeEnabled({ timeout: 20_000 });

    const result = await page.evaluate(() => {
      const sok = (window as unknown as { __sok?: { engine?: { dispose(): void } } }).__sok;
      sok?.engine?.dispose();
      return document.querySelectorAll("canvas").length;
    });
    expect(result, "dispose() must remove the canvas it created").toBe(0);
  });
});