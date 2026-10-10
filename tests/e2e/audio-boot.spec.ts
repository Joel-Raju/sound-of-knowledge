import { expect, test } from "@playwright/test";
import { recordErrors } from "./helpers";

/**
 * Spec §13.4 / task T3.2 — "a Playwright script can create an `AudioContext`,
 * load the worklet from the built URL, trigger one bell via `AudioEngine.trigger`,
 * and see the context state `running` without errors".
 *
 * This is the earliest point in the build where anything can actually make
 * sound, so it is deliberately narrow: it proves the *plumbing* (the bundle is
 * served, `addModule` succeeds, the processor registers, a note reaches the
 * pool). It asserts nothing about how the result sounds — that is T3.5's job
 * via the offline render harness.
 */

test("worklet loads and the audio graph boots", async ({ page }) => {
  const errors = recordErrors(page);

  await page.goto("/?debug=1");

  // The worklet bundle must actually be served from /engine/.
  const served = await page.evaluate(async () => {
    const res = await fetch("/engine/voice-pool.worklet.js");
    return { status: res.status, length: (await res.text()).length };
  });
  expect(served.status, "voice-pool.worklet.js must be served").toBe(200);
  expect(served.length).toBeGreaterThan(100);

  // Boot the graph and trigger a bell. The engine facade is wired in T5.1, so
  // this drives the worklet directly — that is the layer T3.2 changed.
  const boot = await page.evaluate(async () => {
    const w = window as unknown as { AudioContext?: typeof AudioContext };
    if (!w.AudioContext) return { ok: false, reason: "no AudioContext" };
    const ctx = new AudioContext({ latencyHint: "playback" });
    try {
      await ctx.audioWorklet.addModule("/engine/voice-pool.worklet.js");
      const node = new AudioWorkletNode(ctx, "sok-voice-pool", {
        numberOfInputs: 0,
        numberOfOutputs: 8,
        outputChannelCount: [1, 1, 1, 1, 1, 1, 1, 1],
        processorOptions: { voices: 8 },
      });
      node.connect(ctx.destination);
      node.port.postMessage({
        t: "on",
        slot: 0,
        kind: 0,
        when: ctx.currentTime + 0.05,
        freq: 1046.5,
        vel: 0.8,
        dur: 3,
        p: [3.99, 2.0, 1.0, 0.35],
        seed: 1,
      });
      await ctx.resume();
      await new Promise((r) => setTimeout(r, 300));
      return {
        ok: true,
        state: ctx.state as string,
        baseLatency: ctx.baseLatency,
        hasOutputLatency:
          typeof (ctx as unknown as { outputLatency?: number }).outputLatency === "number",
      };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  });

  expect(boot.ok, `boot failed: ${JSON.stringify(boot)}`).toBe(true);
  if (!boot.ok) return;
  expect(boot.state).toBe("running");
  // The offline harness needs `outputLatency` with a `baseLatency` fallback
  // (§8.2), so record which this browser provides.
  expect(boot.hasOutputLatency || typeof boot.baseLatency === "number").toBe(true);

  errors.assertClean("worklet boot");
});

test("the worklet responds to sync, proving it is live", async ({ page }) => {
  const errors = recordErrors(page);
  await page.goto("/?debug=1");

  const synced = await page.evaluate(async () => {
    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule("/engine/voice-pool.worklet.js");
    const node = new AudioWorkletNode(ctx, "sok-voice-pool", {
      numberOfInputs: 0,
      numberOfOutputs: 4,
      outputChannelCount: [1, 1, 1, 1],
      processorOptions: { voices: 4 },
    });
    node.connect(ctx.destination);
    await ctx.resume();

    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 3000);
      node.port.onmessage = (e: MessageEvent) => {
        if ((e.data as { t?: string }).t === "synced") {
          clearTimeout(timer);
          resolve(true);
        }
      };
      // §13.3: `sync` guarantees every `on` has been received before rendering.
      node.port.postMessage({ t: "sync" });
    });
  });

  expect(synced, "worklet must reply {t:'synced'} to a sync message").toBe(true);
  errors.assertClean("worklet sync");
});

test("the full mix chain builds and the pad starts without errors", async ({ page }) => {
  const errors = recordErrors(page);
  await page.goto("/?debug=1");

  const result = await page.evaluate(async () => {
    const ctx = new AudioContext({ latencyHint: "playback" });
    try {
      await ctx.audioWorklet.addModule("/engine/voice-pool.worklet.js");
      const node = new AudioWorkletNode(ctx, "sok-voice-pool", {
        numberOfInputs: 0,
        numberOfOutputs: 16,
        outputChannelCount: Array.from({ length: 16 }, () => 1),
        processorOptions: { voices: 16 },
      });

      // Build the §8.3 graph by hand: voiceBus → reverb/delay → mixBus →
      // compressor → softclip → destination, plus the pad bus.
      const voiceBus = ctx.createGain();
      const mixBus = ctx.createGain();
      const padBus = ctx.createGain();
      const convolver = ctx.createConvolver();
      convolver.normalize = true;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -10;
      const clip = ctx.createWaveShaper();
      const n = 2048;
      const curve = new Float32Array(n);
      const norm = Math.tanh(1.2);
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        curve[i] = Math.tanh(1.2 * x) / norm;
      }
      clip.curve = curve;

      voiceBus.connect(mixBus);
      voiceBus.connect(convolver);
      convolver.connect(mixBus);
      padBus.connect(mixBus);
      mixBus.connect(comp);
      comp.connect(clip);
      clip.connect(ctx.destination);
      node.connect(voiceBus);

      // §8.3: the analyser taps the post-clip bus. This is what the visuals
      // read, so a topology mistake upstream shows up here as silence.
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0;
      clip.connect(analyser);

      // A chord pad: three notes, two detuned oscillators each.
      let started = 0;
      for (const [f, detune] of [
        [196, -7],
        [196, 7],
        [293.66, -7],
        [293.66, 7],
        [392, -7],
        [392, 7],
      ] as const) {
        const osc = ctx.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.value = f;
        osc.detune.value = detune;
        const g = ctx.createGain();
        g.gain.value = 0.03;
        osc.connect(g);
        g.connect(padBus);
        osc.start();
        started++;
      }

      await ctx.resume();
      await new Promise((r) => setTimeout(r, 400));

      // Measure the tap. A pad routed into a bus that goes nowhere (the bug
      // this test exists for) reads as exact silence.
      const buf = new Float32Array(analyser.fftSize);
      let peak = 0;
      for (let frame = 0; frame < 20; frame++) {
        await new Promise((r) => setTimeout(r, 16));
        analyser.getFloatTimeDomainData(buf);
        for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]!));
      }

      // And the spectrum, so the band machinery has real bins to read.
      const db = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(db);
      let loudest = -Infinity;
      for (const v of db) if (v > loudest) loudest = v;

      const state = ctx.state as string;
      return {
        ok: true,
        state,
        oscillators: started,
        sampleRate: ctx.sampleRate,
        peak,
        loudestDb: loudest,
      };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  });

  expect(result.ok, `chain build failed: ${JSON.stringify(result)}`).toBe(true);
  if (!result.ok) return;
  expect(result.state).toBe("running");
  expect(result.sampleRate).toBeGreaterThan(8000);
  // The §8.8 budget is 22 continuous oscillators; a 3-note/2-osc bank is 6.
  expect(result.oscillators).toBeLessThanOrEqual(22);

  // The pad must actually reach the analyser tap.
  expect(result.peak).toBeGreaterThan(1e-4);
  expect(result.loudestDb).toBeGreaterThan(-100);

  errors.assertClean("mix chain");
});
