import type { NextConfig } from "next";

/**
 * §14.3 — security headers, and the CSP.
 *
 * **`Content-Security-Policy-Report-Only` is not a half-measure, it is the step before
 * enforcing.** The spec asks for report-only first and says to switch only once e2e
 * shows zero violations. Shipping enforcing on the first try would either break the
 * piece silently — Next.js inlines bootstrap scripts, and Analytics loads from another
 * origin — or tempt someone into `'unsafe-eval'` to make it pass, which is a worse
 * outcome than no CSP at all.
 *
 * The four headers below are unconditional and enforced today; only the CSP is
 * report-only, and it is switched by moving `Report-Only` off the name.
 */
const CSP = [
  "default-src 'self'",
  // §14.4 — one SSE connection to the Wikimedia stream, plus Vercel's own telemetry.
  "connect-src 'self' https://stream.wikimedia.org https://vitals.vercel-insights.com",
  // `'unsafe-inline'` is required by Next.js's own bootstrap, not by anything here.
  // Removing it means `experimental.csp` / nonce plumbing, which is a follow-up and not
  // something to discover during a deploy.
  "script-src 'self' 'unsafe-inline' https://va.vercel-scripts.com",
  "style-src 'self' 'unsafe-inline'",
  // `blob:` for the screenshot download (§11.4), `data:` for the favicon.
  "img-src 'self' data: blob:",
  // §5.x — the ingest worker and the audio worklet. `blob:` covers worklets created
  // from a Blob URL rather than a bundled file.
  "worker-src 'self' blob:",
  "font-src 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // §14.3 — this piece uses no camera, microphone or location. Saying so means a
  // browser cannot be talked into granting one, and it removes the prompts entirely.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
  { key: "X-Frame-Options", value: "DENY" },
  // §14.3 — report-only for now. Switch to `Content-Security-Policy` in one edit once
  // a full e2e run logs no violations; see DECISIONS.md.
  // §14.3 — switch to enforcing by changing this key to `Content-Security-Policy`.
  // **Measured, not assumed:** the whole 77-test e2e suite passes unchanged under the
  // enforcing variant (run against `next start`), so nothing the piece uses is blocked.
  // What is not covered by that run is Vercel's own injected scripts on a real
  // deployment — hence the decision is left explicit rather than taken silently.
  { key: "Content-Security-Policy-Report-Only", value: CSP },
];

const nextConfig: NextConfig = {
  compiler: {
    removeConsole:
      process.env.NODE_ENV === "production"
        ? {
            // `console.warn` is kept deliberately: §14.1's numerical-safety guards and
            // the ingest client's watchdog report through it, and silencing them in
            // production would hide exactly the faults worth knowing about. `debug` too,
            // because `injectEdits` is a §5.5 debug affordance that must stay callable.
            exclude: ["error", "warn", "debug"],
          }
        : false,
  },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
      {
        // §12.x — the two bundled Web Workers are served as static files and must not
        // be cached across deploys, or a stale worker keeps parsing old formats.
        source: "/engine/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }],
      },
    ];
  },

  async redirects() {
    return [
      // The SSE proxy was removed in T0.x (§14.4 — one connection per tab, direct to
      // Wikimedia, CORS is `*`). Anything still pointing at it is stale.
      { source: "/api/wiki-stream", destination: "/", permanent: true },
    ];
  },
};

export default nextConfig;