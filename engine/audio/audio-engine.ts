/**
 * Audio engine. Spec §8.1–§8.3, §8.9, §8.11, §8.13.
 *
 * Owns the Web Audio graph; the DSP itself lives in the worklet. Takes a
 * `BaseAudioContext` rather than an `AudioContext`, which is what lets the
 * identical graph run inside an `OfflineAudioContext` for the automated mix
 * verification in §13.3 — that harness is the only "ears" available to an agent.
 */
import {
  COMP_ATTACK,
  COMP_KNEE,
  COMP_RATIO,
  COMP_RELEASE,
  COMP_THRESHOLD_DB,
  DELAY_STEPS_A,
  DELAY_STEPS_B,
  MASTER_FADE_IN_SEC,
  MASTER_DISPOSE_FADE_SEC,
  MUTE_FADE_TC,
  OUTPUT_LATENCY_FALLBACK,
  PANNER_MAX_DISTANCE,
  PANNER_REF_DISTANCE,
  PANNER_ROLLOFF,
  SOFTCLIP_DRIVE,
  SOFTCLIP_POINTS,
  STEP_SEC,
  TIER_PARAMS,
  WORKLET_URL,
  masterGainFor,
} from "../config";
import { VoiceAllocator } from "./allocator";
import { buildFxChain, padDuckAutomation, type FxChain } from "./fx-chain";
import { PadLayer } from "./pad-layer";
import { Analyzer } from "./analyzer";
import type { HarmonyEvent, HarmonyState } from "../music/harmony";
import { buildVoiceParams, type VoiceKind } from "./voice-params";
import { dbToGain } from "../util/math";
import { createAudioFeatures, type AudioFeatures } from "../types";
import type { Tier, Vec3, NoteEvent } from "../types";

/**
 * Fixed IR seed. The reverb is deterministic on purpose (§8.7 notes) so the
 * offline render in §13.3 and the unit tests are reproducible; there is no
 * reason to vary it per session.
 */
const IR_SEED = 0x5eed;

export interface AudioEngineOptions {
  tier: Tier;
  /** default true; live-switchable via setSpatial */
  spatial: boolean;
  /** URL of the bundled worklet */
  workletUrl?: string;
  /** master volume 0..1 */
  volume?: number;
  muted?: boolean;
  debug?: boolean;
  /**
   * Clock for *scheduling*, in seconds. Defaults to `ctx.currentTime`.
   *
   * The offline harness (§13.3) schedules every note up-front and only then
   * calls `startRendering()`, so `ctx.currentTime` is still 0 for the whole
   * scheduling pass. Anything time-dependent — the pad's 1 Hz cutoff/air
   * update, the drone glide, the master fade — must therefore read an
   * injected virtual clock instead, or it collapses to a single event at t=0.
   */
  now?: () => number;
}

/** Minimal listener shape so both `AudioContext` and `OfflineAudioContext` fit. */

export class AudioEngine {
  readonly tier: Tier;
  private readonly ctx: BaseAudioContext;
  private readonly opts: AudioEngineOptions;
  /** Scheduling clock; the virtual one when injected (§13.3), else the context. */
  private readonly now: () => number;

  private node: AudioWorkletNode | null = null;
  private allocator: VoiceAllocator | null = null;

  private panners: PannerNode[] = [];
  private voiceBus: GainNode | null = null;
  private mixBus: GainNode | null = null;
  private masterGain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private features: Analyzer | null = null;
  private comp: DynamicsCompressorNode | null = null;
  private clip: WaveShaperNode | null = null;
  private padDuck: GainNode | null = null;
  private fx: FxChain | null = null;
  private pad: PadLayer | null = null;

  private readonly listenerPos: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly listenerFwd: Vec3 = { x: 0, y: 0, z: -1 };
  private listenerAudioParams: boolean | null = null;

  private volume: number;
  private muted: boolean;
  private spatial: boolean;
  private masterTarget = 1;
  private disposed = false;

  constructor(ctx: BaseAudioContext, opts: AudioEngineOptions) {
    this.ctx = ctx;
    this.tier = opts.tier;
    this.opts = opts;
    this.volume = opts.volume ?? 0.8;
    this.muted = opts.muted ?? false;
    this.spatial = opts.spatial;
    this.now = opts.now ?? (() => this.ctx.currentTime);
  }

  get ready(): boolean {
    return this.node !== null && !this.disposed;
  }

  /** Output latency in seconds, for A/V sync (§8.2). Feature-detected. */
  get outputLatency(): number {
    const anyCtx = this.ctx as unknown as { outputLatency?: number; baseLatency?: number };
    if (typeof anyCtx.outputLatency === "number" && anyCtx.outputLatency > 0)
      return anyCtx.outputLatency;
    if (typeof anyCtx.baseLatency === "number" && anyCtx.baseLatency > 0) return anyCtx.baseLatency;
    return OUTPUT_LATENCY_FALLBACK;
  }

  /**
   * Build the graph. Spec §8.13: context → addModule → nodes → IR/noise →
   * start continuous layers → fade master in.
   *
   * FX that live in the worklet or need more than this task's scope (reverb,
   * delay, pad, air) are added in T3.3; this establishes the spine so the
   * e2e boot test can already load the worklet and trigger a note.
   */
  async init(): Promise<void> {
    const params = TIER_PARAMS[this.tier];
    const ctx = this.ctx;

    // Any AudioContext with an `audioWorklet` supports this; OfflineAudioContext
    // does not, so the offline harness passes a pre-built node instead.
    if (typeof (ctx as unknown as { audioWorklet?: unknown }).audioWorklet !== "undefined") {
      await ctx.audioWorklet.addModule(this.opts.workletUrl ?? WORKLET_URL);
      this.node = new AudioWorkletNode(ctx as unknown as BaseAudioContext, "sok-voice-pool", {
        numberOfInputs: 0,
        numberOfOutputs: params.voices,
        outputChannelCount: Array.from({ length: params.voices }, () => 1),
        processorOptions: { voices: params.voices, debug: this.opts.debug === true },
      });
    } else {
      throw new Error("audioWorklet is unavailable on this context");
    }

    this.allocator = new VoiceAllocator(params.voices);

    // --- FX chain (§8.3) ---------------------------------------------------
    // Built *before* the master chain, because it owns the buses everything
    // else connects to. Wiring the master chain first and rebinding the buses
    // afterwards leaves `fx.mixBus` dangling: the pad, drone, air, reverb
    // return and delay all terminate there.
    this.fx = buildFxChain(ctx, { tier: this.tier, seed: IR_SEED });
    this.voiceBus = this.fx.voiceBus;
    this.mixBus = this.fx.mixBus;
    this.padDuck = this.fx.padDuck;

    // --- Master chain (§8.3) ---------------------------------------------
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = COMP_THRESHOLD_DB;
    this.comp.knee.value = COMP_KNEE;
    this.comp.ratio.value = COMP_RATIO;
    this.comp.attack.value = COMP_ATTACK;
    this.comp.release.value = COMP_RELEASE;

    this.clip = ctx.createWaveShaper();
    this.clip.curve = makeSoftClipCurve(
      SOFTCLIP_POINTS,
      SOFTCLIP_DRIVE,
    ) as Float32Array<ArrayBuffer>;
    this.clip.oversample = "2x";

    this.masterGain = ctx.createGain();
    this.masterTarget = masterGainFor(this.volume) * (this.muted ? 0 : 1);
    this.masterGain.gain.value = 0;

    this.analyser = ctx.createAnalyser();
    this.features = new Analyzer(this.analyser, ctx.sampleRate);

    // §8.3 order: mixBus → compressor → soft clip → {analyser, masterGain}.
    // The analyser taps *before* masterGain so muting the output does not
    // blank the visuals (`LEGACY-NOTES.md` §3.8).
    this.mixBus.connect(this.comp);
    this.comp.connect(this.clip);
    this.clip.connect(this.analyser);
    this.clip.connect(this.masterGain);
    this.masterGain.connect(ctx.destination);

    // --- Per-slot spatial panners (§8.9) ----------------------------------
    // OfflineAudioContext supports PannerNode; if a host ever lacks it the
    // graph still works, just without spatialisation.
    const canPan = typeof ctx.createPanner === "function";
    if (canPan) {
      for (let i = 0; i < params.voices; i++) {
        const p = ctx.createPanner();
        p.panningModel = params.panning;
        p.distanceModel = "inverse";
        p.refDistance = PANNER_REF_DISTANCE;
        p.rolloffFactor = PANNER_ROLLOFF;
        p.maxDistance = PANNER_MAX_DISTANCE;
        p.coneInnerAngle = 360;
        /* was: new PannerC({
          panningModel: params.panning,
          distanceModel: "inverse",
          refDistance: PANNER_REF_DISTANCE,
          rolloffFactor: PANNER_ROLLOFF,
          maxDistance: PANNER_MAX_DISTANCE,
          coneInnerAngle: 360,
        }); */
        p.connect(this.voiceBus);
        this.panners.push(p);
      }
      this.node.connect(this.panners[0]!);
      // The worklet has one output per voice; connect each to its panner.
      for (let i = 1; i < params.voices; i++) this.node.connect(this.panners[i]!);
    } else {
      // No PannerNode (not expected, but keeps the graph functional).
      this.node.connect(this.voiceBus);
    }

    // Fade the master in over 2.5 s (§8.7 / §8.13).
    const now = this.now();
    this.masterGain.gain.setValueAtTime(0, now);
    this.masterGain.gain.linearRampToValueAtTime(this.masterTarget, now + MASTER_FADE_IN_SEC);
  }

  /**
   * Start the continuous layers (pad, drone, air) — spec §8.13. Split from
   * `init` so the offline harness can build the graph without a real
   * oscillator clock, and so the React shell controls when sound begins.
   */
  startContinuous(state: HarmonyState): void {
    if (!this.fx || this.disposed) return;
    this.pad = new PadLayer({
      tier: this.tier,
      padBus: this.fx.padBus,
      droneBus: this.fx.droneBus,
      airBus: this.fx.airBus,
    });
    this.pad.start(state, this.ctx);
  }

  /** Spec §8.8 — react to a harmony event; cross-fades the next pad bank. */
  onHarmony(e: HarmonyEvent): void {
    if (!this.pad) return;
    this.pad.onHarmony(e.state, this.ctx, e.at);
  }

  /** Spec §8.8 — pad cutoff and air gain follow global energy. */
  setEnergy(energy: number): void {
    this.pad?.setEnergy(energy, this.now());
  }

  getPadLayer(): PadLayer | null {
    return this.pad;
  }

  /** Adopt an externally-built worklet node (used by the offline harness). */
  adoptNode(node: AudioWorkletNode, voices: number): void {
    this.node = node;
    this.allocator = new VoiceAllocator(voices);
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  /**
   * The voice-pool worklet node. Exposed so the offline harness (§13.3) can
   * run the `sync` handshake — without awaiting `synced`, `startRendering()`
   * can race the `on` messages and silently drop the first notes.
   */
  getWorkletNode(): AudioWorkletNode | null {
    return this.node;
  }

  /**
   * Spec §8.10 — read the tap and update the shared feature set. Called once
   * per frame by the app loop; the visuals consume `AudioFeatures` directly and
   * never touch the `AnalyserNode` themselves.
   *
   * Returns a stable object (no per-frame allocation) — the renderer must be
   * able to hand it straight to three.js without churning the GC.
   */
  readFeatures(dtSec: number): AudioFeatures {
    return this.features ? this.features.update(dtSec) : createAudioFeatures();
  }

  getMixBus(): GainNode | null {
    return this.mixBus;
  }

  /** Post-softclip, pre-destination master gain — for tests and the debug HUD. */
  getMasterGainNode(): GainNode | null {
    return this.masterGain;
  }

  getPadDuck(): GainNode | null {
    return this.padDuck;
  }

  setPadDuck(g: GainNode): void {
    this.padDuck = g;
  }

  /**
   * Spec §8.11 — trigger one note.
   *
   * Returns false when no voice slot could be allocated, which the scheduler
   * counts as `droppedNotes` and uses to decide whether to fire the visual.
   * Not throwing matters: under a traffic spike allocation failure is normal,
   * not exceptional.
   */
  trigger(note: NoteEvent): boolean {
    const node = this.node;
    const alloc = this.allocator;
    if (!node || !alloc) return false;

    const vp = buildVoiceParams(note);
    const slot = alloc.allocate(vp.kind, note.when, vp.dur, note.edit.importance);
    if (slot < 0) return false;

    const panner = this.panners[slot];
    if (panner) {
      const x = note.dir.x * note.radius;
      const y = note.dir.y * note.radius;
      const z = note.dir.z * note.radius;
      try {
        panner.positionX.setValueAtTime(x, note.when);
        panner.positionY.setValueAtTime(y, note.when);
        panner.positionZ.setValueAtTime(z, note.when);
      } catch {
        // Offline contexts accept these too; guard anyway.
      }
    }

    // A stolen slot must be faded before it is retriggered (§8.5).
    if (alloc.lastWasStolen) {
      node.port.postMessage({ t: "kill", slot, when: note.when });
    }

    node.port.postMessage({
      t: "on",
      slot,
      kind: vp.kind,
      when: note.when,
      freq: note.freq,
      vel: note.vel,
      dur: vp.dur,
      p: Array.from(vp.p),
      seed: note.edit.id,
    });

    // §8.11 step 5 — duck the pad for sub/gong.
    if (vp.kind === 2 || vp.kind === 3) this.duckPad(note.when);
    return true;
  }

  /** Spec §8.7 — `padDuck` automation for sub/gong, from the shared pure helper. */
  duckPad(at: number): void {
    const duck = this.padDuck;
    if (!duck) return;
    const g = duck.gain;
    g.cancelScheduledValues(at);
    for (const [time, value, tc] of padDuckAutomation(at)) {
      g.setTargetAtTime(value, time, tc);
    }
  }

  /**
   * Spec §8.9 — the listener is the camera. Called once per frame.
   *
   * `AudioListener`'s `positionX` AudioParams are feature-detected; Safari
   * <14.3 only has the deprecated `setPosition`/`setOrientation` methods.
   */
  setListener(pos: Vec3, fwd: Vec3): void {
    this.listenerPos.x = pos.x;
    this.listenerPos.y = pos.y;
    this.listenerPos.z = pos.z;
    this.listenerFwd.x = fwd.x;
    this.listenerFwd.y = fwd.y;
    this.listenerFwd.z = fwd.z;

    const l = this.ctx.listener as unknown as {
      positionX?: AudioParam;
      positionY?: AudioParam;
      positionZ?: AudioParam;
      forwardX?: AudioParam;
      forwardY?: AudioParam;
      forwardZ?: AudioParam;
      setPosition?: (x: number, y: number, z: number) => void;
      setOrientation?: (
        fx: number,
        fy: number,
        fz: number,
        ux: number,
        uy: number,
        uz: number,
      ) => void;
    };
    if (this.listenerAudioParams === null) {
      this.listenerAudioParams =
        typeof l.positionX !== "undefined" && typeof l.forwardX !== "undefined";
    }
    try {
      if (this.listenerAudioParams && l.positionX && l.forwardX) {
        const now = this.ctx.currentTime;
        l.positionX.setValueAtTime(pos.x, now);
        l.positionY!.setValueAtTime(pos.y, now);
        l.positionZ!.setValueAtTime(pos.z, now);
        l.forwardX.setValueAtTime(fwd.x, now);
        l.forwardY!.setValueAtTime(fwd.y, now);
        l.forwardZ!.setValueAtTime(fwd.z, now);
      } else {
        l.setPosition?.(pos.x, pos.y, pos.z);
        l.setOrientation?.(fwd.x, fwd.y, fwd.z, 0, 1, 0);
      }
    } catch {
      // Some browsers throw on the deprecated methods once the AudioParams
      // exist; fall back silently rather than breaking the render loop.
    }
  }

  /** Spec §8.12 — the `spatialAudio` setting switches panning model live. */
  setSpatial(on: boolean): void {
    this.spatial = on;
    const model: "HRTF" | "equalpower" = on && this.tier !== "low" ? "HRTF" : "equalpower";
    for (let i = 0; i < this.panners.length; i++) this.panners[i]!.panningModel = model;
  }

  getSpatial(): boolean {
    return this.spatial;
  }

  setVolume(v: number): void {
    this.volume = v < 0 ? 0 : v > 1 ? 1 : v;
    this.applyMasterGain();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.applyMasterGain();
  }

  private applyMasterGain(): void {
    if (!this.masterGain || this.disposed) return;
    const target = masterGainFor(this.volume) * (this.muted ? 0 : 1);
    const now = this.now();
    this.masterGain.gain.setTargetAtTime(target, now, MUTE_FADE_TC);
    this.masterTarget = target;
  }

  getVolume(): number {
    return this.volume;
  }

  isMuted(): boolean {
    return this.muted;
  }

  /** Number of slots the pool has, for the debug overlay (§11.9). */
  get voiceBudget(): number {
    return this.allocator?.size ?? 0;
  }

  activeVoices(at: number): number {
    return this.allocator?.activeAt(at) ?? 0;
  }

  /** Spec §8.13 — ramp to silence, then tear everything down. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const now = this.now();
    try {
      this.masterGain?.gain.cancelScheduledValues(now);
      this.masterGain?.gain.setTargetAtTime(0, now, MASTER_DISPOSE_FADE_SEC / 3);
    } catch {
      /* context may already be closed */
    }
    try {
      this.node?.port.postMessage({ t: "kill", slot: -1, when: now });
      this.node?.disconnect();
    } catch {
      /* already gone */
    }
    for (let i = 0; i < this.panners.length; i++) {
      try {
        this.panners[i]!.connect(this.voiceBus!);
      } catch {
        /* noop */
      }
    }
    this.panners.length = 0;
    this.pad?.dispose();
    this.pad = null;
    this.fx?.dispose();
    this.fx = null;
    this.node = null;
    this.allocator = null;
    // `close()` is on AudioContext and OfflineAudioContext, not on the
    // BaseAudioContext supertype.
    try {
      const closable = this.ctx as unknown as { close?: () => unknown };
      void closable.close?.();
    } catch {
      /* already closed */
    }
  }
}

/**
 * Spec §8.7 — soft clipper curve `tanh(1.2x)/tanh(1.2)` with 2048 points.
 * Built once and cached; the curve is immutable after construction.
 */
export function makeSoftClipCurve(points: number, drive: number): Float32Array {
  const n = points;
  const curve = new Float32Array(n);
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(drive * x) / norm;
  }
  return curve;
}

/** Ping-pong delay times for §8.7, derived from the musical grid. */
export function delayTimes(): [number, number] {
  return [STEP_SEC * DELAY_STEPS_A, STEP_SEC * DELAY_STEPS_B];
}

export { dbToGain };
export type { VoiceKind };
