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

import type { ModeId, NoteEvent, NormalizedEdit, Settings, Tier, Vec3 } from "./types";

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
import { a4Basis, planA4, a4Target, A4_DIRECTIONS, type A4Direction, type A4Step } from "./debug/a4-calibration";

/**
 * How long to wait after a calibration note is scheduled, before the next step.
 *
 * A bell rings for `MELODIC_DUR_TAU` = 3.5 s, so a shorter gap means the previous
 * note is still ringing while the next one is measured — and the previous step's pan
 * contaminates the next step's reading. Measured: with a 3.5 s gap the RIGHT step
 * read +10.4 dB on the right in one run and +0.5 dB in the next, because the LEFT
 * step's window was full of the RIGHT note's tail.
 */
const A4_SETTLE_MS = 4_800;

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
  /**
   * DEBUG ONLY — the A4 calibration's current step.
   *
   * The 3D label cannot be the reference: §9.1 puts the camera at radius 5.5 inside the
   * 7-13 edit shell, so five of the six calibration directions project **outside the
   * frustum** (measured: RIGHT at 118 % of screen width, LEFT at -16 %, BEHIND behind
   * the camera, ABOVE at -88 %, BELOW at 198 %). Only FRONT is on screen.
   *
   * The HUD ticker is DOM and always visible, but it is throttled at 2.5 s and
   * *replaces* rather than queues, so it showed 3 of 6 steps.
   *
   * So the calibration needs its own always-visible readout, and it needs to be driven
   * by the step rather than by the note — the step is what the human is judging.
   */
  a4Step: {
    label: string;
    index: number;
    total: number;
    errorDeg: number;
    /** `direction` — the note's direction is what is being judged.
     *  `timbre` — the notes are matched and only the *character* differs. */
    mode?: "direction" | "timbre";
    /** For `timbre`: the whole sequence, so the readout can show a position track and
     *  the listener can see the structure they are judging against. */
    seq?: string[];
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
  /** DEBUG ONLY — A4 calibration gate on stream delivery. See `runA4Calibration`. */
  private ingestPaused = false;
  /** DEBUG ONLY — which calibration callbacks have fired, in order. Diagnostics only. */
  private a4Fired: string[] = [];
  /** DEBUG ONLY — `notesScheduled` at calibration start, so steps can be counted against
   *  a baseline rather than against a moving absolute count. */
  private a4StartNotes = 0;
  /** DEBUG ONLY — how many calibration notes should have been scheduled by now. */
  private a4Expected = 0;

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
      // §8.9 — "the listener is the camera". The `AudioListener` otherwise sits at the
      // browser default `(0, 0, 0)` facing `(0, 0, -1)` for the whole session, while the
      // camera orbits at radius 5.5. The panner positions were always correct in world
      // space, but the frame the listener heard them in never moved — so a note to the
      // camera's left was not heard on the left.
      //
      // The human's ears found this: "left on both left and right airpods, same with
      // right". No automated test covered it, because the *offline* harness does call
      // `setListener` — so the one measurement of this feature was made through the
      // path that worked.
      onPose: (pose) => {
        this.audio?.setListener(pose.position, pose.forward);
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
          // A4 calibration pauses the stream so its edits are not buried under ~10
          // notes per 2.5 s of live traffic. Ingest keeps *running* — the worker and the
          // SSE connection are untouched — only delivery into the scheduler is gated.
          onBatch: (edits) => {
            if (this.ingestPaused) return;
            scheduler.onBatch(edits);
          },
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

  /**
   * A4 calibration — freeze the frame, quiet the stream, and fire one edit per named
   * direction. DEBUG ONLY; not reachable from `Settings` or any URL parameter.
   *
   * See `engine/debug/a4-calibration.ts` for why each of the three obstacles makes A4
   * unanswerable without this.
   */
  runA4Calibration(opts: { gapMs?: number } = {}): A4Step[] {
    const gapMs = opts.gapMs ?? 3_000;
    const rig = this.visuals?.rig;
    if (!rig) return [];

    // Freeze first: the plan is computed from the pose the rig is *held* at, so the
    // direction a note is planned for is the direction it will actually be heard from.
    rig.setAutoOrbit(false);
    // Freeze the pose outright, and snap past the entrance dolly. The plan is computed
    // from this pose, so the pose has to still be this pose when note six fires.
    rig.setFreezePose(true);
    this.ingestPaused = true;
    // Silence the centred pad/drone bed. It is continuous and in the middle, so it
    // drowns out any measurement of a single note's direction — the same reason the
    // offline harness has a `notes-only` scenario.
    this.audio?.setContinuousMuted(true);
    // Anything queued before the calibration began is not part of it. Leaving it there
    // put the calibration edits behind the backlog, where `pickBest`'s lookahead could
    // never reach them — measured as roughly half the notes silently lost.
    this.scheduler?.drain();
    this.a4Fired.length = 0;
    this.a4StartNotes = this.getMetrics().notesScheduled ?? 0;
    this.a4Expected = 0;

    const basis = a4Basis(rig.forward);
    const steps = planA4(basis);

    // **The steps are chained, not parallel.**
    //
    // The first version fired all six on independent timers. That has two failures:
    //
    //  1. A **race**. Step N's re-offer loop drains the scheduler queue before each
    //     offer — and if step N+1's edit had already been queued, that drain threw it
    //     away. The result was a step whose note sometimes never sounded, which made
    //     the measurement of that direction read as "centred".
    //  2. **Tail overlap.** A bell rings for `MELODIC_DUR_TAU` = 3.5 s, so with a
    //     3.5 s gap the previous note was still ringing while the next step was being
    //     measured, and the previous step's pan contaminated the next step's reading.
    //
    // Chaining fixes both: step N+1 does not begin until step N's note has actually
    // been scheduled, and the gap is measured from that point.
    this.a4Chain(steps, gapMs, 0, this.audio?.context.currentTime ?? 0);
    return steps;
  }

  /** Run the calibration steps one after another. See `runA4Calibration`. */
  private a4Chain(
    steps: A4Step[],
    gapMs: number,
    index: number,
    t0: number,
  ): void {
    if (index >= steps.length) return;
    const step = steps[index]!;
    const dueAt = t0 + 0.6 + index * (gapMs / 1000);
    const delay = Math.max(0, (dueAt - (this.audio?.context.currentTime ?? 0)) * 1000);
    window.setTimeout(() => {
      this.fireA4Step(step, () => {
        // The note is scheduled. Wait for it to **decay** before the next step, or the
        // previous note's tail is still ringing while the next one is measured — and a
        // bell rings for `MELODIC_DUR_TAU` = 3.5 s.
        const settleMs = Math.max(gapMs, A4_SETTLE_MS);
        window.setTimeout(() => {
          this.a4Chain(steps, gapMs, index + 1, t0);
        }, settleMs);
      });
    }, delay);
  }

  /**
   * Emit one calibration edit, re-offering it until the scheduler has actually accepted
   * it as a note.
   *
   * The melodic gate is probabilistic (§7.7: `rng() < p` per step), so a single injection
   * is a *request*, not a guarantee. Retrying removes the dependency on sampler
   * statistics entirely without bypassing anything — the note still goes through the real
   * router, the real queue and the real panner, which is the whole point of the test.
   *
   * **Each retry must REPLACE the previous copy, not add to it.** The first version
   * simply re-offered, and every copy stayed in the queue and eventually played: six
   * steps produced **22 notes** instead of 6. Worse, `pickBest` scores
   * `importance + 0.1·age`, so the *oldest* queued edit wins — FRONT's copies always
   * beat RIGHT/LEFT, which sat behind them where the lookahead could not reach them. The
   * human heard one direction and one title, forever.
   *
   * So: drain before each offer, and only offer if the note has not been scheduled yet.
   * `drain()` is safe here precisely because the stream is paused, so the only edits in
   * the queue are calibration edits.
   */
  private fireA4Step(step: A4Step, onScheduled?: () => void): void {
    this.a4Fired.push(step.label);
    this.a4Expected += 1;
    this.emit("a4Step", {
      label: step.label,
      index: this.a4Fired.length,
      total: A4_DIRECTIONS.length,
      errorDeg: step.errorDeg,
      mode: "direction",
    });

    const edit: NormalizedEdit = {
      id: step.id,
      ts: Date.now(),
      wiki: step.wiki,
      host: `${step.wiki}.example.org`,
      lang: "en",
      project: "wikipedia",
      ns: 0,
      title: step.title,
      actor: "registered",
      kind: "edit",
      minor: false,
      delta: 800,
      absDelta: 800,
      magnitude: 0.5,
      importance: 0.9,
      revNew: 1,
    };

    let tries = 0;
    const offer = (): void => {
      // Offer only if this step's note has not been scheduled yet — and REPLACE any
      // copy still sitting in the queue rather than adding to it.
      const scheduled = (this.getMetrics().notesScheduled ?? 0) - this.a4StartNotes;
      if (scheduled >= this.a4Expected) {
        onScheduled?.();
        return;
      }
      if (tries >= 40) {
        // Give up, but let the chain continue so the remaining steps still run.
        onScheduled?.();
        return;
      }
      this.scheduler?.drain();
      this.scheduler?.onBatch([edit]);
      tries++;
      window.setTimeout(offer, 120);
    };
    offer();
  }

  /** Undo `runA4Calibration`'s freeze and pause. */
  endA4Calibration(): void {
    this.visuals?.rig.setFreezePose(false);
    this.visuals?.rig.setAutoOrbit(true);
    this.audio?.setContinuousMuted(false);
    this.ingestPaused = false;
  }

  /** DEBUG ONLY — the labels whose calibration callbacks have fired, in order. */
  getA4Fired(): readonly string[] {
    return this.a4Fired;
  }

  /**
   * DEBUG ONLY — play a **fixed** note at a named direction, for a matched A/B.
   *
   * **Why this exists.** The human can hear left/right separation but reports "not much
   * with above and below". The measured reason: elevation produces **0 dB** of
   * left/right level difference (only azimuth does), so under HRTF the difference is
   * *spectral* — a change of colour, not of place.
   *
   * To test a spectral difference you need a **matched pair**: the same note, the same
   * pitch, the same waveform, with only the panner's position changed. Two notes taken
   * from the live stream differ in pitch, timbre and loudness, so any difference a
   * listener hears could be any of those.
   *
   * So this bypasses the mapper and the sampler entirely and triggers the note
   * directly, with a fixed voice, pitch and velocity.
   */
  playCalibrationNote(dir: Vec3, when: number, label?: string): boolean {
    const audio = this.audio;
    if (!audio) return false;
    const MID = 69; // 440 Hz
    const FREQ = 440;
    const edit: NormalizedEdit = {
      id: -1,
      ts: Date.now(),
      wiki: "calibration",
      host: "calibration.invalid",
      lang: "en",
      project: "wikipedia",
      ns: 0,
      title: label ? `A4 ${label}` : "A4 calibration",
      actor: "registered",
      kind: "edit",
      minor: false,
      delta: 800,
      absDelta: 800,
      magnitude: 0.5,
      importance: 0.9,
      revNew: 1,
    };
    return audio.trigger({
      when,
      voice: "bell",
      midi: MID,
      freq: FREQ,
      vel: 1,
      dir: { x: dir.x, y: dir.y, z: dir.z },
      radius: 10,
      edit,
      flavor: "remove",
      visual: false,
    });
  }

  /** Announce a calibration step on screen. */
  private announceA4Step(
    label: string,
    total: number,
    mode: "direction" | "timbre",
    seq?: string[],
  ): void {
    this.a4Fired.push(label);
    this.emit("a4Step", {
      label,
      index: this.a4Fired.length,
      total,
      errorDeg: 0,
      mode,
      seq,
    });
  }

  /**
   * DEBUG ONLY — the matched A/B sequence for elevation: FRONT, ABOVE, FRONT, BELOW,
   * FRONT, with the reference (FRONT) bracketing each target so a listener has a
   * reference immediately before and after.
   */
  playA4Timbres(gapSec = 1.8): void {
    const rig = this.visuals?.rig;
    if (!rig) return;
    rig.setAutoOrbit(false);
    rig.setFreezePose(true);
    this.audio?.setContinuousMuted(true);

    const basis = a4Basis(rig.forward);
    // **FRONT, ABOVE, FRONT, BELOW, FRONT, ABOVE, FRONT.**
    //
    // The FRONT repeats are the **control**: they are the same note at the same place,
    // so they must sound identical to each other. Without that, "ABOVE sounded the
    // same" would be uninterpretable — it might mean the cue is absent, or that the
    // listener simply cannot hear this kind of difference at all. Hearing the FRONTs
    // as identical is the evidence that the test is sensitive enough to detect a
    // difference if one were there.
    //
    // ABOVE is bracketed by FRONTs (notes 1/3 and 5/7) and repeated at 2 and 6, so a
    // judgement rests on two separate comparisons rather than one.
    const seq: A4Direction[] = ["FRONT", "ABOVE", "FRONT", "BELOW", "FRONT", "ABOVE", "FRONT"];
    const t0 = this.audio!.context.currentTime + 0.8;
    this.a4Fired.length = 0;
    seq.forEach((label, i) => {
      const target = a4Target(basis, label);
      const at = t0 + i * gapSec;
      this.playCalibrationNote(target, at, label);
      // Announce when the note **sounds**, not when it is scheduled. Announcing at
      // schedule time made all five labels appear at once, so the readout showed only
      // the last one and the measurement could not attribute anything to a step.
      const delayMs = Math.max(0, (at - this.audio!.context.currentTime) * 1000);
      window.setTimeout(
        () => this.announceA4Step(label, seq.length, "timbre", seq),
        delayMs,
      );
    });
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