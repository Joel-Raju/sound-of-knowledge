import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    // Spec §1.1.2 — quality gates must be green after every task.
    reporters: process.env.CI ? ["default", "junit"] : ["default"],
    outputFile: { junit: "artifacts/test-results.xml" },
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html", "json-summary"],
      reportsDirectory: "coverage",
      // Spec §13.2 — targets are per-module, not global.
      thresholds: {
        "./engine/ingest/**": {
          lines: 85,
        },
        "./engine/music/**": {
          lines: 85,
        },
        "./engine/audio/dsp/**": {
          lines: 85,
        },
        "./engine/audio/allocator.ts": {
          lines: 85,
        },
        "./engine/util/**": {
          lines: 85,
        },
      },
    },
  },
});
