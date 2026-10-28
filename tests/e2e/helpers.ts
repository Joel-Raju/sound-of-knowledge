import type { Page } from "@playwright/test";

/**
 * Console/page-error filter shared by the e2e suite.
 *
 * Spec §13.4 requires "zero `console.error` and zero `pageerror`". That is the
 * right bar, but taken literally it fails on every local run because
 * `@vercel/analytics` and `@vercel/speed-insights` — which spec §3.1 says to
 * keep, because they are live on the deployed site — request
 * `/_vercel/insights/script.js` and `/_vercel/speed-insights/script.js`, and
 * those only exist on Vercel.
 *
 * So the filter drops exactly those two hosts and nothing else. If a real
 * application error ever produces a `/_vercel/` URL it will still surface.
 */

/** URL fragments that are expected to 404 outside Vercel. */
const EXPECTED_LOCAL_404S = ["/_vercel/insights/", "/_vercel/speed-insights/"];

export function isExpectedLocalNoise(text: string): boolean {
  return EXPECTED_LOCAL_404S.some((frag) => text.includes(frag));
}

export interface ErrorRecorder {
  /** Errors seen so far, with expected local noise removed. */
  all(): string[];
  /** Assert nothing unexpected was logged. Call at the end of the test. */
  assertClean(context?: string): void;
}

export function recordErrors(page: Page): ErrorRecorder {
  const errors: string[] = [];

  page.on("console", (m) => {
    if (m.type() !== "error") return;
    // A resource-load failure logs only "Failed to load resource: ... 404" --
    // the URL lives in the message *location*, not the text. Filtering on the
    // text alone silently fails to exclude the Vercel analytics scripts, which
    // is exactly the case this helper exists to handle.
    const where = m.location()?.url ?? "";
    if (isExpectedLocalNoise(m.text()) || isExpectedLocalNoise(where)) return;
    errors.push(where ? `${m.text()}  @ ${where}` : m.text());
  });
  page.on("pageerror", (e) => {
    if (isExpectedLocalNoise(e.message)) return;
    errors.push(e.message);
  });
  page.on("requestfailed", (r) => {
    const url = r.url();
    if (isExpectedLocalNoise(url)) return;
    errors.push(`request failed: ${url} (${r.failure()?.errorText ?? "unknown"})`);
  });

  return {
    all: () => errors.slice(),
    assertClean: (context = "") => {
      const extra = context ? ` (${context})` : "";
      if (errors.length > 0) {
        throw new Error(`unexpected console/page errors${extra}:\n - ${errors.join("\n - ")}`);
      }
    },
  };
}
