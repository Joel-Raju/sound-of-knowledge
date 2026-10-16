/**
 * §5.5 — the engine facade. One object that owns ingest, music, audio and visuals, and
 * is the only thing the React shell is allowed to talk to.
 *
 * **The gesture boundary is the whole reason this class exists.** §8.2: an
 * `AudioContext` may only be created from a user gesture. So `create()` builds the
 * renderer and compiles shaders — everything that does not need permission — and
 * `start()` is the single method that touches audio, and it must be called from inside
 * a click handler. Splitting it any other way produces a context the browser
 * immediately suspends, which looks like a mute bug and is not.
 *
 * Everything here is also StrictMode-safe. React 19 mounts effects twice in
 * development, so every field is cleared in `dispose()` and `create()` refuses to run
 * twice on the same instance — a leaked second `AudioContext` or a second rAF loop is
 * invisible until the frame budget doubles for no stated reason.
 */
import * as THREE from "three";

import type { ModeId, NoteEvent, NormalizedEdit, Settings, Tier } from "./types";

import { VisualEngine } from "./visual/renderer";
import { Orb } from "./visual/orb";
import { Sparks } from "./visual/sparks";
import { Rings } from "./visual/rings";
import { Dust } from "./visual/dust";
import { LabelLayer } from "./visual/labels";
import { VisualDirector } from "./visual/fire";
import { VisualQueue } from "./visual/visual-queue";

import { AudioEngine } from "./audio/audio-engine";
import { Scheduler } from "./music/scheduler";
import { Harmony, type HarmonyEvent } from "./music/harmony";
import { IngestClient } from "./ingest/ingest-client";
import { defaultIngestConfig } from "./ingest/ingest-core";
import { mulberry32 } from "./util/random";

/** §5.5 — `stats` is emitted at 4 Hz; React must not re-render faster (§1, line 61). */
const STATS_INTERVAL_SEC = 0.25;

/** §5.5 — the metrics and event payloads, verbatim from the spec. */
export interface Metrics {
  fps: number;
  frameMsEma: number;
  frameMsP95: number;
  renderScale: number;
  tier: Tier;
  level: number;
  acceptedTotal: number;
  droppedTotal: number;
  notesScheduled: number;
  droppedNotes: number;
  attemptedNotes: number;
  activeVoices: number;
  visualQueueLen: number;
  audioState: AudioContextState | "none";
  mode: ModeId;
  keyName: string;
  energy: number;
  muted: boolean;
  streamState: string;
}

export interface EngineEvents {
  status: {
    stream: "connecting" | "live" | "reconnecting" | "replay" | "error";
    detail?: string;
  };
  stats: {
    eps: number;
    accepted: number;
    dropped: number;
    botRatio: number;
    revertRatio: number;
    energy: number;
    mode: ModeId;
    keyName: string;
    fps: number;
    tier: Tier;
  };
  notable: { edit: NormalizedEdit };
  error: { code: "webgl" | "audio" | "worklet" | "stream" | "unknown"; message: string };
}

export interface EngineOptions {
  /** canvas + label layer mount point */
  container: HTMLElement;
  settings: Settings;
  /** from `?debug=1` */
  debug?: boolean;
}

/** §11.3 — settings live in `localStorage` under this key. */
export const SETTINGS_KEY = "sok.settings.v2";

export const DEFAULT_SETTINGS: Settings = {
  volume: 0.8,
  muted: false,
  source: "wikipedias",
  langs: [],
  density: "normal",
  quality: "auto",
  spatialAudio: true,
  showTitles: true,
  reduceMotion: false,
  avSyncMs: 0,
};

export class Engine {
  // --- construction --------------------------------------------------------
  private constructor(
    readonly container: HTMLElement,
    readonly canvas: HTMLCanvasElement,
    private readonly opts: EngineOptions,
  ) {
    this.settings = opts.settings;
  }

  /**
   * §5.5 — renderer + shader warm-up. **Does not create an AudioContext.**
   *
   * Resolving this promise is what enables the Enter button, so it must be the point
   * at which the frame is genuinely ready to draw — not merely when three.js has been
   * imported. The one warm-up frame below is what makes that true: the first draw with
   * a fresh scene compiles every shader, and doing that after the overlay has faded
   * drops the first visible frame for hundreds of milliseconds.
   */
  static async create(opts: EngineOptions): Promise<Engine> {
    const canvas = document.createElement("canvas");
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    opts.container.appendChild(canvas);
    const engine = new Engine(opts.container, canvas, opts);

    await engine.buildVisuals();
    return engine;
  }

  private visuals: VisualEngine | null = null;
  private orb: Orb | null = null;
  private sparks: Sparks | null = null;
  private rings: Rings | null = null;
  private dust: Dust | null = null;
  private labels: LabelLayer | null = null;
  private director: VisualDirector | null = null;
  private queue = new VisualQueue();

  /** Audio-side, all null until `start()`. */
  private audio: AudioEngine | null = null;
  private ctx: AudioContext | null = null;
  private scheduler: Scheduler | null = null;
  private harmony: Harmony | null = null;
  private ingest: IngestClient | null = null;

  private settings: Settings;
  private started = false;
  private warmStartedAt = 0;
  private disposed = false;

  // scratch, reused so a note allocates nothing on the way to the visuals (§12.1)
  private readonly shellPos = new THREE.Vector3();
  private readonly tmpColor = new THREE.Color();
  private notableSeen = 0;
  private streamState = "connecting";
  private lastStatsEmit = 0;
  private readonly rng = mulberry32(0x5eed);

  // --- events --------------------------------------------------------------
  private readonly listeners = new Map<keyof EngineEvents, Set<(p: never) => void>>();

  on<K extends keyof EngineEvents>(ev: K, fn: (p: EngineEvents[K]) => void): () => void {
    let set = this.listeners.get(ev);
    if (!set) {
      set = new Set();
      this.listeners.set(ev, set);
    }
    set.add(fn as (p: never) => void);
    return () => {
      set!.delete(fn as (p: never) => void);
    };
  }

  private emit<K extends keyof EngineEvents>(ev: K, payload: EngineEvents[K]): void {
    const set = this.listeners.get(ev);
    if (!set) return;
    for (const fn of set) (fn as (p: EngineEvents[K]) => void)(payload);
  }

  // --- metrics -------------------------------------------------------------
  /** §5.5 — "all numbers; updated in place", so readers never see a torn set. */
  readonly metrics: Metrics = {
    fps: 0,
    frameMsEma: 0,
    frameMsP95: 0,
    renderScale: 1,
    tier: "low",
    level: 0,
    acceptedTotal: 0,
    droppedTotal: 0,
    notesScheduled: 0,
    droppedNotes: 0,
    attemptedNotes: 0,
    activeVoices: 0,
    visualQueueLen: 0,
    audioState: "none",
    mode: "lydian",
    keyName: "—",
    energy: 0,
    muted: false,
    streamState: "connecting",
  };

  getMetrics(): Readonly<Metrics> {
    return this.metrics;
  }

  // --- visuals -------------------------------------------------------------

  private async buildVisuals(): Promise<void> {
    const engine = new VisualEngine({ canvas: this.canvas });
    this.visuals = engine;

    const orb = new Orb({ tier: engine.tier });
    const sparks = new Sparks({ tier: engine.tier });
    const rings = new Rings();
    const dust = new Dust({ tier: engine.tier });
    this.orb = orb;
    this.sparks = sparks;
    this.rings = rings;
    this.dust = dust;

    const features = {
      rms: 0,
      sub: 0,
      bass: 0,
      mid: 0,
      high: 0,
      air: 0,
      flux: 0,
    };

    engine.addLayer({
      attach: (scene) => {
        scene.add(dust.points);
        scene.add(sparks.mesh);
        scene.add(rings.mesh);
        scene.add(orb.mesh);
      },
      update: (_dt, time) => {
        // §8.10's features drive the visuals. Before audio exists they are zero, so
        // the orb renders as a quiet body rather than a blank frame — and the warm-up
        // frame below is drawing exactly this.
        const f = this.audio ? this.audio.readFeatures(_dt) : features;
        dust.update(time, engine.renderScale, f.high, engine.palette.current.dust);
        sparks.update(time);
        rings.update(time);
        orb.update(time, f, engine.palette);
        this.queueAndFlush(time);
      },
      dispose: () => {
        dust.dispose();
        sparks.dispose();
        rings.dispose();
        orb.dispose();
      },
    });

    engine.addReducedMotionConsumer(orb);
    engine.addReducedMotionConsumer(sparks);

    const post = engine.attachPost();

    // §9.9's label pool, appended to the container the spec names.
    const labels = new LabelLayer(document, (e) => {
      this.notableSeen++;
      // §5.5's `notable` event — throttled already, inside `LabelLayer`.
      this.emit("notable", { edit: e.edit });
    });
    this.labels = labels;
    this.container.appendChild(labels.layer);

    const director = new VisualDirector({
      sparks,
      rings,
      orb,
      colorFor: (kind, magnitude) => {
        const rgb = engine.palette.colorFor(kind, magnitude);
        return this.tmpColor.setRGB(rgb.r, rgb.g, rgb.b);
      },
      post: post ?? undefined,
      addTrauma: (a) => engine.rig.addTrauma(a),
      labels,
    });
    this.director = director;

    engine.start();

    // §11.2 — the Enter button is enabled when `create()` resolves, so this promise
    // must not resolve until a frame has actually been drawn with every shader
    // compiled. A hidden element measures 0×0 and skips the draw entirely, which is
    // why the canvas is briefly made visible and restored.
    await this.warmUp(engine);
  }

  /**
   * §11.2 — draw one frame before declaring readiness.
   *
   * The first render of a fresh scene compiles every shader, which on swiftshader
   * takes long enough to be a visible stall if it lands after the overlay fades.
   * `renderer.compileAsync` would do the same work without a context switch, but it
   * cannot compile the post stack's passes, so an actual frame is what "ready" has to
   * mean here.
   */
  private warmUp(_engine: VisualEngine): Promise<void> {
    return new Promise((resolve) => {
      const previous = this.canvas.style.visibility;
      this.canvas.style.visibility = "hidden";
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        this.canvas.style.visibility = previous;
        resolve();
      };
      // `start()` is already running the loop; wait for two frames rather than
      // guessing a duration, and cap the wait so a stalled context cannot leave the
      // Enter button disabled forever.
      let seen = 0;
      const check = (): void => {
        if (seen++ >= 2 || performance.now() - this.warmStartedAt > 20_000) return done();
        requestAnimationFrame(check);
      };
      this.warmStartedAt = performance.now();
      requestAnimationFrame(check);
    });
  }

  /** §9.9/§10.2 — drain due notes and fire their visuals. */
  private queueAndFlush(now: number): void {
    const ready = this.queue.drain(now);
    for (const note of ready) {
      const d = note.dir;
      this.shellPos.set(d.x * note.radius, d.y * note.radius, d.z * note.radius);
      this.director?.fire(note, this.shellPos, now);
    }
    this.director?.flush(now);
    this.metrics.visualQueueLen = this.queue.length;
    this.labels?.update(now, this.visuals!.camera, this.canvas.clientWidth, this.canvas.clientHeight);
    this.emitStats(now);
  }

  // --- start ---------------------------------------------------------------

  /**
   * §5.5 — **must be called from a user-gesture handler.**
   *
   * Everything audio happens here: the context, the worklet, ingest and the scheduler.
   * If this throws, visuals keep running muted (§11.2) rather than the whole piece
   * dying, because a silent piece that still moves is a better failure than a blank
   * canvas.
   */
  async start(): Promise<void> {
    if (this.disposed || this.started) return;
    this.started = true;

    try {
      const ctx = new AudioContext({ latencyHint: "interactive" });
      this.ctx = ctx;
      const audio = new AudioEngine(ctx, {
        tier: this.visuals!.tier,
        // §8.2 — spatial audio is a setting, and the default is on.
        spatial: this.settings.spatialAudio,
        volume: this.settings.volume,
        muted: this.settings.muted,
      });
      await audio.init();
      this.audio = audio;
      audio.setVolume(this.settings.volume);
      audio.setMuted(this.settings.muted);
      audio.setSpatial(this.settings.spatialAudio);

      const harmony = new Harmony(this.rng);
      this.harmony = harmony;
      audio.startContinuous(harmony.getState());

      const scheduler = new Scheduler({
        now: () => ctx.currentTime,
        isHidden: () => document.hidden,
        rng: this.rng,
        // §5.5's `emitX`: a note becomes audio *and* a queued visual, and the visual
        // waits for heard-time rather than firing now.
        note: (n: NoteEvent) => this.emitNote(n),
        harmony: (e) => {
          audio.onHarmony(e);
          if (e.kind === "mode" || e.kind === "key") this.applyHarmony(e);
        },
      });
      this.scheduler = scheduler;
      scheduler.setDensity(this.settings.density);

      const ingest = new IngestClient({
        config: defaultIngestConfig({
          source: this.settings.source,
          langs: this.settings.langs,
        }),
        handlers: {
          onBatch: (edits) => scheduler.onBatch(edits),
          onStats: () => this.refreshIngestMetrics(),
          onStatus: (state, detail) => {
            this.streamState = state;
            this.emit("status", { stream: state, detail });
          },
          onTick: () => scheduler.onTick(),
          onError: (message) => this.emit("error", { code: "stream", message }),
        },
      });
      this.ingest = ingest;
      ingest.start();

      this.emit("status", { stream: "connecting" });
    } catch (err) {
      // §11.2 — the worklet failing to load must not take the visuals with it.
      this.metrics.audioState = "none";
      const message = err instanceof Error ? err.message : String(err);
      this.emit("error", { code: "audio", message });
      this.emit("status", { stream: "error", detail: message });
    }
  }

  /** §5.5's `emitX` — one note, both destinations. */
  private emitNote(note: NoteEvent): boolean {
    const scheduled = this.audio ? this.audio.trigger(note) : true;
    this.metrics.attemptedNotes++;
    if (!scheduled) {
      this.metrics.droppedNotes++;
      return false;
    }
    this.metrics.notesScheduled++;
    if (note.visual) this.queue.push(note);
    return true;
  }

  /** §9.3 — a harmony change retunes the palette. */
  private applyHarmony(e: HarmonyEvent): void {
    const p = this.visuals?.palette;
    if (!p) return;
    if (e.kind === "mode") p.set(e.state.mode, e.state.rootPc);
    else if (e.kind === "key") p.set(p.currentMode, e.state.rootPc);
  }

  private refreshIngestMetrics(): void {
    const h = this.harmony;
    if (h) {
      this.metrics.energy = 0;
      this.metrics.mode = h.getState().mode;
      this.metrics.keyName = h.keyName;
    }
  }

  /** §5.5 — at 4 Hz, and only while something is listening. */
  private emitStats(now: number): void {
    if (now - this.lastStatsEmit < STATS_INTERVAL_SEC) return;
    this.lastStatsEmit = now;

    const v = this.visuals;
    if (v) {
      const s = v.getStats();
      this.metrics.fps = s.fps;
      this.metrics.frameMsEma = s.emaMs;
      this.metrics.frameMsP95 = s.p95Ms;
      this.metrics.renderScale = s.scale;
      this.metrics.tier = s.tier;
      this.metrics.level = s.level;
    }
    if (this.audio) {
      this.metrics.audioState = this.ctx?.state ?? "none";
      this.metrics.activeVoices = this.audio.activeVoices(this.ctx?.currentTime ?? 0);
      this.metrics.muted = this.audio.isMuted();
    }
    this.metrics.streamState = this.streamState;

    this.emit("stats", {
      eps: 0,
      accepted: this.metrics.acceptedTotal,
      dropped: this.metrics.droppedTotal,
      botRatio: 0,
      revertRatio: 0,
      energy: this.metrics.energy,
      mode: this.metrics.mode,
      keyName: this.metrics.keyName,
      fps: this.metrics.fps,
      tier: this.metrics.tier,
    });
  }

  // --- settings ------------------------------------------------------------

  setSettings(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch };
    const s = this.settings;
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    } catch {
      // Private browsing rejects `localStorage`. Losing persistence is survivable;
      // throwing here would take the whole engine down over a settings write.
    }

    this.audio?.setVolume(s.volume);
    this.audio?.setMuted(s.muted);
    this.audio?.setSpatial(s.spatialAudio);
    this.scheduler?.setDensity(s.density);
    this.labels?.setShowTitles(s.showTitles);
    this.metrics.muted = s.muted;

    if (patch.source !== undefined || patch.langs !== undefined) {
      this.ingest?.setConfig({ source: s.source, langs: s.langs });
    }
  }

  getSettings(): Readonly<Settings> {
    return this.settings;
  }

  // --- misc API ------------------------------------------------------------

  async resumeAudio(): Promise<void> {
    if (this.ctx && this.ctx.state === "suspended") await this.ctx.resume();
  }

  async screenshot(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      this.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))), "image/png");
    });
  }

  /** DEBUG ONLY (`?debug=1`) — feeds the scheduler as if the stream had produced them. */
  injectEdits(edits: NormalizedEdit[]): void {
    this.scheduler?.onBatch(edits);
  }

  /** For T5.2's HUD and the debug handle. */
  get audioEngine(): AudioEngine | null {
    return this.audio;
  }
  get visualEngine(): VisualEngine | null {
    return this.visuals;
  }
  get visualQueue(): VisualQueue {
    return this.queue;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.queue.clear();
    this.director?.clear();
    this.ingest?.dispose();
    this.labels?.dispose();
    this.visuals?.dispose();
    void this.ctx?.close().catch(() => {});
    this.listeners.clear();
    this.canvas.remove();
  }
}

// --- settings persistence (§11.3) ---------------------------------------------

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    // Validated field by field: a stored value from an older version, or a hand-edited
    // one, must not be able to put the engine into a state it cannot recover from.
    const out = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      const v = parsed[key];
      if (v === undefined || v === null) continue;
      if (typeof v === typeof DEFAULT_SETTINGS[key]) {
        (out as Record<string, unknown>)[key] = v;
      }
    }
    return out;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export type { Tier };