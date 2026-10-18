/**
 * The music scheduler. Spec §7.7, §7.8.
 *
 * Turns a stream of raw edits into a musical performance. Three rules make it
 * work (§2.3):
 *  1. **the engine composes, the data conducts** — edits select *which* chord
 *     tone, *when*, and *how loud*; they never choose a pitch outside the
 *     current harmony;
 *  2. **one clock** — everything is expressed in `AudioContext.currentTime`,
 *     quantised to a 16th-note grid;
 *  3. **restraint** — queues are bounded and stale items are dropped, so a
 *     burst of traffic produces a phrase, not a pile-up.
 *
 * Driven by the ingest worker's 25 ms heartbeat rather than a main-thread
 * interval, because browsers throttle `setInterval` to ≥1 Hz in background tabs
 * and audio must keep running when the user switches away (§8.13).
 *
 * Every dependency — clock, visibility, RNG, and the note/harmony sinks — is
 * injected, so the whole thing is testable with no Web Audio at all.
 */
import {
  BIRTH_COOLDOWN_SEC,
  BIRTH_NOTES,
  BIRTH_VEL_SCALE,
  BOT_NORM_REBUILD_THRESHOLD,
  GONG_COOLDOWN_SEC,
  GONG_MAX_CONCURRENT,
  HUMANIZE_SEC,
  LOOKAHEAD_HIDDEN_SEC,
  LOOKAHEAD_SEC,
  MAX_MELODIC_PER_STEP,
  MAX_MELODIC_PER_STEP_LOW_ENERGY,
  MELODIC_LOW_ENERGY,
  MELODIC_LOOKAHEAD_COUNT,
  PERC_STEPS,
  QUEUE_ITEM_MAX_AGE_SEC,
  STEPS_PER_BAR,
  STEP_SEC,
  SUB_MAX_CONCURRENT,
  SUB_MAX_PER_BAR,
  TICK_ROTATE_STRIDE,
  THUD_ROTATE_STRIDE,
  TICK_VEL_BASE,
  TICK_VEL_BOT,
  THUD_VEL_BASE,
  THUD_VEL_BOT,
} from "../config";
import { Harmony, type HarmonyEvent, type HarmonyState } from "./harmony";
import { EnergyTracker } from "./density";
import { route, velocityOf, shouldDoubleAsMelodic } from "./router";
import {
  bellCandidates,
  birthPitches,
  gongPitch,
  pluckCandidates,
  pickPitch,
  subPitch,
} from "./pitch";
import { spatialMapper } from "./spatial-mapper";
import { euclid, rotate } from "./euclid";
import { clamp, gaussianish, lerp } from "../util/math";
import { mulberry32, type Rng } from "../util/random";
import type { NoteEvent, NormalizedEdit, Vec3 } from "../types";

export interface SchedulerDeps {
  /** audio-clock time in seconds */
  now: () => number;
  /** whether the document is hidden (§7.1 widens the lookahead when it is) */
  isHidden: () => boolean;
  rng: Rng;
  /** returns true if a voice slot was actually allocated (§8.11) */
  note: (n: NoteEvent) => boolean;
  harmony: (e: HarmonyEvent) => void;
}

interface Queued {
  edit: NormalizedEdit;
  /** audio time at which this edit entered the queue */
  queuedAt: number;
}

/**
 * Bounded FIFO of edits with age-based eviction.
 *
 * Spec §7.7: "bounded; oldest dropped; items older than 4 s dropped". Stale
 * edits are *discarded, not deferred* — playing a two-second-old edit now
 * sounds wrong, and §6.4 says the same about the sampler.
 */
class Queue {
  private readonly items: Queued[] = [];
  constructor(private readonly capacity: number) {}

  push(edit: NormalizedEdit, now: number): void {
    if (this.items.length >= this.capacity) this.items.shift();
    this.items.push({ edit, queuedAt: now });
  }

  /** Drop entries older than `maxAgeSec`. */
  prune(now: number, maxAgeSec: number): void {
    const cutoff = now - maxAgeSec;
    let i = 0;
    while (i < this.items.length && this.items[i]!.queuedAt < cutoff) i++;
    if (i > 0) this.items.splice(0, i);
  }

  peek(): Queued | undefined {
    return this.items[0];
  }

  /** Highest `importance + 0.1·age` within the first `lookAt` entries (§7.7). */
  pickBest(now: number, lookAt: number): Queued | undefined {
    const n = this.items.length < lookAt ? this.items.length : lookAt;
    if (n === 0) return undefined;
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < n; i++) {
      const q = this.items[i]!;
      const score = q.edit.importance + 0.1 * (now - q.queuedAt);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    return this.items.splice(bestIdx, 1)[0];
  }

  pop(): Queued | undefined {
    return this.items.shift();
  }

  shift(): Queued | undefined {
    return this.items.shift();
  }

  clear(): void {
    this.items.length = 0;
  }

  get length(): number {
    return this.items.length;
  }
}

export interface SchedulerStats {
  chordName: string;
  mode: string;
  keyName: string;
  energy: number;
  botNorm: number;
  stepIndex: number;
  bar: number;
  /** live count of notes in the sub-scheduler's active slots, for the HUD */
  activeSubs: number;
  activeGongs: number;
}

export class Scheduler {
  private readonly energy_ = new EnergyTracker();
  private harmony_: Harmony;

  private nextStepTime = 0;
  private origin = 0;
  private stepIndex = 0;
  private started = false;

  private readonly melodicQ = new Queue(256);
  private readonly subQ = new Queue(32);
  private readonly gongQ = new Queue(16);
  private readonly birthQ = new Queue(16);
  private readonly botQ = new Queue(256);

  private subThisBar = 0;
  private gongCooldownUntil = 0;
  private birthCooldownUntil = 0;

  /** End times of already-scheduled sub/gong notes, for the concurrency caps. */
  private readonly activeSubEnds: number[] = [];
  private readonly activeGongEnds: number[] = [];

  private thudPattern: boolean[] = Array.from({ length: PERC_STEPS }, () => false);
  private tickPattern: boolean[] = Array.from({ length: PERC_STEPS }, () => false);
  private lastBotNorm = -1;

  /** Scratch, reused so `emit` never allocates a direction (§7.9). */
  private readonly scratchDir: Vec3 = { x: 0, y: 0, z: 0 };

  private notesScheduled = 0;
  private droppedNotes = 0;
  private attemptedNotes = 0;

  constructor(private readonly deps: SchedulerDeps) {
    this.harmony_ = new Harmony(deps.rng ?? mulberry32(1));
    this.rebuildPercPatterns();
  }

  /** Feed worker stats to keep the energy curve current (§7.3). */
  onStats(stats: { accepted: number; botAccepted: number; windowMs: number }): void {
    const before = this.energy_.botNorm;
    this.energy_.update(stats);
    // §7.8: regenerate the pattern whenever bot activity shifts materially.
    if (Math.abs(this.energy_.botNorm - before) > BOT_NORM_REBUILD_THRESHOLD) {
      this.rebuildPercPatterns();
    }
  }

  /** Set the density setting (§7.3). */
  setDensity(d: "sparse" | "normal" | "dense"): void {
    this.density = d;
  }
  private density: "sparse" | "normal" | "dense" = "normal";

  /**
   * DEBUG ONLY (A4 calibration) — drop every pending edit without playing it.
   *
   * **Why, measured rather than assumed.** `pickBest` only considers the first
   * `MELODIC_LOOKAHEAD_COUNT` entries, so an edit appended behind whatever was already
   * queued can never be *selected*, and `prune` discards it at 4 s. With live traffic in
   * the queues the A4 calibration lost about half its notes: instrumented with
   * `getA4Fired()`, all six callbacks fired on schedule, but `notesScheduled` rose only 3
   * across the last four. A calibration is meant to be isolated, so anything queued
   * *before* it began is not part of it and has to go.
   */
  drain(): void {
    this.melodicQ.clear();
    this.subQ.clear();
    this.gongQ.clear();
    this.birthQ.clear();
    this.botQ.clear();
  }

  /** Intake: route each incoming edit into its queue (§7.7). */
  onBatch(edits: readonly NormalizedEdit[]): void {
    const now = this.deps.now();
    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i]!;
      switch (route(edit)) {
        case "birth":
          this.birthQ.push(edit, now);
          break;
        case "gong":
          this.gongQ.push(edit, now);
          break;
        case "bot":
          this.botQ.push(edit, now);
          break;
        case "sub":
          this.subQ.push(edit, now);
          // §7.5 step 4: a large edit may *also* play its normal mapping.
          if (shouldDoubleAsMelodic(edit, this.deps.rng)) {
            this.melodicQ.push(edit, now);
          }
          break;
        case "pluck":
        case "bell":
          this.melodicQ.push(edit, now);
          break;
      }
    }
  }

  /**
   * §7.8 — rebuild the Euclidean percussion patterns for the current bot rate.
   *
   * `kThud`/`kTick` interpolate with bot activity, and each phrase the patterns
   * rotate so the groove moves instead of looping. Tick steps that the thud
   * already occupies are cleared, so the two voices never stack.
   */
  private rebuildPercPatterns(): void {
    const botNorm = this.energy_.botNorm;
    this.lastBotNorm = botNorm;
    const phraseIndex = Math.floor(this.stepIndex / STEPS_PER_BAR / 8);

    const kThud = Math.round(lerp(2, 6, botNorm));
    const kTick = Math.round(lerp(3, 11, botNorm));

    this.thudPattern = rotate(
      euclid(kThud, PERC_STEPS),
      (phraseIndex * THUD_ROTATE_STRIDE) % PERC_STEPS,
    );
    this.tickPattern = rotate(
      euclid(kTick, PERC_STEPS),
      (phraseIndex * TICK_ROTATE_STRIDE + 2) % PERC_STEPS,
    );

    for (let i = 0; i < PERC_STEPS; i++) {
      if (this.thudPattern[i]) this.tickPattern[i] = false;
    }
  }

  private prune(now: number): void {
    this.melodicQ.prune(now, QUEUE_ITEM_MAX_AGE_SEC);
    this.subQ.prune(now, QUEUE_ITEM_MAX_AGE_SEC);
    this.gongQ.prune(now, QUEUE_ITEM_MAX_AGE_SEC);
    this.birthQ.prune(now, QUEUE_ITEM_MAX_AGE_SEC);
    this.botQ.prune(now, QUEUE_ITEM_MAX_AGE_SEC);

    // Expire finished concurrent-voice windows.
    for (let i = this.activeSubEnds.length - 1; i >= 0; i--) {
      if (this.activeSubEnds[i]! <= now) this.activeSubEnds.splice(i, 1);
    }
    for (let i = this.activeGongEnds.length - 1; i >= 0; i--) {
      if (this.activeGongEnds[i]! <= now) this.activeGongEnds.splice(i, 1);
    }
  }

  /**
   * The 25 ms heartbeat entry point (§7.7).
   *
   * Recovers from a stall (a hidden tab, a long GC) by resynchronising rather
   * than trying to "catch up" by emitting hundreds of queued steps at once.
   */
  onTick(): void {
    const now = this.deps.now();
    if (!this.started) {
      this.started = true;
      this.nextStepTime = now + 0.05;
      this.origin = this.nextStepTime;
    }

    const lookahead = this.deps.isHidden() ? LOOKAHEAD_HIDDEN_SEC : LOOKAHEAD_SEC;
    if (this.nextStepTime < now) this.nextStepTime = now + 0.05;

    this.prune(now);

    // Bounded so a pathological clock cannot spin here.
    let guard = 0;
    while (this.nextStepTime < now + lookahead && guard < 512) {
      this.scheduleStep(this.stepIndex, this.nextStepTime);
      this.nextStepTime += STEP_SEC;
      this.stepIndex++;
      guard++;
    }
  }

  /** Spec §7.7 `scheduleStep`. */
  private scheduleStep(k: number, T: number): void {
    const stepInBar = k % STEPS_PER_BAR;
    const bar = (k / STEPS_PER_BAR) | 0;

    if (stepInBar === 0) {
      for (const ev of this.harmony_.onBar(bar, this.energy_.E, T)) {
        this.deps.harmony(ev);
      }
      if (bar % 8 === 0) this.rebuildPercPatterns();
    }

    const now = this.deps.now();
    const state = this.harmony_.getState();
    const E = this.energy_.E;

    // ---- 1. Melodic gate, evaluated every step (§7.7) --------------------
    let budget = E < MELODIC_LOW_ENERGY ? MAX_MELODIC_PER_STEP_LOW_ENERGY : MAX_MELODIC_PER_STEP;
    const p = clamp(this.energy_.targetNotesPerSec(this.density) * STEP_SEC, 0, 1);
    while (budget > 0 && this.melodicQ.length > 0 && this.deps.rng() < p) {
      const q = this.melodicQ.pickBest(now, MELODIC_LOOKAHEAD_COUNT);
      if (!q) break;
      this.emitMelodic(q, T + this.humanize(), state);
      budget--;
    }

    // ---- 2. Beat-aligned voices (§7.7) ----------------------------------
    if (stepInBar % 4 === 0) {
      if (
        this.subQ.length > 0 &&
        this.subThisBar < SUB_MAX_PER_BAR &&
        this.activeSubEnds.length < SUB_MAX_CONCURRENT
      ) {
        const q = this.subQ.pop();
        if (q) {
          this.emitSub(q, T, state);
          this.subThisBar++;
        }
      }
      if (
        this.gongQ.length > 0 &&
        T >= this.gongCooldownUntil &&
        this.activeGongEnds.length < GONG_MAX_CONCURRENT
      ) {
        const q = this.gongQ.pop();
        if (q) {
          this.emitGong(q, T, state);
          this.gongCooldownUntil = T + GONG_COOLDOWN_SEC;
        }
      }
    }
    if (stepInBar === 0) this.subThisBar = 0;

    // ---- 3. Birth, on even steps (§7.7) ---------------------------------
    if (stepInBar % 2 === 0 && this.birthQ.length > 0 && T >= this.birthCooldownUntil) {
      const q = this.birthQ.pop();
      if (q) {
        this.emitBirth(q, T, state);
        this.birthCooldownUntil = T + BIRTH_COOLDOWN_SEC;
      }
    }

    // ---- 4. Percussion gate, gated on real bot data (§7.8) ---------------
    if (this.thudPattern[stepInBar] && this.botQ.length > 0) {
      const q = this.botQ.shift();
      if (q) this.emitThud(q, T);
    } else if (this.tickPattern[stepInBar] && this.botQ.length > 0) {
      const q = this.botQ.shift();
      if (q) this.emitTick(q, T);
    }
  }

  private humanize(): number {
    return (this.deps.rng() * 2 - 1) * HUMANIZE_SEC;
  }

  /** Build a `NoteEvent` without allocating a new direction (§7.9). */
  private buildNote(
    when: number,
    voice: NoteEvent["voice"],
    midi: number,
    vel: number,
    edit: NormalizedEdit,
    flavor: NoteEvent["flavor"],
    visual: boolean,
    radius: number,
  ): NoteEvent {
    spatialMapper.placeEdit(edit.wiki, edit.title, edit.id, this.scratchDir);
    return {
      when,
      voice,
      midi,
      freq: midi > 0 ? 440 * Math.pow(2, (midi - 69) / 12) : 0,
      vel,
      dir: { x: this.scratchDir.x, y: this.scratchDir.y, z: this.scratchDir.z },
      radius,
      edit,
      flavor,
      visual,
    };
  }

  private send(note: NoteEvent): boolean {
    this.attemptedNotes++;
    const ok = this.deps.note(note);
    if (ok) this.notesScheduled++;
    else this.droppedNotes++;
    return ok;
  }

  private emitMelodic(q: Queued, when: number, state: HarmonyState): void {
    const e = q.edit;
    const bell = e.delta <= 0;
    const pool = bell ? bellCandidates(state) : pluckCandidates(state);
    if (pool.length === 0) return;
    const midi = pickPitch(pool, e.magnitude, () => gaussianish(this.deps.rng));
    const r = spatialMapper.radiusOf(e.title, e.id);
    this.send(
      this.buildNote(
        when,
        bell ? "bell" : "pluck",
        midi,
        velocityOf(e),
        e,
        bell ? "remove" : "add",
        true,
        r,
      ),
    );
  }

  private emitSub(q: Queued, when: number, state: HarmonyState): void {
    const e = q.edit;
    const midi = subPitch(state);
    const r = spatialMapper.radiusOf(e.title, e.id);
    const dur = 4.0;
    this.activeSubEnds.push(when + dur);
    this.send(this.buildNote(when, "sub", midi, velocityOf(e), e, "large", true, r));
  }

  private emitGong(q: Queued, when: number, state: HarmonyState): void {
    const e = q.edit;
    const midi = gongPitch(state);
    const r = spatialMapper.radiusOf(e.title, e.id);
    this.activeGongEnds.push(when + 9.0);
    this.send(this.buildNote(when, "gong", midi, velocityOf(e), e, "revert", true, r));
  }

  private emitBirth(q: Queued, when: number, state: HarmonyState): void {
    const e = q.edit;
    const pitches = birthPitches(state);
    if (pitches.length === 0) return;
    const r = spatialMapper.radiusOf(e.title, e.id);
    const base = velocityOf(e);
    for (let i = 0; i < BIRTH_NOTES; i++) {
      const midi = pitches[i]!;
      // §7.6: successive 1/16 steps, first note visual only.
      const at = when + i * STEP_SEC;
      const vel = base * (BIRTH_VEL_SCALE[i] ?? 1);
      this.send(this.buildNote(at, "pluck", midi, vel, e, "new", i === 0, r));
    }
  }

  private emitThud(q: Queued, when: number): void {
    const e = q.edit;
    const vel = THUD_VEL_BASE + THUD_VEL_BOT * this.energy_.botNorm;
    const r = spatialMapper.radiusOf(e.title, e.id);
    this.send(this.buildNote(when, "thud", 0, clamp(vel, 0, 1), e, "bot-thud", true, r));
  }

  private emitTick(q: Queued, when: number): void {
    const e = q.edit;
    const vel = TICK_VEL_BASE + TICK_VEL_BOT * this.energy_.botNorm;
    const r = spatialMapper.radiusOf(e.title, e.id);
    this.send(this.buildNote(when, "tick", 0, clamp(vel, 0, 1), e, "bot-tick", false, r));
  }

  /** Debug overlay / test accessors (§11.9). */
  getStats(): SchedulerStats {
    const s = this.harmony_.getState();
    return {
      chordName: this.harmony_.chordName,
      mode: s.mode,
      keyName: this.harmony_.keyName,
      energy: this.energy_.E,
      botNorm: this.lastBotNorm < 0 ? 0 : this.energy_.botNorm,
      stepIndex: this.stepIndex,
      bar: (this.stepIndex / STEPS_PER_BAR) | 0,
      activeSubs: this.activeSubEnds.length,
      activeGongs: this.activeGongEnds.length,
    };
  }

  getMetrics(): { notesScheduled: number; droppedNotes: number; attemptedNotes: number } {
    return {
      notesScheduled: this.notesScheduled,
      droppedNotes: this.droppedNotes,
      attemptedNotes: this.attemptedNotes,
    };
  }

  /** Percussion patterns, for the debug overlay and tests (§7.8). */
  getPatterns(): { thud: readonly boolean[]; tick: readonly boolean[] } {
    return { thud: this.thudPattern, tick: this.tickPattern };
  }

  /**
   * Audio time of the first 16th-note step — the **grid origin**. Every
   * scheduled `when` is `origin + n·STEP_SEC ± humanize`, so tests and the
   * debug overlay anchor quantisation checks here rather than to wall-clock
   * zero (the first step lands at `now + 0.05`, not at 0).
   */
  get gridOrigin(): number {
    return this.origin;
  }

  get queueLengths(): { melodic: number; sub: number; gong: number; birth: number; bot: number } {
    return {
      melodic: this.melodicQ.length,
      sub: this.subQ.length,
      gong: this.gongQ.length,
      birth: this.birthQ.length,
      bot: this.botQ.length,
    };
  }

  /** Perceptual position within the current phrase, for tests and UI. */
  get phraseProgress(): number {
    return (this.stepIndex % (STEPS_PER_BAR * 8)) / (STEPS_PER_BAR * 8);
  }

  /**
   * Target melodic notes/s for the current energy, exposed for the offline
   * simulation report (`scripts/sim-music.ts`). `scripts/` is outside the hot
   * path, so routing this through the public surface keeps `energy_` private.
   */
  targetNotesPerSim(d: "sparse" | "normal" | "dense"): number {
    return this.energy_.targetNotesPerSec(d);
  }
}
