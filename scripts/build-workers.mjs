#!/usr/bin/env node
/**
 * Spec §5.4 — bundles the two Web Platform worker/worklet entries with esbuild
 * into `public/engine/*.js`.
 *
 * Why esbuild rather than the Next bundler: `new Worker()` and
 * `audioWorklet.addModule()` take *URLs*, not modules, and worklets cannot use
 * `import` at all. Emitting standalone classic scripts sidesteps both issues
 * and keeps the worklet free of a runtime dependency graph.
 *
 * Usage:
 *   node scripts/build-workers.mjs           # one-shot
 *   node scripts/build-workers.mjs --watch   # rebuild on change (used by `npm run dev`)
 */
import * as esbuild from "esbuild";
import { mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = resolve(ROOT, "public/engine");

/** Spec §12.1 — worker ≤ 40 KB gzip, worklet ≤ 40 KB gzip. */
const MAX_GZIP_BYTES = 40 * 1024;

const watch = process.argv.includes("--watch");
const dev = watch || process.env.NODE_ENV !== "production";

/** @type {esbuild.BuildOptions} */
const common = {
  bundle: true,
  format: "iife",
  target: "es2020",
  platform: "browser",
  minify: !dev,
  sourcemap: dev ? "inline" : false,
  legalComments: "none",
  logLevel: "silent",
  define: { "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production") },
};

/**
 * The worklet is loaded via `audioWorklet.addModule()`, which parses the file
 * as a *classic script* — `export` statements are a syntax error there.
 * esbuild's IIFE format still emits no top-level exports for our entry files,
 * but the worklet entry must not import anything ESM-shaped at runtime.
 */
const ENTRIES = [
  { in: resolve(ROOT, "engine/ingest/ingest.worker.ts"), out: "ingest.worker.js", label: "worker" },
  {
    in: resolve(ROOT, "engine/audio/voice-pool.worklet.ts"),
    out: "voice-pool.worklet.js",
    label: "worklet",
  },
];

async function gzipSize(file) {
  const buf = await readFile(file);
  return gzipSync(buf).length;
}

async function report(entry) {
  const outFile = resolve(OUT_DIR, entry.out);
  let gz = 0;
  try {
    await stat(outFile);
    gz = await gzipSize(outFile);
  } catch {
    /* not built yet */
  }
  const pct = ((gz / MAX_GZIP_BYTES) * 100).toFixed(0);
  const flag = gz > MAX_GZIP_BYTES ? "  !! OVER 40KB BUDGET" : "";
  console.log(
    `  ${entry.out.padEnd(24)} ${(gz / 1024).toFixed(1).padStart(6)} KB gzip  (${pct}% of budget)${flag}`,
  );
}

async function buildAll() {
  await mkdir(OUT_DIR, { recursive: true });
  await Promise.all(
    ENTRIES.map((e) =>
      esbuild.build({
        ...common,
        entryPoints: [e.in],
        outfile: resolve(OUT_DIR, e.out),
      }),
    ),
  );
  for (const e of ENTRIES) await report(e);
}

if (watch) {
  const ctxs = await Promise.all(
    ENTRIES.map((e) =>
      esbuild.context({
        ...common,
        entryPoints: [e.in],
        outfile: resolve(OUT_DIR, e.out),
        plugins: [
          {
            name: "sok-report",
            setup(b) {
              b.onEnd((result) => {
                if (result.errors.length) {
                  for (const err of result.errors) console.error(`[${e.out}] ${err.text}`);
                  return;
                }
                report(e).catch(() => {});
              });
            },
          },
        ],
      }),
    ),
  );
  await Promise.all(ctxs.map((c) => c.watch()));
  await buildAll();
  console.log("[build-workers] watching for changes…");
} else {
  try {
    await buildAll();
  } catch (err) {
    // Missing entry files are expected before the engine modules exist (T0.2).
    const missing = ENTRIES.filter((e) => !err?.errors?.some((x) => x.text?.includes(e.in)));
    if (missing.length === ENTRIES.length) {
      console.log("[build-workers] no entry files yet — nothing to build");
      process.exit(0);
    }
    console.error(err?.errors ?? err);
    process.exit(1);
  }
}
