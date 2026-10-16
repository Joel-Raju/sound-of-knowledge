/**
 * §12.1's bundle budgets — enforced, not printed.
 *
 * **Why this exists.** `build-workers.mjs` has always reported these sizes, and until
 * T5.4 that reporting was the only check. It is also what made the budget *look* checked
 * while not being: in `--watch` the script builds unminified with an inlined sourcemap
 * and then compared that against the **production** 40 KB budget, printing
 * `!! OVER 40KB BUDGET (185% of budget)` on a completely healthy tree. The human
 * reported it as a possible problem and it took reading the build options to see that
 * the instrument was measuring the right file against the wrong expectation.
 *
 * So the reporting is now honest, and this test is the part that cannot drift: it runs
 * the **production** build itself and asserts the result, rather than reading whatever
 * the last invocation happened to leave on disk.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..");
const OUT = resolve(ROOT, "public/engine");

/** Spec §12.1 — worker ≤ 40 KB gzip, worklet ≤ 40 KB gzip. */
const MAX_GZIP_BYTES = 40 * 1024;

beforeAll(() => {
  // A real production build, not a read of whatever is on disk. `build:workers` is
  // minified and sourcemap-free regardless of ambient NODE_ENV (see the script's own
  // comment on why), so this is the artefact the budget is a claim about.
  execFileSync("node", [resolve(ROOT, "scripts/build-workers.mjs")], { cwd: ROOT });
}, 60_000);

describe("§12.1 — worker and worklet budgets", () => {
  const entries = [
    { file: "ingest.worker.js", label: "worker" },
    { file: "voice-pool.worklet.js", label: "worklet" },
  ];

  it.each(entries)("$file is within 40 KB gzip", ({ file }) => {
    const gz = gzipSync(readFileSync(resolve(OUT, file))).length;
    expect(
      gz,
      `${file} is ${(gz / 1024).toFixed(1)} KB gzip, ${Math.round(
        (gz / MAX_GZIP_BYTES) * 100,
      )}% of §12.1's budget`,
    ).toBeLessThanOrEqual(MAX_GZIP_BYTES);
  });

  it.each(entries)("$file is actually a classic script, not an ES module", ({ file }) => {
    // `new Worker()` and `audioWorklet.addModule()` both take URLs and parse as
    // classic scripts. A stray `export` in the worklet is a runtime syntax error in
    // every browser, and nothing in the build would catch it.
    const src = readFileSync(resolve(OUT, file), "utf8");
    expect(src).not.toMatch(/^\s*export\s/m);
    expect(src).not.toMatch(/^\s*import\s+[^(]/m);
  });

  it("the artefacts are non-trivial, so the budget is not met by emptying them", () => {
    // The inverse failure: a bundle that satisfies the budget by containing nothing
    // would pass every assertion above.
    for (const { file } of entries) {
      expect(statSync(resolve(OUT, file)).size).toBeGreaterThan(1024);
    }
  });

  it("the worklet carries no source map in a production build", () => {
    // An inlined sourcemap is ~90 % of the dev artefact's size. Its presence in a
    // production build is how a build silently stops being production.
    const src = readFileSync(resolve(OUT, "voice-pool.worklet.js"), "utf8");
    expect(src).not.toContain("sourceMappingURL");
  });
});

describe("§5.4 — the dev build is honest about being a dev build", () => {
  it("watch mode labels its sizes instead of claiming a budget", () => {
    // The exact wording is what stops the next person reading `185% of budget` as a
    // finding, so this asserts on the string rather than on the code shape.
    const src = readFileSync(resolve(ROOT, "scripts/build-workers.mjs"), "utf8");
    expect(src).toContain("§12.1's budget applies to the production build");
  });
});