/**
 * Offline audio render harness — the agent's "ears". Spec §13.3.
 *
 * Renders the **real** production graph (`AudioEngine` + the real worklet +
 * the real `Scheduler`) through an `OfflineAudioContext`, then measures it
 * against §8.4. Every *decision* is deterministic — seeded edits, seeded RNG, a
 * virtual clock and a fixed reverb seed, with the `sync` handshake guaranteeing
 * message ordering — so note timings and voice counts reproduce exactly.
 *
 * Measured dB values still drift by ~0.05 % between runs, because Chromium's
 * offline renderer is not bit-exact across executions. That is far below the
 * tolerance any §8.4 threshold has, but it does mean a report is reproducible,
 * not identical.
 *
 * Deliberately **not** a hand-built approximation of the graph. T3.3 shipped a
 * wiring bug where the FX bus connected to nothing; a harness that rebuilt the
 * graph itself would have kept reporting success. See `DECISIONS.md`.
 */
import { AudioEngine } from "../audio/audio-engine";
import { Scheduler } from "../music/scheduler";
import { SyntheticSource } from "../ingest/synthetic";
import { mulberry32 } from "../util/random";
import { bandShare, levels, toMono, type BandShare, type Levels } from "../audio/mix-analysis";
import type { HarmonyEvent } from "../music/harmony";
import type { NoteEvent, NormalizedEdit } from "../types";

/** Voice kind names as `NoteEvent.voice` spells them (§8.5). */
export type VoiceKindName = NoteEvent["voice"];

export interface RenderOfflineOptions {
  seconds: number;
  seed?: number;
  /** synthetic arrival-rate multiplier */
  rateMul: number;
  sampleRate?: number;
  /**
   * Isolates one layer of the mix. Used to attribute band energy to a source
   * when a §8.4 target is missed — guessing which layer moved a number is how
   * a mix gets tuned in the wrong direction three times.
   *
   * `pan-right` is the §13.4 spatial-correctness scenario (T6.3).
   */
  scenario?: "full" | "notes-only" | "pad-only" | "pan-right";
  /**
   * Force the air layer's energy-1 gain, for the A/B preview only.
   * `null` (default) uses the configured `AIR_GAIN_MIN/MAX` curve.
   */
  airGainMax?: number | null;
}

export interface RenderReport extends Levels {
  seconds: number;
  seed: number;
  rateMul: number;
  sampleRate: number;
  bandShare: BandShare;
  voiceCounts: Record<string, number>;
  attemptedNotes: number;
  droppedNotes: number;
  maxConcurrentVoices: number;
  harmonyTimeline: { kind: string; at: number; mode: string; rootPc: number }[];
  /** Note count, for a sanity check that the render was not silent. */
  scheduledNotes: number;
}

export interface RenderResult {
  left: Float32Array;
  right: Float32Array;
  report: RenderReport;
}

/** Scheduler tick, §13.3 step 2. */
const TICK_SEC = 0.025;

/**
 * Render the full stack offline.
 *
 * The one non-obvious step is the `sync` handshake: the worklet receives `on`
 * messages over a `MessagePort`, which has no ordering guarantee relative to
 * `startRendering()`. Without awaiting `synced`, the first fraction of a second
 * of notes can be missing, and the render is *silently* wrong.
 */
export async function renderOffline(opts: RenderOfflineOptions): Promise<RenderResult> {
  const sr = opts.sampleRate ?? 48000;
  const seconds = opts.seconds;
  const seed = opts.seed ?? 20_261_010;

  const ctx = new OfflineAudioContext(2, Math.round(sr * seconds), sr);

  // The scheduler runs on a virtual clock because every note must be scheduled
  // before `startRendering()`. The engine needs the *same* clock: during the
  // scheduling pass `ctx.currentTime` is still 0, so anything the engine
  // schedules from "now" — the pad's 1 Hz cutoff/air update, the master fade —
  // would otherwise collapse into a single event at t=0 and the render would
  // never exercise the energy-driven behaviour at all.
  let now = 0;

  const engine = new AudioEngine(ctx, { tier: "high", spatial: true, now: () => now });
  await engine.init();

  // --- drive the scheduler on the same virtual clock -----------------------
  let started = false;
  let maxConcurrent = 0;
  const harmonyTimeline: RenderReport["harmonyTimeline"] = [];
  const voiceCounts: Record<string, number> = {};
  const source = new SyntheticSource({ seed, rateMul: opts.rateMul });

  const scenario = opts.scenario ?? "full";

  const scheduler = new Scheduler({
    now: () => now,
    isHidden: () => false,
    rng: mulberry32(seed),
    note: (n: NoteEvent) => {
      if (scenario === "pad-only") return false;
      const ok = engine.trigger(n);
      if (ok) {
        tallyVoices(voiceCounts, n.voice);
        maxConcurrent = Math.max(maxConcurrent, engine.activeVoices(n.when));
      }
      return ok;
    },
    harmony: (e: HarmonyEvent) => {
      if (scenario === "notes-only") return;
      harmonyTimeline.push({ kind: e.kind, at: e.at, mode: e.state.mode, rootPc: e.state.rootPc });
      if (!started) {
        // The pad needs a harmony state before it can start; take the first one
        // the scheduler emits and start the continuous layers there.
        started = true;
        engine.startContinuous(e.state);
        if (opts.airGainMax != null) engine.getPadLayer()?.overrideAirGain(opts.airGainMax, ctx);
        return;
      }
      engine.onHarmony(e);
    },
  });

  const steps = Math.round(seconds / TICK_SEC);
  for (let i = 0; i < steps; i++) {
    const edits: NormalizedEdit[] = source.next(TICK_SEC * 1000);
    if (edits.length > 0) scheduler.onBatch(edits);
    scheduler.onStats({
      accepted: opts.rateMul * 7,
      botAccepted: opts.rateMul * 1.4,
      windowMs: 500,
    });
    now += TICK_SEC;
    scheduler.onTick();
    engine.setEnergy(scheduler.getStats().energy);
  }

  const metrics = scheduler.getMetrics();

  // --- handshake, then render ---------------------------------------------
  const node = engine.getWorkletNode();
  if (!node) throw new Error("worklet node missing — AudioEngine.init did not run");
  await waitForSync(node);

  const rendered = await ctx.startRendering();
  const left = rendered.getChannelData(0);
  const right = rendered.getChannelData(1);

  const lv = levels(left, right);
  const share = bandShare(toMono(left, right), sr);

  return {
    left,
    right,
    report: {
      ...lv,
      seconds,
      seed,
      rateMul: opts.rateMul,
      sampleRate: sr,
      bandShare: share,
      voiceCounts,
      attemptedNotes: metrics.attemptedNotes,
      droppedNotes: metrics.droppedNotes,
      maxConcurrentVoices: maxConcurrent,
      harmonyTimeline,
      scheduledNotes: metrics.notesScheduled,
    },
  };
}

/**
 * §13.3 step 3 — post `sync` and await `synced`, so every `on` message has
 * been received and queued before rendering begins.
 *
 * A timeout is a hard error, not a warning: proceeding without it silently
 * drops the first notes of the render.
 */
function waitForSync(node: AudioWorkletNode, timeoutMs = 5000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("worklet did not reply {t:'synced'} within 5s"));
    }, timeoutMs);
    const onMessage = (e: MessageEvent): void => {
      const data = e.data as { t?: string } | undefined;
      if (data?.t !== "synced") return;
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      node.port.removeEventListener("message", onMessage);
    };
    node.port.addEventListener("message", onMessage);
    node.port.start?.();
    node.port.postMessage({ t: "sync" });
  });
}

/**
 * Per-voice-kind counts (§13.3 `voiceCounts`).
 *
 * A kind with a zero count is not a tuning problem, it is a routing bug — so
 * this is reported per kind rather than as a single total.
 */
function tallyVoices(into: Record<string, number>, kind: VoiceKindName): void {
  into[kind] = (into[kind] ?? 0) + 1;
}
