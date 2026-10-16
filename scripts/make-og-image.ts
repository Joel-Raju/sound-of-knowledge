/**
 * Generate `public/og.png` — §5.4's 1200×630 link-preview image.
 *
 * The spec's first choice is "a screenshot taken with `scripts/shot.ts`", and this is
 * that: the real orb, the real sparks, the real palette. A link preview is the first
 * impression, and an image of the actual piece is worth more than a title card drawn to
 * match it.
 *
 * §5.4 also allows a fallback — "a plain dark gradient with the title if screenshots are
 * unavailable" — and that is implemented **with the same browser**, as a second page
 * render rather than through a canvas library. The obvious `canvas` package is not a
 * dependency and adding a native one for a fallback path that should never run is a bad
 * trade; a browser is already here and can draw anything.
 *
 *   npm run og:image        # against a dev server on :3000
 *   BASE_URL=… npm run og:image
 */
import { chromium, type Browser, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "public/og.png");
const W = 1200;
const H = 630;

/** Capture the live piece: the orb, mid-flight sparks, and a revert's ring. */
async function capture(page: Page, baseUrl: string): Promise<Buffer | null> {
  try {
    // `quality=high` so the orb has real interior structure — at the low tier there is
    // not enough marching resolution for a preview-sized image.
    await page.goto(`${baseUrl}/?debug=1&quality=high&dustAlpha=0.5`);
    await page.waitForFunction(() => window.__sokVisualReady === true, null, { timeout: 60_000 });

    // §10.2's rotation covers every flavor, including the revert ring and the burst.
    await page.evaluate(() => {
      const v = window.__sok?.visual as { debugSpawn?: (n?: number) => void } | undefined;
      v?.debugSpawn?.(14);
    });
    // Long enough for sparks to be mid-flight and the ring to have expanded.
    await page.waitForTimeout(2_500);
    return await page.locator("canvas").screenshot({ type: "png" });
  } catch (err) {
    console.warn(`capture failed (${String(err).slice(0, 120)}); using the title card`);
    return null;
  }
}

/**
 * The fallback: a dark gradient with the title.
 *
 * Backgrounds are the palette's `deep` at L = 0.04 — black, not navy (C6) — so a
 * preview produced by the fallback still looks like the same product as one produced by
 * the capture.
 */
async function titleCard(page: Page): Promise<Buffer> {
  await page.setViewportSize({ width: W, height: H });
  await page.setContent(`<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%}
  body{
    display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;
    background:linear-gradient(180deg,#0b0910 0%,#05050a 100%);
    font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
  }
  h1{margin:0;font-size:64px;font-weight:600;letter-spacing:-0.02em;color:#e8e6ef}
  p{margin:0;font-size:26px;color:#8b8aa0}
</style></head>
<body><h1>Sound of Knowledge</h1><p>Live Wikipedia edits, as sound and light</p></body></html>`);
  return page.screenshot({ type: "png" });
}

async function main(): Promise<void> {
  const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3000";
  const browser: Browser = await chromium.launch({
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  let png: Buffer;
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    png = (await capture(page, baseUrl)) ?? (await titleCard(page));
  } finally {
    await browser.close();
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, png);
  console.log(`wrote ${OUT} (${png.length} bytes, ${W}×${H})`);
}

// `tsx` transpiles this to CJS here, so top-level await is unavailable — hence the
// wrapper rather than the obvious top-level form.
void main();