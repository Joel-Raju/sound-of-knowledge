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
import { AudioEngine, type FxPart } from "../audio/audio-engine";
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
   * Mute parts of the mix chain before rendering, so a noise source can be
   * isolated by ear. See `AudioEngine.bypassFx` and `scripts/probe-noise.ts`.
   */
  bypass?: readonly FxPart[];
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
  /**
   * §13.4's spatial-correctness numbers — `rightDb − leftDb` for the `pan-right`
   * scenario, and `null` for every other scenario.
   *
   * The spec's criterion is **≥ 6 dB**: a single bell hard to the listener's right must
   * be at least four times as loud on the right channel. Reported rather than asserted
   * here, because the assertion belongs in a test that can fail loudly.
   */
  /**
   * §13.4's spatial-correctness figure — `rightDb − leftDb` for the `pan-right`
   * scenario, and `null` for every other scenario.
   *
   * **§13.4 states the criterion is ≥ 6 dB. It is not reachable here**, and the
   * measurement says why. Chromium's Web Audio `PannerNode` in HRTF mode, for a source
   * at 90° azimuth, measured in this browser:
   *
   * | position set how                       | right − left |
   * |----------------------------------------|--------------|
   * | `positionX.value = 9`                   | **4.94 dB**  |
   * | `positionX.setValueAtTime(9, t=1)`      | **3.39 dB**  |
   * | at the listener's head (default)        | 0.00 dB      |
   *
   * That is physics, not a defect: equal-power panning at 90° is −3 dB, and the HRTF's
   * head shadowing adds roughly 1–2 dB more. A round 6 was not reachable at this angle.
   *
   * The engine currently measures **≈ 0 dB**, which is below even the platform's own
   * 3.39 dB for the identical pattern — so something in the engine's signal path is
   * still unexplained. Ruled out by measurement: the FX chain (`reverb`, `delay`,
   * compressor, soft-clip and HRTF all bypassed — still ≈ 0), the panning model (HRTF,
   * confirmed on the live node), the listener transform (confirmed set to origin facing
   * −Z), and the panner count (16).
   *
   * **This is unresolved and it matters**: it is the mechanism behind checklist items A4
   * ("each sound comes from the direction its comet came from") and B5 (the same, on
   * headphones). Until it is closed, this figure is reported rather than asserted.
   */
  panRightDb: number | null;
}

export interface RenderResult {
  left: Float32Array;
  right: Float32Array;
  report: RenderReport;
}

/** Scheduler tick, §13.3 step 2. */
const TICK_SEC = 0.025;

/**
 * §13.4's `pan-right` scenario constants.
 *
 * `PAN_RADIUS` is §9.1's shell midpoint rather than 1, so the source is at a realistic
 * distance: the Web Audio HRTF is distance-attenuated, and a source *at the listener's
 * head* is degenerate. `PAN_NOTE_WHEN` leaves a second of lead-in so the measurement
 * window is not starting on the note's attack transient.
 */
const PAN_RADIUS = 9;
const PAN_NOTE_WHEN = 1;

/** A fixed, minimal edit — the `pan-right` scenario has no stream. */
const PAN_EDIT: NormalizedEdit = {
  id: 1,
  ts: 0,
  wiki: "enwiki",
  host: "en.wikipedia.org",
  lang: "en",
  project: "wikipedia",
  ns: 0,
  title: "Pan Test",
  actor: "registered",
  kind: "edit",
  minor: false,
  delta: 1,
  absDelta: 1,
  magnitude: 0.5,
  importance: 0.5,
  revNew: 1,
};

/** RMS of one channel over the whole render. */
function rms(ch: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < ch.length; i++) sum += (ch[i] ?? 0) ** 2;
  return Math.sqrt(sum / Math.max(1, ch.length));
}

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
  if (opts.bypass && opts.bypass.length > 0) engine.bypassFx(opts.bypass, true);

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
        return;
      }
      engine.onHarmony(e);
    },
  });

  const steps = Math.round(seconds / TICK_SEC);
  for (let i = 0; i < steps; i++) {
    if (scenario === "pan-right") break;
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

  /**
   * §13.4's `pan-right` scenario — **a single bell, hard to the listener's right.**
   *
   * Spec: "render a test with a single bell at `dir = (1,0,0)` and listener forward
   * `(0,0,−1)`: right-channel RMS must exceed left by ≥ 6 dB (HRTF)".
   *
   * Two things this deliberately is *not*:
   *
   *  - **Not a `notes-only` render of the synthetic stream.** A bell to the right among
   *    fifty other voices, most of them elsewhere, measures the *mix's* stereo field
   *    rather than the panner. It would pass for the wrong reason and fail for a wrong
   *    one. Exactly one note is scheduled.
   *  - **Not routed through the scheduler.** `note.dir` is a unit vector the scheduler
   *    derives from the article's language; the scheduler has no way to say "exactly
   *    +X". The note is built here and handed straight to `engine.trigger`.
   *
   * The pad is not started either. It is centred by construction, and a centred bed
   * under a hard-panned bell is exactly how a 6 dB requirement gets averaged down to
   * something that looks acceptable.
   */
  let panScheduled = false;
  if (scenario === "pan-right") {
    engine.setListener({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
    // One second of lead-in so the render is not starting on the note's attack, and the
    // tail is long enough to measure after the transient.
    now = PAN_NOTE_WHEN;
    panScheduled = engine.trigger({
      when: now,
      voice: "bell",
      midi: 69,
      freq: 440,
      vel: 1,
      dir: { x: 1, y: 0, z: 0 },
      radius: PAN_RADIUS,
      edit: PAN_EDIT,
      flavor: "remove",
      visual: false,
    });
    if (!panScheduled) throw new Error("pan-right: the bell was not allocated a voice slot");  }

  const metrics = scheduler.getMetrics();

  // --- handshake, then render ---------------------------------------------
  const node = engine.getWorkletNode();
  if (!node) throw new Error("worklet node missing — AudioEngine.init did not run");
  await waitForSync(node);

  const rendered = await ctx.startRendering();
  const left = rendered.getChannelData(0);
  const right = rendered.getChannelData(1);

  // **Before anything else**: ask the worklet how many notes it had to discard.
  // This is a hard error, not a warning. A note silently dropped from a voice queue
  // is not a mix decision — it is the render no longer describing itself, and every
  // number below it (band shares, loudness, the listener's verdict) would be
  // describing audio that is not what the scheduler produced.
  const overwritten = await engine.overwrittenNotes();
  if (overwritten !== 0) {
    throw new Error(
      `voice worklet dropped ${overwritten} note(s): ` +
        (overwritten < 0
          ? "no reply from the worklet (timeout)"
          : "a slot queue overflowed — WORKLET_QUEUE_CAP is too small for this render") +
        `. ${metrics.notesScheduled} notes were scheduled over ${seconds}s.`,
    );
  }

  const lv = levels(left, right);
  const share = bandShare(toMono(left, right), sr);

  // §13.4 — `rightDb − leftDb`. Computed only for `pan-right`; every other scenario has
  // many sources and no single correct answer.
  const panRightDb =
    scenario === "pan-right" ? 20 * Math.log10(Math.max(1e-12, rms(right)) / Math.max(1e-12, rms(left))) : null;

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
      scheduledNotes: panScheduled ? 1 : metrics.notesScheduled,
      panRightDb,
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
