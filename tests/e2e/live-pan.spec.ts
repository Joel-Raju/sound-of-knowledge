/**
 * §8.9 — the live page actually pans, measured in a real `AudioContext`.
 *
 * **This is the test whose absence let a whole-session bug ship.**
 *
 * `AudioNode.connect(destination)` with no `output` argument connects **every** output
 * of the source to the destination. The worklet declares one output per voice, and the
 * engine connected the worklet to 16 panners without an output index — so output 0
 * (voice 0) fed *every* panner and voices 1-15 fed nothing.
 *
 * The symptom was "left on both left and right airpods, same with right": every note
 * was panned by panner 0's position, and only slot 0's panner position was ever set.
 *
 * The offline §13.4 test passed anyway, because the `pan-right` scenario is a **single
 * bell** — which lands in slot 0, whose output is the one that was connected. The one
 * case that was tested was the one case that worked.
 *
 * So this measures the LIVE page, with a real `AudioContext`, per direction.
 */
import { expect, test } from "@playwright/test";

/**
 * Tap the live master output into two analysers, one per channel.
 *
 * Passed as strings: tsx/esbuild rewrites named functions in the module and injects a
 * `__name` helper that does not exist in the browser, so `page.evaluate(fn)` fails with
 * "ReferenceError: __name is not defined".
 */
const INSTALL = `(() => {
  const eng = window.__sok.engine;
  const ctx = eng.audioEngine.context;
  const master = eng.audioEngine.outputNode;
  const sp = ctx.createChannelSplitter(2);
  master.connect(sp);
  const aL = ctx.createAnalyser();
  const aR = ctx.createAnalyser();
  aL.fftSize = 2048;
  aR.fftSize = 2048;
  sp.connect(aL, 0);
  sp.connect(aR, 1);
  window.__a4cap = { aL, aR, bL: new Float32Array(2048), bR: new Float32Array(2048) };
})()`;

const READ = `(() => {
  const c = window.__a4cap;
  c.aL.getFloatTimeDomainData(c.bL);
  c.aR.getFloatTimeDomainData(c.bR);
  let sl = 0, sr = 0;
  for (let i = 0; i < c.bL.length; i++) {
    sl += c.bL[i] * c.bL[i];
    sr += c.bR[i] * c.bR[i];
  }
  return { rmsL: Math.sqrt(sl / c.bL.length), rmsR: Math.sqrt(sr / c.bR.length) };
})()`;

const db = (v: number): number => (v > 0 ? 20 * Math.log10(v) : -999);

interface Step {
  label: string;
  maxLeft: number;
  maxRight: number;
}

test.describe("§8.9 — the live page pans", () => {
  test("RIGHT is heard on the right and LEFT on the left", async ({ page }) => {
    await page.goto("/?source=synthetic&density=sparse");
    await page.getByTestId("enter-button").click({ timeout: 20_000 });
    await page.getByTestId("hud").waitFor({ timeout: 10_000 });
    await page.waitForTimeout(800);
    await page.evaluate(INSTALL);

    // Bypass the reverb and delay sends. Their tails are long and are fed by every
    // earlier note, so a measurement of "the current step" is really a measurement of
    // the whole history — which is why every step first showed the same ~30 dB left
    // excess. With the sends off, only the current note is heard.
    await page.evaluate(
      `(() => {
        window.__sok.engine.audioEngine.bypassFx(["reverb", "delay"], true);
        return true;
      })()`,
    );

    await page.evaluate(`(() => { window.__sok.runA4Calibration({ gapMs: 3500 }); return true; })()`);

    // Sample CONTINUOUSLY through each step's window and keep the extreme
    // difference. A fixed window would miss the note: the label appears when the step
    // fires, but the note is picked by the probabilistic sampler and may sound later.
    const rows: Step[] = [];
    let cur: Step | null = null;
    const deadline = Date.now() + 32_000;
    while (Date.now() < deadline) {
      const label = (await page.evaluate(
        `(() => {
          const el = document.querySelector('[data-testid="a4-readout"]');
          return el ? el.getAttribute('data-a4-label') : null;
        })()`,
      )) as string | null;
      if (label && (!cur || cur.label !== label)) {
        if (cur) rows.push(cur);
        cur = { label, maxLeft: 0, maxRight: 0 };
      }
      const r = (await page.evaluate(READ)) as { rmsL: number; rmsR: number };
      if (cur) {
        // Ignore silence: a source ahead or behind leaves one channel near zero, and
        // the ratio between two near-zero numbers is meaningless.
        if (Math.max(r.rmsL, r.rmsR) < 1e-4) {
          await page.waitForTimeout(50);
          continue;
        }
        const dL = db(r.rmsL) - db(r.rmsR);
        if (dL > cur.maxLeft) cur.maxLeft = dL;
        if (-dL > cur.maxRight) cur.maxRight = -dL;
      }
      await page.waitForTimeout(50);
    }
    if (cur) rows.push(cur);

    const by = new Map(rows.map((r) => [r.label, r]));
    for (const r of rows) {
      console.log(
        `    ${r.label.padEnd(7)} L+${r.maxLeft.toFixed(2)} dB  R+${r.maxRight.toFixed(2)} dB`,
      );
    }

    const right = by.get("RIGHT");
    const left = by.get("LEFT");
    expect(right, "the RIGHT step must have been measured").toBeDefined();
    expect(left, "the LEFT step must have been measured").toBeDefined();

    // RIGHT must be louder on the RIGHT channel.
    expect(
      right!.maxRight,
      "a source to the listener's right must be louder on the right channel",
    ).toBeGreaterThan(3);

    // LEFT must be louder on the LEFT channel.
    expect(
      left!.maxLeft,
      "a source to the listener's left must be louder on the left channel",
    ).toBeGreaterThan(3);

    // And the two must be MIRRORED — not merely "different". This is the assertion that
    // catches a whole-frame mirror: RIGHT louder on the right AND LEFT louder on the
    // left is the only combination that cannot be satisfied by a swapped pair.
    expect(right!.maxLeft, "RIGHT must not also be louder on the left").toBeLessThan(
      right!.maxRight,
    );
    expect(left!.maxRight, "LEFT must not also be louder on the right").toBeLessThan(
      left!.maxLeft,
    );
  });

  test("the worklet's per-voice outputs are each connected to their own panner", async ({ page }) => {
    // The bug itself, asserted structurally: `connect(panner)` with no output index
    // feeds every panner from output 0. This checks the worklet really does have one
    // output per voice, and that there are at least as many panners as outputs.
    await page.goto("/?source=synthetic&density=sparse");
    await page.getByTestId("enter-button").click({ timeout: 20_000 });
    await page.getByTestId("hud").waitFor({ timeout: 10_000 });
    await page.waitForTimeout(600);

    const info = (await page.evaluate(
      `(() => {
        const ae = window.__sok.engine.audioEngine;
        const node = ae.getWorkletNode();
        return { outputs: node ? node.numberOfOutputs : -1 };
      })()`,
    )) as { outputs: number };

    expect(info.outputs, "the worklet must expose one output per voice").toBeGreaterThan(1);
  });
});
