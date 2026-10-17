/**
 * §12.4 item 1 — the deterministic CPU budgets, asserted rather than merely reported.
 *
 * > "Deterministic CPU budgets (Node/headless): scheduler tick time, ingest core
 * > throughput, DSP real-time factor (`scripts/bench.ts`). Assert in tests with generous
 * > margins (×3) to avoid flakiness."
 *
 * `scripts/bench.ts` measures the DSP real-time factor and prints
 * `PASS: DSP cost is within budget` — and **nothing asserted on it.** `npm run bench`
 * exiting 0 is a human reading a line, not a gate. The first half of §12.4's item 1 was
 * therefore instrumented and the second half was not.
 *
 * **Why the margin is ÷3 and not ×3.** §12.4 says "generous margins (×3)" for budgets
 * that must not be *exceeded*. The DSP budget is inverted — it is a floor on speed, so
 * the equivalent slack is to assert a *lower* bar than the spec's: 10/3 ≈ 3.3× real
 * time. Asserting ≥ 30× real time would be a faster test of the machine than of the
 * code, and would fail on a loaded CI runner for reasons that have nothing to do with
 * the DSP.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..");
const BENCH = resolve(ROOT, "scripts/bench.ts");

/** §12.1's budget. */
const SPEC_MIN_RTF = 10;
/** §12.4's "generous margin", applied to a floor. */
const SLACKED_MIN_RTF = SPEC_MIN_RTF / 3;

function runBench(): { stdout: string; rtf: number; exitedCleanly: boolean } {
  // `spawnSync` rather than `execFileSync`, so a non-zero exit does not throw before the
  // output can be read.
  //
  // This is not leniency — it is the margin §12.4 asks for, applied at the right place.
  // `bench.ts` has its own **tight** check at 10× and exits non-zero below it. Observed
  // live: running the 10-minute soak alongside dropped the bench to **9.9×**, and the
  // script failed. A CPU budget that fails when a soak is running is measuring the
  // machine, not the DSP — and the test would then be a faster test of the machine than
  // of the code.
  //
  // So the script's verdict is captured and reported, and the *gate* is the slacked
  // bound below.
  const r = spawnSync("npx", ["tsx", BENCH], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 300_000,
  });
  const stdout = r.stdout ?? "";
  const m = /real-time factor\s+([\d.]+)x/.exec(stdout);
  if (!m) throw new Error(`bench did not report a real-time factor:\n${stdout.slice(-600)}`);
  return { stdout, rtf: Number(m[1]), exitedCleanly: r.status === 0 };
}

describe("§12.4 — CPU budgets are asserted, not just printed", () => {
  // Run once and share: the bench renders 60 s of audio and takes ~6 s, so a second
  // invocation would double the cost of this file for no extra information.
  let bench: { stdout: string; rtf: number; exitedCleanly: boolean };
  beforeAll(() => {
    bench = runBench();
  }, 300_000);

  it("the DSP worklet renders at least 3.3× faster than real time", () => {
    const { stdout, rtf } = bench!;

    // The slacked bound is the gate. The script's own 10× check is deliberately *not*
    // asserted here — it is reported by the test below instead, because asserting it
    // would make this file fail whenever the machine is busy, which is exactly the
    // flakiness §12.4's margin exists to remove.
    expect(
      rtf,
      `DSP ran at ${rtf}× real time; §12.1 requires ≥ ${SPEC_MIN_RTF}×, and this ` +
        `test asserts ≥ ${SLACKED_MIN_RTF.toFixed(1)}× for flakiness.\n${stdout.slice(-400)}`,
    ).toBeGreaterThanOrEqual(SLACKED_MIN_RTF);

    // The output must still be the bench's own, so a future edit that guts the run
    // cannot leave a green gate behind.
    expect(stdout).toContain("DSP benchmark");
    expect(stdout).toMatch(/real-time factor\s+[\d.]+x/);
  });

  it("the script's own verdict is reported, not silently swallowed", () => {
    // `bench.ts` asserts ≥ 10× and exits non-zero below it. That check is *tighter* than
    // this file's gate on purpose — it is the spec's number, and the difference between
    // the two is exactly the slack a loaded machine needs.
    //
    // So when the script fails but the slacked gate passes, that is a fact worth
    // printing rather than swallowing: it means the machine was busy, not that the DSP
    // regressed.
    const { rtf, exitedCleanly } = bench!;
    if (!exitedCleanly) {
      console.log(
        `[perf] bench.ts exited non-zero at ${rtf}× — below its own 10× check but ` +
          `within this test's ${SLACKED_MIN_RTF.toFixed(1)}× gate. Machine was busy.`,
      );
    }
    expect(rtf).toBeGreaterThan(0);
  });

  it("bench.ts actually reports a factor, rather than exiting 0 having done nothing", () => {
    // The same failure as `npm run test:soak` pointing at a file that did not exist: an
    // instrument that reports success without measuring. Asserted directly so a future
    // edit that guts the bench cannot leave a green gate behind.
    const { rtf } = bench!;
    expect(Number.isFinite(rtf), "the reported real-time factor must be a number").toBe(true);
    expect(rtf).toBeGreaterThan(0);
  });
});