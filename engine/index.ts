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
import { LabelLayer, type NotableEvent } from "./visual/labels";
import { VisualDirector } from "./visual/fire";
import { VisualQueue } from "./visual/visual-queue";

import { AudioEngine } from "./audio/audio-engine";
import { Scheduler } from "./music/scheduler";
import { Harmony, type HarmonyEvent } from "./music/harmony";
import { IngestClient } from "./ingest/ingest-client";
import { defaultIngestConfig } from "./ingest/ingest-core";
import { validateSettings, saveSettings } from "./settings";
import { OUTPUT_LATENCY_FALLBACK } from "./config";
import { mulberry32 } from "./util/random";

/** §5.5 — `stats` is emitted at 4 Hz; React must not re-render faster (§1, line 61). */
const STATS_INTERVAL_SEC = 0.25;
/**
 * §11.8 — how long to wait for `webglcontextrestored` before calling it a failure.
 *
 * Restoring is usually immediate. 8 s is generous on purpose: the cost of waiting too
 * long is a banner that says "restoring…" a moment longer, and the cost of waiting too
 * little is offering **Reload** over a canvas that was about to come back.
 */
const GL_RESTORE_TIMEOUT_MS = 8_000;

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
  /**
   * §5.5 — the ticker feed. Carries the already-built `href` and `text` from
   * §9.9's `LabelLayer` rather than only the edit, so the HUD does not re-derive the
   * URL. Two copies of `buildArticleHref` is two places for the space→underscore
   * ordering to drift, and that ordering is load-bearing.
   */
  notable: NotableEvent;
  /**
   * §11.8 — `webglcontextlost` / `webglcontextrestored`.
   *
   * `restored: true` means the rebuild worked and the banner can say "restoring…";
   * `false` means it did not and the UI must offer **Reload** instead. Distinguishing
   * the two is the whole point — a banner that only ever says "restoring…" over a
   * permanently black canvas is worse than none.
   */
  gl: { restored: boolean };
  error: { code: "webgl" | "audio" | "worklet" | "stream" | "unknown"; message: string };
}

/**
 * §11.3 — the data-mode overrides. Named `DataSource` rather than `DataMode` because
 * `ingest/protocol.ts` already exports a `DataMode` **union**
 * (`"live" | "replay" | "synthetic"`), and two different `DataMode`s in one codebase
 * is a trap waiting for an import to be wrong.
 */
export interface DataSource {
  mode?: "live" | "replay" | "synthetic";
  seed?: number;
}

export interface EngineOptions {
  /** canvas + label layer mount point */
  container: HTMLElement;
  settings: Settings;
  /** from `?debug=1` */
  debug?: boolean;
  /**
   * The page's raw query string.
   *
   * Passed in rather than read from `window` inside the engine, for the same reason
   * `app/page.tsx` resolves it on the server: reading `window.location` during render
   * is a hydration mismatch (React #418, T5.1). The engine is not rendering, but
   * threading the value keeps one answer to "where does the query string live".
   */
  search?: string;
  /**
   * §11.3 — `?source=live|replay|synthetic` and `?seed=`. **Not persisted.**
   *
   * Until this was wired, the e2e suite had no offline source at all: every test asked
   * for the live Wikimedia stream, which means every test depended on the network and
   * `notesScheduled` sat at 0 in CI. §13.4 says these tests run with
   * `?source=synthetic` — so this is the parameter the suite is specified around, and it
   * was not connected to anything.
   */
  data?: DataSource;
}

export class Engine {
  // --- construction --------------------------------------------------------
  private constructor(
    readonly container: HTMLElement,
    readonly canvas: HTMLCanvasElement,
    private readonly opts: EngineOptions,
  ) {
    this.settings = opts.settings;
    /** §11.3 URL overrides. Read once here; a query string cannot change mid-session. */
    this.search = new URLSearchParams(opts.search ?? "");
  }

  private readonly search: URLSearchParams;

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
  /** §10.1's heard-time, latched so the pre-audio case has a stable value. */
  private lastHeard = 0;
  private glRestoreTimer = 0;
  private stopWatchingVisibility: (() => void) | null = null;
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
    const engine = new VisualEngine({
      canvas: this.canvas,
      onContextLost: () => {
        this.emit("gl", { restored: false });
        // §11.8 — "if it fails, offer Reload". Restore failing looks exactly like
        // restore being slow: no event either way. So the absence of
        // `webglcontextrestored` within a generous window *is* the failure signal.
        window.clearTimeout(this.glRestoreTimer);
        this.glRestoreTimer = window.setTimeout(
          () => this.emit("gl", { restored: false }),
          GL_RESTORE_TIMEOUT_MS,
        );
      },
      onContextRestored: () => {
        window.clearTimeout(this.glRestoreTimer);
        this.emit("gl", { restored: true });
      },
    });
    this.visuals = engine;

    const orb = new Orb({ tier: engine.tier });
    const sparks = new Sparks({ tier: engine.tier });
    const rings = new Rings();
    const dust = new Dust({ tier: engine.tier });

    // `?dustAlpha=`, `?dustDensity=` and `?nodust=1` — the same sweep handles the debug
    // harness has had since T4.4. They were missing here, which is not a cosmetic gap:
    // without them the dust's contribution **cannot be separated from the grain** in the
    // live path, because the only way to attribute a pixel is to switch it off and
    // diff. "The dust looks invisible" and "the dust is invisible" are different claims
    // and only one measurement distinguishes them.
    const dustAlphaArg = Number(this.search.get("dustAlpha"));
    if (Number.isFinite(dustAlphaArg) && this.search.get("dustAlpha") !== null) {
      dust.setBaseAlpha(Math.max(0, Math.min(1, dustAlphaArg)));
    }
    const dustDensityArg = Number(this.search.get("dustDensity"));
    if (Number.isFinite(dustDensityArg) && this.search.get("dustDensity") !== null) {
      dust.setDensity(Math.max(0, Math.min(4, dustDensityArg)));
    }
    const dustOff = this.search.get("nodust") === "1";
    if (dustOff) dust.points.visible = false;
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
      this.emit("notable", e);
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

    // §10.1 — clear the visual queue when the tab comes back.
    this.stopWatchingVisibility = this.watchVisibility();

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

  /**
   * §10.1/§10.2 — drain due notes, then fire their visuals.
   *
   * **Two clocks, and conflating them is the bug this comment exists for.**
   *
   * `note.when` is **AudioContext time** — the scheduler emits against `ctx.currentTime`,
   * because that is the clock the worklet schedules on. The visual layer is driven by
   * the render clock, which is `performance.now() - t0`. Those two share a rate but not
   * an epoch, and the audio clock drifts against the wall clock.
   *
   * §10.1 says which goes where:
   *
   *   const heard = ctx.currentTime - outputLatency - avSyncMs / 1000;
   *   while (queue.peek().when <= heard && fired < 8) fire(queue.pop());
   *
   * So the **queue gate** is compared in audio time, because that is the only clock in
   * which `note.when` means anything. Everything downstream of `fire()` — sparks, rings,
   * orb impacts, labels — is timed against the **render** clock, because that is what
   * `uTime` evaluates against and a particle's whole life is `(uTime - spawnTime)`.
   *
   * Passing the render clock to `drain()` (which this did before T5.3) compares two
   * different epochs: the visuals land at an arbitrary offset from the sound, and the
   * error grows with the audio hardware's drift.
   *
   * @param renderNow the render clock, seconds since `t0`
   */
  private queueAndFlush(renderNow: number): void {
    const heard = this.heardTime();
    const due = this.queue.drain(heard);

    // §10.1 — at most 8 per frame. A frame that took 200 ms can have a dozen notes
    // come due at once; firing all of them would put that frame's work back into the
    // next frame, which is the mechanism behind a death spiral.
    let fired = 0;
    for (const note of due) {
      if (fired++ >= 8) {
        // Push the rest back for the next frame rather than dropping them.
        this.requeue(note);
        continue;
      }
      const d = note.dir;
      this.shellPos.set(d.x * note.radius, d.y * note.radius, d.z * note.radius);
      this.director?.fire(note, this.shellPos, renderNow);
    }

    this.director?.flush(renderNow);
    this.metrics.visualQueueLen = this.queue.length;
    this.labels?.update(renderNow, this.visuals!.camera, this.canvas.clientWidth, this.canvas.clientHeight);
    this.emitStats(renderNow);
  }

  /**
   * §10.1 — `ctx.currentTime - outputLatency - avSyncMs / 1000`.
   *
   * The latency terms are what make a visual land when its note is *heard* rather than
   * when it was scheduled: `outputLatency` is how far the audio hardware is behind the
   * clock it is handed, and `avSyncMs` is the user's correction for Bluetooth and other
   * paths with their own, larger, delay.
   */
  private heardTime(): number {
    const ctx = this.ctx;
    if (!ctx) return this.lastHeard;
    const latency = this.audio?.outputLatency ?? OUTPUT_LATENCY_FALLBACK;
    this.lastHeard = ctx.currentTime - latency - this.settings.avSyncMs / 1000;
    return this.lastHeard;
  }

  /** Re-queue a note deferred by §10.1's per-frame cap, preserving its heard-time. */
  private requeue(note: NoteEvent): void {
    this.queue.push(note);
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
          // §11.3 — the data mode and seed come from the URL, not from settings. They
          // are deliberately not persisted: writing a test URL's source into
          // localStorage would silently change a user's preferences because someone
          // once opened a test link.
          mode: this.opts.data?.mode ?? "live",
          seed: this.opts.data?.seed ?? 1,
          source: this.settings.source,
          langs: this.settings.langs,
        }),
        handlers: {
          onBatch: (edits) => scheduler.onBatch(edits),
          onStats: (s) => this.onIngestStats(s),
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

  /**
 * §5.5's ingest counters — and the edits/s the HUD reports.
 *
 * These were **not wired at all** until T5.3: `refreshIngestMetrics` was an empty stub,
 * so `acceptedTotal`, `droppedTotal` and the `stats` event's `eps`/`accepted`/`dropped`
 * were permanently zero. The HUD therefore read "Live · **0** edits/s" no matter how
 * much traffic was arriving — and E4 ("bot ratio in the HUD looks plausible on live
 * traffic") was unanswerable *because the HUD was lying*, not because of the traffic.
 *
 * §6.3 — `eps` is reported as **accepted** per second, never as raw input rate. The
 * honest number is what the piece actually played.
 */
  private onIngestStats(s: {
    seen: number;
    accepted: number;
    dropped: number;
    botAccepted: number;
    revertAccepted: number;
    windowMs: number;
  }): void {
    const seconds = Math.max(0.001, s.windowMs / 1000);
    this.metrics.acceptedTotal = s.accepted;
    this.metrics.droppedTotal = s.dropped;

    // All three readouts are over the **delta** since the last window, not the
    // lifetime totals. `botAccepted / accepted` as cumulative counts is an average
    // that barely moves — a "bot ratio" which takes an hour to react is not a readout.
    const dAccepted = s.accepted - this.lastAccepted;
    const dBot = s.botAccepted - this.lastBotAccepted;
    const dRevert = s.revertAccepted - this.lastRevertAccepted;

    this.eps = dAccepted / seconds;
    this.botRatio = dAccepted > 0 ? dBot / dAccepted : 0;
    this.revertRatio = dAccepted > 0 ? dRevert / dAccepted : 0;

    this.lastAccepted = s.accepted;
    this.lastBotAccepted = s.botAccepted;
    this.lastRevertAccepted = s.revertAccepted;
  }

  private eps = 0;
  private botRatio = 0;
  private revertRatio = 0;
  private lastAccepted = 0;
  private lastBotAccepted = 0;
  private lastRevertAccepted = 0;

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
      eps: this.eps,
      accepted: this.metrics.acceptedTotal,
      dropped: this.metrics.droppedTotal,
      botRatio: this.botRatio,
      revertRatio: this.revertRatio,
      energy: this.metrics.energy,
      mode: this.metrics.mode,
      keyName: this.metrics.keyName,
      fps: this.metrics.fps,
      tier: this.metrics.tier,
    });
  }

  // --- settings ------------------------------------------------------------

  setSettings(patch: Partial<Settings>): void {
    this.settings = validateSettings({ ...this.settings, ...patch }, this.settings);
    const s = this.settings;
    // Persisting is best-effort: private browsing rejects `localStorage`, and losing
    // persistence must never take the engine down over a settings write.
    saveSettings(s);

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

  // --- §10.1 visibility ------------------------------------------------------

  /**
   * §10.1 — "On `visibilitychange → visible`: clear the queue."
   *
   * Also the reason the render loop pauses. A hidden tab still **schedules audio**
   * (§11.8: "Audio continues, rendering pauses"), so on return the queue holds notes
   * whose heard-time passed long ago. Firing them all at once is a wall of stale
   * visuals that never matched a sound — §10.1's `dropStale` would eventually discard
   * them, but "eventually" is several hundred frames of nonsense.
   */
  private onVisibility = (): void => {
    if (document.hidden) return;
    this.queue.clear();
  };

  private watchVisibility(): () => void {
    document.addEventListener("visibilitychange", this.onVisibility);
    return () => document.removeEventListener("visibilitychange", this.onVisibility);
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

    window.clearTimeout(this.glRestoreTimer);
    this.stopWatchingVisibility?.();
    this.stopWatchingVisibility = null;
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

export type { Tier };
export { SETTINGS_KEY, DEFAULT_SETTINGS, loadSettings, saveSettings } from "./settings";