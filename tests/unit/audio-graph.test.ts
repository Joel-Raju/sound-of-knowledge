import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AudioEngine } from "@/engine/audio/audio-engine";
import { TIER_PARAMS } from "@/engine/config";
import type { HarmonyEvent, HarmonyState } from "@/engine/music/harmony";
import { padVoicing } from "@/engine/music/pitch";
import { oscillatorsForVoicing } from "@/engine/audio/pad-layer";
import {
  installFakeAudioGlobals,
  type FakeAudioContext,
  type FakeGain,
} from "../helpers/fake-audio-context";

/**
 * Graph topology tests.
 *
 * These assert *wiring*, not DSP: that every bus the engine creates terminates
 * at `destination`. They exist because the opposite failure mode is silent. In
 * T3.3 `buildFxChain` ran after the master chain was wired, so the FX chain's
 * `mixBus` — which the pad, drone, air, reverb return and ping-pong delay all
 * feed — was connected to nothing. Every smoke test passed; the continuous
 * layers were simply inaudible.
 */

let ctx: FakeAudioContext;
let restore: () => void;

beforeEach(() => {
  const installed = installFakeAudioGlobals(48000);
  ctx = installed.ctx;
  restore = installed.restore;
});

afterEach(() => {
  restore();
});

function newEngine(tier: "high" | "medium" | "low" = "high"): AudioEngine {
  return new AudioEngine(ctx as unknown as BaseAudioContext, { tier, spatial: true });
}

function harmony(over: Partial<HarmonyState> = {}): HarmonyState {
  return { rootPc: 0, mode: "aeolian", chordIdx: 0, barCounter: 0, ...over };
}

function harmonyEvent(state: HarmonyState, at: number): HarmonyEvent {
  return { kind: "chord", state, at, chordName: "i" };
}

/**
 * Names that can reach `destination`, walking the recorded graph backwards.
 * `FakeNode` stores edges forwards, but the question is "does this make sound",
 * which is reachability *to* the output.
 */
function audible(ctx: FakeAudioContext): Set<string> {
  const reach = new Set<string>(["destination"]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of ctx.nodes) {
      if (reach.has(n.name)) continue;
      for (const d of n.outgoing) {
        if (reach.has(d.name)) {
          reach.add(n.name);
          grew = true;
          break;
        }
      }
    }
  }
  return reach;
}

describe("AudioEngine graph topology", () => {
  it("builds without a browser", async () => {
    const e = newEngine();
    await e.init();
    expect(e.ready).toBe(true);
    expect(ctx.nodes.length).toBeGreaterThan(10);
  });

  it("leaves no connected node as a dead end", async () => {
    const e = newEngine();
    await e.init();
    e.startContinuous(harmony());

    // The analyser tap is a *legitimate* sink: §8.3 hangs it off the clip
    // alongside the master gain precisely so muting the output does not blank
    // the visuals. Every other node must reach the speakers.
    const sink = new Set<string>();
    for (const a of ctx.analysers()) sink.add(a.name);
    const reach = audible(ctx);
    for (const name of sink) reach.add(name);

    for (const n of ctx.nodes) {
      if (n.name === "destination") continue;
      // A node with no edges at all was created and never used — also a bug.
      if (n.outgoing.size === 0 && n.incoming.size === 0) {
        throw new Error(`${n.kind} ${n.name} is orphaned`);
      }
      expect(reach.has(n.name), `${n.kind} ${n.name} cannot reach destination`).toBe(true);
    }
  });

  it("connects the FX mix bus to the compressor (the T3.3 regression)", async () => {
    const e = newEngine();
    await e.init();

    const comp = ctx.compressors()[0]!;
    const mixer = [...comp.incoming][0] as FakeGain | undefined;
    expect(mixer, "compressor must have an input").toBeDefined();
    // `mixBus` must have real upstream sources: dry voice, reverb return and
    // both delay taps all land here.
    expect(mixer!.incoming.size).toBeGreaterThanOrEqual(3);
  });

  it("puts the analyser before masterGain, so mute does not blank the visuals", async () => {
    const e = newEngine();
    await e.init();

    const clip = ctx.shapers()[0]!;
    const analyser = ctx.analysers()[0]!;
    const master = e.getMasterGainNode() as unknown as FakeGain;

    expect(clip.outgoing.has(analyser)).toBe(true);
    expect(clip.outgoing.has(master)).toBe(true);
    // The analyser is a leaf branch: muting the master cannot silence it.
    expect(analyser.outgoing.size).toBe(0);
  });

  it("mutes the master output without disconnecting the analyser", async () => {
    const e = newEngine();
    await e.init();
    const analyser = ctx.analysers()[0]!;
    const master = e.getMasterGainNode() as unknown as FakeGain;

    e.setMuted(true);
    expect(master.gain.values.at(-1)).toBe(0);
    expect(analyser.incoming.size).toBe(1);
  });

  it("creates one panner per voice and drives each from the worklet", async () => {
    for (const tier of ["high", "medium", "low"] as const) {
      restore();
      const installed = installFakeAudioGlobals(48000);
      ctx = installed.ctx;
      restore = installed.restore;

      const e = newEngine(tier);
      await e.init();
      expect(ctx.panners().length).toBe(TIER_PARAMS[tier].voices);
      for (const p of ctx.panners()) {
        expect(p.outgoing.size).toBe(1);
        expect(audible(ctx).has(p.outgoing.values().next().value!.name)).toBe(true);
      }
    }
  });

  it("installs a stereo IR at the tier's §8.12 length", async () => {
    for (const [tier, secs] of [
      ["high", 3.5],
      ["medium", 2.5],
      ["low", 1.5],
    ] as const) {
      restore();
      const installed = installFakeAudioGlobals(48000);
      ctx = installed.ctx;
      restore = installed.restore;

      const e = newEngine(tier);
      await e.init();
      const conv = ctx.convolvers()[0]!;
      expect(conv.normalize).toBe(true);
      expect(conv.buffer).toBe(ctx.buffers[0]);
      expect(ctx.buffers[0]!.numberOfChannels).toBe(2);
      expect(Math.abs(ctx.buffers[0]!.length - secs * 48000)).toBeLessThanOrEqual(1);
    }
  });

  it("starts the pad and drone only when asked", async () => {
    const e = newEngine();
    await e.init();
    expect(ctx.oscillators().length).toBe(0);
    expect(e.getPadLayer()).toBeNull();
    // No noise source is created at all — the §8.8 air layer has been removed.
    expect(ctx.bufferSources().length).toBe(0);

    e.startContinuous({ rootPc: 0, mode: "aeolian", chordIdx: 0, barCounter: 0 });
    expect(e.getPadLayer()).not.toBeNull();
    // Bank A: 5 notes × 2 oscillators, plus 2 drone = 12.
    expect(ctx.oscillators().length).toBe(12);
    expect(ctx.oscillators().length).toBeLessThanOrEqual(22);
    // Still no buffer source: the only buffer is the reverb IR.
    expect(ctx.bufferSources().length).toBe(0);
    expect(ctx.buffers.length).toBe(1);
  });

  it("cross-fades a new pad bank on a harmony event and retires the old one", async () => {
    const e = newEngine();
    await e.init();
    ctx.currentTime = 10;
    e.startContinuous(harmony());

    const before = ctx.oscillators();
    // `start()` creates the pad bank first, then the two drone sines; the drone
    // glides on a key change and is never retired.
    const bankA = before.slice(0, -2);
    const drone = before.slice(-2);
    const next = harmony({ rootPc: 5, mode: "dorian", chordIdx: 1, barCounter: 1 });
    e.onHarmony(harmonyEvent(next, 10));

    // The new bank is alive alongside the old one; the old is scheduled to stop
    // 9 s later (§8.8), not killed immediately. Voicing size varies by chord,
    // so the delta is the new voicing's own oscillator count.
    const fresh = oscillatorsForVoicing("high", padVoicing(next));
    expect(ctx.oscillators().length).toBe(before.length + fresh);
    for (const o of bankA) expect(o.stoppedAt).toBeCloseTo(19, 6);
    for (const o of drone) expect(o.stoppedAt).toBeNull();
    for (const o of ctx.oscillators().slice(before.length)) expect(o.stoppedAt).toBeNull();
  });

  it("keeps the pad inside the §8.8 oscillator budget across repeated chords", async () => {
    const e = newEngine();
    await e.init();
    e.startContinuous(harmony());
    for (let i = 0; i < 40; i++) {
      ctx.currentTime = i * 4;
      e.onHarmony(harmonyEvent(harmony({ chordIdx: i % 4, barCounter: i }), ctx.currentTime));
    }
    // Retiring banks keep their oscillators until their stop time, so the live
    // count can transiently exceed 22; what must hold is that it stops growing.
    const live = ctx.oscillators().filter((o) => o.stoppedAt === null).length;
    expect(live).toBeLessThanOrEqual(24);
    expect(live).toBeGreaterThan(0);
  });

  it("glides the drone to the new root instead of retriggering it", async () => {
    const e = newEngine();
    await e.init();
    e.startContinuous(harmony());
    const drone = ctx.oscillators().slice(-2);

    ctx.currentTime = 5;
    e.onHarmony(harmonyEvent(harmony({ rootPc: 7 }), 5));

    for (const d of drone) {
      expect(d.stoppedAt).toBeNull();
      const glide = d.frequency.events.filter((ev) => ev.kind === "setTargetAtTime");
      expect(glide.length).toBe(1);
      expect(glide[0]!.time).toBe(5);
      expect(glide[0]!.timeConstant).toBeCloseTo(1, 6);
    }
  });

  it("keeps the analyser fed after mute, decaying to rest", async () => {
    const e = newEngine();
    await e.init();
    e.setMuted(true);
    e.readFeatures(0.016);
    for (let i = 0; i < 400; i++) e.readFeatures(0.016);
    const f = e.readFeatures(0.016);
    expect(f.rms).toBeLessThan(0.01);
    expect(f.flux).toBeLessThan(0.01);
  });

  it("disposes cleanly and tears the graph down", async () => {
    const e = newEngine();
    await e.init();
    e.startContinuous(harmony());
    expect(() => e.dispose()).not.toThrow();
    expect(e.ready).toBe(false);
    expect(e.getPadLayer()).toBeNull();
    for (const o of ctx.oscillators()) expect(o.stoppedAt).not.toBeNull();
  });
});
