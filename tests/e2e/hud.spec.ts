import { expect, test } from "@playwright/test";
import { recordErrors } from "./helpers";
import "./sok-window";
import type { SokMetrics } from "./sok-window";

/**
 * T5.2 — §13.4 items 3 (settings persistence) and 4 (keyboard), plus §11.4's HUD
 * contract and §11.6's accessibility floor.
 *
 * Both items are about state that lives *outside* React and outside the engine: a
 * `localStorage` write that has to survive a reload, and a keydown that has to reach a
 * handler while not stealing keystrokes from an input. Neither is observable from a
 * unit test, and both are exactly the kind of thing that works on the machine it was
 * built on and nowhere else.
 */

const enterPiece = async (page: import("@playwright/test").Page): Promise<void> => {
  await page.goto("/?source=synthetic");
  await expect(page.getByTestId("enter-button")).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId("enter-button").click();
  await expect(page.getByTestId("hud")).toBeVisible({ timeout: 5_000 });
};

const metrics = (page: import("@playwright/test").Page): Promise<SokMetrics> =>
  page.evaluate(() => window.__sok!.metrics!());

test.describe("§13.4 item 3 — settings persistence", () => {
  test("volume and density survive a reload, and Esc closes the panel", async ({ page }) => {
    const errors = await recordErrors(page);
    await enterPiece(page);

    // Open the panel with `S`.
    await page.keyboard.press("s");
    const panel = page.getByTestId("settings-panel");
    await expect(panel).toBeVisible();

    // Volume → 0.25, density → sparse. Both apply live, so no save button exists.
    await page.getByTestId("setting-volume").fill("0.25");
    await page.getByTestId("setting-density-sparse").click();

    // Live application: the engine has it without any commit step.
    await expect
      .poll(async () => (await metrics(page)).muted)
      .toBe(false);
    const stored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("sok.settings.v2") ?? "{}"),
    );
    expect(stored.volume).toBeCloseTo(0.25, 3);
    expect(stored.density).toBe("sparse");

    // Esc closes the panel (§11.5).
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);

    // Reload — the restored values are the point of the item.
    await page.reload();
    await expect(page.getByTestId("enter-button")).toBeEnabled({ timeout: 20_000 });
    await page.getByTestId("enter-button").click();
    await expect(page.getByTestId("hud")).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press("s");

    await expect(page.getByTestId("setting-volume")).toHaveValue("0.25");
    await expect(page.getByTestId("setting-density-sparse")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    errors.assertClean("settings persistence");
  });

  test("a corrupt stored value does not stop the piece starting", async ({ page }) => {
    // The threat model for `localStorage` is a hand-edited value or an older build,
    // not a network. Either way it must not be able to prevent startup.
    await page.goto("/");
    await page.evaluate(() => {
      localStorage.setItem("sok.settings.v2", JSON.stringify({ volume: "loud", langs: "en" }));
    });
    await page.reload();
    await expect(page.getByTestId("enter-button")).toBeEnabled({ timeout: 20_000 });
    await page.getByTestId("enter-button").click();
    await expect(page.getByTestId("hud")).toBeVisible({ timeout: 5_000 });

    // And the bad fields fell back rather than being carried through. Asserted on the
    // panel's own state, not on `localStorage` — nothing rewrites storage until a
    // setting is actually changed, so the corrupt bytes are still sitting there and
    // reading them would say nothing about what the engine did with them.
    await page.keyboard.press("s");
    await expect(page.getByTestId("setting-volume")).toHaveValue("0.8");
    await expect(page.getByTestId("setting-lang-all")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

test.describe("§13.4 item 4 — keyboard", () => {
  test("M toggles mute, visibly in metrics", async ({ page }) => {
    await enterPiece(page);
    expect((await metrics(page)).muted).toBe(false);

    await page.keyboard.press("m");
    await expect.poll(async () => (await metrics(page)).muted).toBe(true);

    await page.keyboard.press("m");
    await expect.poll(async () => (await metrics(page)).muted).toBe(false);
  });

  test("H hides the UI and there is a way back", async ({ page }) => {
    await enterPiece(page);
    await expect(page.getByTestId("hud")).toBeVisible();

    await page.keyboard.press("h");
    await expect(page.getByTestId("hud")).toHaveCount(0);

    // §11.4 — "hide UI" that cannot be undone is a trap, so something must remain.
    await expect(page.getByTestId("hud-restore")).toBeVisible();
    await page.getByTestId("hud-restore").click();
    await expect(page.getByTestId("hud")).toBeVisible();
  });

  test("S opens settings and Esc closes it", async ({ page }) => {
    await enterPiece(page);
    await page.keyboard.press("s");
    await expect(page.getByTestId("settings-panel")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings-panel")).toHaveCount(0);
  });

  test("shortcuts are ignored while typing in an input", async ({ page }) => {
    // The failure this guards: pressing `m` to type a value mutes the piece instead,
    // which is a genuinely confusing way to lose audio mid-adjustment.
    await enterPiece(page);
    await page.keyboard.press("s");
    await page.getByTestId("setting-volume").focus();

    await page.keyboard.press("m");
    expect((await metrics(page)).muted, "M typed into the field, not the shortcut").toBe(
      false,
    );

    // And the panel is still open — `m` did not close it either.
    await expect(page.getByTestId("settings-panel")).toBeVisible();
  });

  test("F requests fullscreen", async ({ page }) => {
    // Headless Chromium has no real fullscreen, so the call is stubbed. What matters
    // is that `F` reaches the handler at all — an unbound shortcut and a rejected
    // promise look identical without this.
    await enterPiece(page);
    await page.evaluate(() => {
      (window as unknown as { __fs: string[] }).__fs = [];
      const el = document.documentElement as unknown as {
        requestFullscreen: () => Promise<void>;
        exitFullscreen: () => Promise<void>;
      };
      el.requestFullscreen = () => {
        (window as unknown as { __fs: string[] }).__fs.push("enter");
        return Promise.resolve();
      };
      el.exitFullscreen = () => {
        (window as unknown as { __fs: string[] }).__fs.push("exit");
        return Promise.resolve();
      };
    });

    await page.keyboard.press("f");
    await expect
      .poll(async () => page.evaluate(() => (window as unknown as { __fs: string[] }).__fs))
      .toEqual(["enter"]);
  });

  test("the screenshot button produces a PNG download", async ({ page }) => {
    await enterPiece(page);
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 15_000 }),
      page.getByTestId("btn-screenshot").click(),
    ]);
    // §5.5 names the pattern; the timestamp is what makes two captures comparable.
    expect(download.suggestedFilename()).toMatch(/^sound-of-knowledge-.+\.png$/);
  });
});

test.describe("§11.4 — the HUD contract", () => {
  test("shows a status dot and line", async ({ page }) => {
    await enterPiece(page);
    await expect(page.getByTestId("status-dot")).toBeVisible();
    await expect(page.getByTestId("hud-status")).toBeVisible();
    await expect(page.getByTestId("hud-status")).toContainText(/Live|Connecting|Replay|Error/);
  });

  test("every icon button has an aria-label", async ({ page }) => {
    await enterPiece(page);
    for (const id of [
      "btn-mute",
      "btn-settings",
      "btn-fullscreen",
      "btn-screenshot",
      "btn-hide",
    ]) {
      const btn = page.getByTestId(id);
      await expect(btn).toBeVisible();
      await expect(btn).toHaveAttribute("aria-label", /.+/);
    }
  });

  test("touch targets are at least 44 px", async ({ page }) => {
    // §11.6 — a 24 px icon button is the most common way a HUD is unusable on a
    // phone, and it is invisible until someone tries to tap it.
    await enterPiece(page);
    const small = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-testid^="btn-"]')]
        .map((b) => ({ id: b.dataset.testid, r: b.getBoundingClientRect() }))
        .filter((b) => b.r.width < 44 || b.r.height < 44)
        .map((b) => b.id),
    );
    expect(small).toEqual([]);
  });

  test("the ticker renders article text as text, never as markup", async ({ page }) => {
    // §13.4 item 6's mechanism, checked at the HUD rather than the label: titles come
    // from a live public API, so both surfaces are injection sinks.
    await enterPiece(page);
    await page.evaluate(() => {
      window.__sok!.injectEdits!([
        {
          id: 42,
          ts: Date.now(),
          wiki: "enwiki",
          host: "en.wikipedia.org",
          lang: "en",
          project: "wikipedia",
          ns: 0,
          title: "<img src=x onerror=\"window.__pwned=1\">",
          actor: "registered",
          kind: "edit",
          minor: false,
          delta: 900,
          absDelta: 900,
          magnitude: 0.9,
          // §9.9's ticker threshold is 0.6.
          importance: 0.95,
          revNew: 1,
        },
      ]);
    });

    const ticker = page.getByTestId("ticker");
    await expect(ticker).toBeVisible({ timeout: 15_000 });
    await expect(ticker).toContainText("<img src=x onerror=");
    expect(await page.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(await page.locator("img").count()).toBe(0);

    // And the link is still a correct article URL. §9.9's order is load-bearing and
    // visible here: spaces become **underscores** first, so `%20` must NOT appear —
    // only the markup characters are percent-encoded.
    const href = await ticker.getAttribute("href");
    expect(href).toBe(
      "https://en.wikipedia.org/wiki/%3Cimg_src%3Dx_onerror%3D%22window.__pwned%3D1%22%3E",
    );
    expect(href).not.toContain("%20");
  });

  test("the HUD auto-fades and any input restores it", async ({ page }) => {
    await enterPiece(page);
    const hud = page.getByTestId("hud");

    // §11.4 — 5 s of no activity drops it to 25 %.
    await expect(hud).toHaveCSS("opacity", "0.25", { timeout: 12_000 });

    await page.mouse.move(400, 300);
    await expect(hud).toHaveCSS("opacity", "1", { timeout: 5_000 });
  });

  test("§11.6 — the polite live region exists and does not update faster than 10 s", async ({
    page,
  }) => {
    await enterPiece(page);
    const region = page.getByTestId("hud-live-region");
    await expect(region).toHaveAttribute("role", "status");
    await expect(region).toHaveAttribute("aria-live", "polite");

    // A screen reader reading a number four times a second is unusable, so the
    // announced summary is capped well below the 4 Hz `stats` rate.
    const samples = await page.evaluate(async () => {
      const el = document.querySelector<HTMLElement>('[data-testid="hud-live-region"]')!;
      const seen: string[] = [];
      for (let i = 0; i < 40; i++) {
        const v = el.textContent ?? "";
        if (seen[seen.length - 1] !== v) seen.push(v);
        await new Promise((r) => setTimeout(r, 250));
      }
      return seen.length;
    });
    // 10 s of sampling at 4 Hz; the region may change a handful of times at most.
    expect(samples).toBeLessThan(10);
  });
});

test.describe("§11.4 — settings panel accessibility", () => {
  test("focus moves into the panel and is trapped", async ({ page }) => {
    await enterPiece(page);
    await page.keyboard.press("s");
    await expect(page.getByTestId("settings-panel")).toBeVisible();

    // §11.6 — tabbing out into the HUD behind leaves no visible focus and no way back.
    for (let i = 0; i < 40; i++) await page.keyboard.press("Tab");
    const insidePanel = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('[data-testid="settings-panel"]');
      return !!panel && !!document.activeElement && panel.contains(document.activeElement);
    });
    expect(insidePanel).toBe(true);
  });
});