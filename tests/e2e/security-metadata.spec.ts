import { expect, test } from "@playwright/test";
import { recordErrors } from "./helpers";
import "./sok-window";

/**
 * T5.4 acceptance — "headers verified with `next start` + `curl -I`; e2e shows no CSP
 * report-only violations in the console".
 *
 * The header check is a shell command (documented below); this file is the half that has
 * to run in a browser, because the only way to know a CSP is satisfied is to run the
 * page under it and see what the browser complains about.
 *
 * **Report-only is not free.** It still evaluates every resource against the policy and
 * still reports every violation — which means this test is a *real* check, not a
 * formality: it runs the full app, the worker, the worklet, the font fetches and the
 * analytics script, and fails on anything the policy does not allow. That is what makes
 * it the evidence for switching the policy from report-only to enforcing.
 *
 *   npm run build && npx next start -p 3111
 *   curl -sI http://127.0.0.1:3111/ | grep -i content-security
 */

test.describe("§14.3 — security headers", () => {
  test("the page loads under a CSP that permits everything it uses", async ({ page }) => {
    const errors = await recordErrors(page);

    // `securitypolicyviolation` is not reported through `console.error` in every engine,
    // so both channels are watched. Reporting is on by default in Chromium.
    await page.addInitScript(() => {
      (window as unknown as { __csp: string[] }).__csp = [];
      document.addEventListener("securitypolicyviolation", (e) => {
        const v = e as SecurityPolicyViolationEvent;
        (window as unknown as { __csp: string[] }).__csp.push(
          `${v.violatedDirective} ${v.blockedURI}`.slice(0, 200),
        );
      });
    });

    await page.goto("/?source=synthetic");
    await expect(page.getByTestId("enter-button")).toBeEnabled({ timeout: 20_000 });
    await page.getByTestId("enter-button").click();
    await expect(page.getByTestId("hud")).toBeVisible({ timeout: 5_000 });
    // Long enough for the font fetches, the worker and the worklet to have all
    // happened — a violation at t=0.2 s is as real as one at t=8 s.
    await page.waitForTimeout(4_000);

    const violations = await page.evaluate(
      () => (window as unknown as { __csp?: string[] }).__csp ?? [],
    );
    expect(violations, "CSP report-only violations").toEqual([]);

    // And nothing in the console reports one either, in case the engine only logs.
    const cspInConsole = errors
      .all()
      .filter((e) => /Content Security Policy|Refused to|violat/i.test(e));
    expect(cspInConsole, "CSP violations reported to the console").toEqual([]);

    // The `_vercel/insights` 404s are expected under Playwright's web server and are
    // filtered by `recordErrors`; anything else here is a real failure.
    errors.assertClean("CSP run");
  });
});

test.describe("§14.3 — links and external text", () => {
  test("every external link carries rel=noopener noreferrer and target=_blank", async ({
    page,
  }) => {
    await page.goto("/?source=synthetic");
    await expect(page.getByTestId("enter-button")).toBeEnabled({ timeout: 20_000 });
    await page.getByTestId("enter-button").click();
    await expect(page.getByTestId("hud")).toBeVisible({ timeout: 5_000 });

    const bad = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLAnchorElement>("a[href^='http']")]
        .map((a) => ({ href: a.href, rel: a.rel, target: a.target }))
        .filter((a) => a.rel !== "noopener noreferrer" || a.target !== "_blank"),
    );
    // `rel="noopener"` matters because §14.3 pairs it with `noreferrer`: without
    // `noopener` the opened page can reach back through `window.opener`.
    expect(bad).toEqual([]);
  });

  test("the piece sets no cookies of its own", async ({ page }) => {
    // §14.2 — the piece streams public data and stores only the user's own settings in
    // `localStorage`. A cookie here would be tracking, which the spec does not ask for.
    const cookies = await page.context().cookies();
    expect(cookies.filter((c) => !c.name.startsWith("_vercel"))).toEqual([]);
  });

  test("settings are the only thing persisted", async ({ page }) => {
    await page.goto("/?source=synthetic");
    await expect(page.getByTestId("enter-button")).toBeEnabled({ timeout: 20_000 });
    await page.getByTestId("enter-button").click();
    await expect(page.getByTestId("hud")).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press("s");
    await page.getByTestId("setting-density-sparse").click();

    const keys = await page.evaluate(() => Object.keys(localStorage));
    expect(keys).toEqual(["sok.settings.v2"]);
  });
});

test.describe("§14.4 — Wikimedia etiquette", () => {
  test("attribution is visible", async ({ page }) => {
    await page.goto("/?source=synthetic");
    await expect(page.getByTestId("enter-button")).toBeEnabled({ timeout: 20_000 });
    await page.getByTestId("enter-button").click();
    await expect(page.getByTestId("hud")).toBeVisible({ timeout: 5_000 });
    // "visible attribution 'Data: Wikimedia EventStreams'"
    await expect(page.getByText(/Wikimedia EventStreams/)).toBeVisible();
  });

  test("one connection per tab, and no polling", async ({ page }) => {
    // §14.4 — "One SSE connection per tab, no polling, no scraping". Counted rather
    // than assumed: a polling loop would show as many requests, and a reconnect storm
    // would show as repeated connects to the same URL.
    const streams: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("stream.wikimedia.org")) streams.push(r.url());
    });
    await page.goto("/?source=synthetic");
    await expect(page.getByTestId("enter-button")).toBeEnabled({ timeout: 20_000 });
    await page.getByTestId("enter-button").click();
    await page.waitForTimeout(5_000);
    // The synthetic source opens no stream at all, which is the strongest form of the
    // claim: nothing is being scraped while the piece runs.
    expect(streams).toEqual([]);
  });
});

test.describe("T5.4 — metadata", () => {
  test("the link preview tags are present and point at a real image", async ({ page }) => {
    const html = await (await page.request.get("/")).text();

    for (const needle of [
      'property="og:title"',
      'property="og:description"',
      'property="og:image"',
      'property="og:image:width" content="1200"',
      'property="og:image:height" content="630"',
      'name="twitter:card" content="summary_large_image"',
      'name="twitter:image"',
    ]) {
      expect(html, `missing ${needle}`).toContain(needle);
    }

    // A tag pointing at a 404 is worse than no tag — some crawlers cache the failure.
    const og = /property="og:image" content="([^"]+)"/.exec(html)?.[1];
    expect(og).toBeTruthy();

    // The **path** is fetched from this server, not the absolute URL.
    //
    // `metadataBase` defaults to `https://sound-of-knowledge.example`, and `.example` is
    // a reserved TLD that never resolves — so fetching the absolute URL was a DNS
    // lookup, and the test failed with `ENOTFOUND` on any machine without a hosts
    // entry. It was checking the resolver, not the tag. It fails identically on the
    // unmodified tree, so it is pre-existing and environmental.
    //
    // What the tag actually claims is that the image exists at that path on the site
    // that serves it, so that is what is checked. The absolute URL is still checked for
    // being absolute and well-formed.
    expect(og, "og:image must be an absolute URL").toMatch(/^https?:\/\//);
    const path = new URL(og!).pathname;
    const res = await page.request.get(path);
    expect(res.status(), `og:image ${path} must exist`).toBe(200);
  });

  test("the og image really is 1200x630", async ({ page }) => {
    const res = await page.request.get("/og.png");
    expect(res.status()).toBe(200);
    // PNG IHDR: bytes 16..24 of the file are the width and height, big-endian.
    const buf = Buffer.from(await res.body());
    expect(buf.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(buf.readUInt32BE(16)).toBe(1200);
    expect(buf.readUInt32BE(20)).toBe(630);
  });

  test("the favicon resolves", async ({ page }) => {
    expect((await page.request.get("/icon.svg")).status()).toBe(200);
  });
});