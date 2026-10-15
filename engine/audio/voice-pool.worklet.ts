// @hot-file — AudioWorkletProcessor entry. Spec §5.3, §8.5.
// Bundled by esbuild to `public/engine/voice-pool.worklet.js` and loaded with
// `ctx.audioWorklet.addModule('/engine/voice-pool.worklet.js')`.
//
// `process()` runs on the audio render thread. It must not allocate, must not
// use Array methods, and must not create closures (spec §1.2). Everything is
// preallocated in the constructor; `port.onmessage` may allocate because it
// runs on the main-thread side of the port.
//
// Design note (spec §8.5): each slot owns **one instance of every voice class**
// (6 × N objects), rather than a single polymorphic voice. That costs a little
// memory and buys the ability to trigger any kind into any slot with no
// allocation and no `instanceof` dispatch in the render loop.

import { Bell } from "./dsp/bell";
import { Pluck } from "./dsp/pluck";
import { Sub } from "./dsp/sub";
import { Gong } from "./dsp/gong";
import { Thud } from "./dsp/thud";
import { Tick } from "./dsp/tick";
import type { Voice } from "./dsp/voice";
import { WORKLET_QUEUE_CAP } from "../config";

// AudioWorklet global-scope types are absent from lib.dom (see the same note in
// `engine/ingest/ingest.worker.ts`).
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
  abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    params: Record<string, Float32Array>,
  ): boolean;
}

declare const registerProcessor: (
  name: string,
  ctor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor,
) => void;
declare const currentFrame: number;
declare const sampleRate: number;

const N_KINDS = 6;
const RENDER_QUANTUM = 128;

/** A scheduled-but-not-yet-started note. Preallocated, one per queue slot. */
interface NoteSpec {
  kind: number;
  startFrame: number;
  freq: number;
  vel: number;
  dur: number;
  seed: number;
  p: Float64Array;
}

function makeSpec(): NoteSpec {
  return { kind: 0, startFrame: 0, freq: 0, vel: 0, dur: 0, seed: 1, p: new Float64Array(8) };
}

class VoicePoolProcessor extends AudioWorkletProcessor {
  private readonly voices: Voice[][];
  private readonly queue: NoteSpec[][];
  private readonly queueLen: Int32Array;
  private readonly active: Uint8Array;
  private readonly activeVoice: Int32Array;
  private readonly voiceStart: Float64Array;
  private readonly activeStartFrame: Float64Array;
  private readonly debug: boolean;
  private statsCounter = 0;
  /**
   * Notes discarded because their slot's queue was full. Surfaced to the harness by
   * the `stats` message so an overflow can never again be silent — that is the
   * failure mode that hid the duration-dependence bug.
   */
  private overwritten = 0;

  constructor(options?: AudioWorkletNodeOptions) {
    super(options);
    const proc = (options?.processorOptions ?? {}) as { voices?: number; debug?: boolean };
    const n = Math.max(1, Math.min(64, proc.voices ?? 16));
    this.debug = proc.debug === true;

    this.voices = [];
    this.queue = [];
    this.queueLen = new Int32Array(n);
    this.active = new Uint8Array(n);
    this.activeVoice = new Int32Array(n);
    this.voiceStart = new Float64Array(n);
    this.activeStartFrame = new Float64Array(n);

    for (let i = 0; i < n; i++) {
      const set: Voice[] = [];
      for (let k = 0; k < N_KINDS; k++) {
        let v: Voice;
        switch (k) {
          case 0:
            v = new Bell();
            break;
          case 1:
            v = new Pluck();
            break;
          case 2:
            v = new Sub();
            break;
          case 3:
            v = new Gong();
            break;
          case 4:
            v = new Thud();
            break;
          default:
            v = new Tick();
            break;
        }
        v.setSampleRate(sampleRate);
        set.push(v);
      }
      this.voices.push(set);

      const q: NoteSpec[] = [];
      for (let j = 0; j < WORKLET_QUEUE_CAP; j++) q.push(makeSpec());
      this.queue.push(q);
    }

    this.port.onmessage = (e: MessageEvent) => this.onMessage(e.data);
  }

  /**
   * Spec §8.5 — `startFrame = max(currentFrame, round(when · sampleRate))`, so a
   * note that arrives late (a stalled tab, a slow main thread) starts
   * immediately rather than being scheduled into the past.
   */
  private onMessage(msg: ToWorklet): void {
    switch (msg.t) {
      case "on": {
        const slot = msg.slot | 0;
        if (slot < 0 || slot >= this.queue.length) return;
        const len = this.queueLen[slot]!;
        // Full: overwrite the oldest. Dropping the newest would leave a gap in
        // the middle of a phrase, which is far more audible.
        //
        // **Counted, and reported.** This branch is where the duration-dependence
        // bug lived: with a cap of 8 and the offline harness posting every note up
        // front, ~80–95 % of notes were overwritten here and the survivors bunched
        // into a swell at the end of the render. Nothing reported it. A silent
        // drop is indistinguishable from a correct one, so it is now a number the
        // harness fails on.
        if (len >= WORKLET_QUEUE_CAP) {
          this.overwritten++;
          const src = this.queue[slot]!;
          const dst = src[0]!;
          for (let j = 1; j < WORKLET_QUEUE_CAP; j++) src[j - 1] = src[j]!;
          src[WORKLET_QUEUE_CAP - 1] = dst;
        }
        const spec = this.queue[slot]![Math.min(len, WORKLET_QUEUE_CAP - 1)]!;
        spec.kind = msg.kind | 0;
        spec.startFrame = Math.max(currentFrame, Math.round(msg.when * sampleRate));
        spec.freq = msg.freq;
        spec.vel = msg.vel;
        spec.dur = msg.dur;
        spec.seed = msg.seed | 0;
        const p = spec.p;
        for (let i = 0; i < p.length; i++) p[i] = msg.p[i] ?? 0;
        if (len < WORKLET_QUEUE_CAP) this.queueLen[slot] = len + 1;
        this.insertSorted(slot);
        break;
      }
      case "kill": {
        const slot = msg.slot | 0;
        if (slot < 0 || slot >= this.queue.length) return;
        if (this.active[slot] === 1) {
          const v = this.voices[slot]![this.activeVoice[slot]!]!;
          const target = Math.max(currentFrame, Math.round(msg.when * sampleRate));
          // Shorten `dur` so the standard 30 ms fade lands on the kill point.
          const elapsed = (target - this.activeStartFrame[slot]!) / sampleRate;
          v.dur = elapsed > 0 ? elapsed : 0;
        }
        break;
      }
      case "sync": {
        // Spec §13.3 — the offline harness posts `sync` and waits for `synced`
        // to guarantee every `on` has been received before rendering starts.
        this.port.postMessage({ t: "synced" });
        break;
      }
      case "stats": {
        // Read *after* rendering, so the count is final. The harness treats a
        // non-zero `overwritten` as a hard failure rather than a warning: a dropped
        // note is not a mix choice, it is the render lying about what it contains.
        this.port.postMessage({ t: "stats", overwritten: this.overwritten });
        break;
      }
    }
  }

  /** Insertion sort by startFrame; messages arrive nearly sorted (spec §8.5). */
  private insertSorted(slot: number): void {
    const q = this.queue[slot]!;
    const len = this.queueLen[slot]!;
    if (len <= 1) return;
    const last = q[len - 1]!;
    let i = len - 1;
    while (i > 0 && q[i - 1]!.startFrame > last.startFrame) {
      q[i] = q[i - 1]!;
      i--;
    }
    q[i] = last;
  }

  /**
   * The render loop. Spec §1.2 / §8.5: no allocation, no Array methods, no
   * closures.
   */
  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    _params: Record<string, Float32Array>,
  ): boolean {
    const startFrame = currentFrame;
    const endFrame = startFrame + RENDER_QUANTUM;

    for (let slot = 0; slot < outputs.length; slot++) {
      const out = outputs[slot];
      if (out === undefined || out.length === 0) continue;
      const ch = out[0];
      if (ch === undefined) continue;

      // Activate any pending note whose start frame has arrived.
      let len = this.queueLen[slot]!;
      while (len > 0) {
        const spec = this.queue[slot]![0]!;
        if (spec.startFrame >= endFrame) break;
        if (this.active[slot] === 0) {
          const kind = spec.kind;
          const v = this.voices[slot]![kind]!;
          v.onStart(spec.freq, spec.vel, spec.dur, spec.p, spec.seed);
          this.active[slot] = 1;
          this.activeVoice[slot] = kind;
          this.activeStartFrame[slot] = spec.startFrame;
          this.voiceStart[slot] = spec.startFrame / sampleRate;
        }
        // Consume the head.
        const src = this.queue[slot]!;
        const dst = src[0]!;
        for (let j = 1; j < len; j++) src[j - 1] = src[j]!;
        src[len - 1] = dst;
        len--;
        this.queueLen[slot] = len;
      }

      if (this.active[slot] === 0) {
        ch.fill(0);
        continue;
      }

      const v = this.voices[slot]![this.activeVoice[slot]!]!;
      const vStart = this.voiceStart[slot]!;
      for (let i = 0; i < RENDER_QUANTUM; i++) {
        const f = startFrame + i;
        ch[i] = v.sample(f / sampleRate - vStart, 1 / sampleRate);
        if (v.active === false) {
          this.active[slot] = 0;
          // Zero the remainder of this quantum so the tail cannot ring out.
          for (let j = i + 1; j < RENDER_QUANTUM; j++) ch[j] = 0;
          break;
        }
      }
    }

    if (this.debug) {
      this.statsCounter++;
      if (this.statsCounter % 375 === 0) {
        let activeCount = 0;
        for (let i = 0; i < this.active.length; i++) activeCount += this.active[i]!;
        this.port.postMessage({ t: "stats", active: activeCount });
      }
    }

    return true;
  }
}

type ToWorklet =
  | {
      t: "on";
      slot: number;
      kind: number;
      when: number;
      freq: number;
      vel: number;
      dur: number;
      p: number[];
      seed: number;
    }
  | { t: "kill"; slot: number; when: number }
  | { t: "sync" }
  | { t: "stats" };

registerProcessor("sok-voice-pool", VoicePoolProcessor);

export {};
