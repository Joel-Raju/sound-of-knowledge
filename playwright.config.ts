import { defineConfig, devices } from "@playwright/test";

/**
 * Spec §13.4 — Chromium needs these launch args for the whole test suite:
 *  - swiftshader: deterministic software GL, no GPU required in CI
 *  - autoplay: AudioContext may start without a gesture
 *  - precise-memory-info: `performance.memory.usedJSHeapSize` for the soak test
 */
const CHROMIUM_ARGS = [
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--autoplay-policy=no-user-gesture-required",
  "--enable-precise-memory-info",
  "--disable-dev-shm-usage",
  "--no-sandbox",
];

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./artifacts/test-results",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  // Audio/render harnesses are slow; per-test budget is generous.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI
    ? [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]]
    : [["list"]],

  use: {
    baseURL: process.env.SOK_BASE_URL ?? "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    video: "off",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], launchOptions: { args: CHROMIUM_ARGS } },
    },
    {
      // Spec §13.4 item 8 — Firefox/WebKit are smoke-only and non-blocking in CI.
      name: "firefox-smoke",
      grep: /@crossbrowser/,
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit-smoke",
      grep: /@crossbrowser/,
      use: { ...devices["Desktop Safari"] },
    },
  ],

  webServer: {
    command: "npm run build && npm run start -- --port 3000",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
