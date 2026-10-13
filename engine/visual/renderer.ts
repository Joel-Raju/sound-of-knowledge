/**
 * Renderer bootstrap. Spec §9.1, §9.2, §12.4.
 *
 * Owns the WebGL2 context, the scene, the camera, the frame loop and the
 * governor's effect on resolution. It knows nothing about Wikipedia, the audio
 * engine, or the React layer — those attach through `onFrame` and the
 * `layers` list, which is what keeps this file small enough to reason about.
 *
 * Three things here are not obvious and are commented where they appear:
 *
 * 1. **Frame deltas are clamped.** A backgrounded tab, a GC pause, or a shader
 *    compile can produce a 2-second delta. Feeding that to the camera or the
 *    governor would produce a teleport and a spurious degrade respectively.
 * 2. **The context can be lost.** Mid-session GPU resets (driver updates, laptop
 *    GPU switches) are routine on desktop. `webglcontextlost` is cancelled and
 *    `webglcontextrestored` rebuilds; without that the canvas is a black
 *    rectangle for the rest of the session.
 * 3. **The governor's scale is applied to the pixel ratio**, not to the canvas
 *    CSS size — §9.8 requires `renderer.setPixelRatio(dpr * renderScale)`, which
 *    is what lets the HUD stay crisp while the 3D degrades.
 */
import * as THREE from "three";
import { THREE_MAX_DT_MS } from "../config";
import { FrameStats } from "../util/perf";
import { CameraRig, CAMERA } from "./camera-rig";
import { Governor, GOVERNOR } from "./governor";
import { Post } from "./post";
import { Palette } from "./palette";
import {
  detectTier,
  pixelRatioCeiling,
  readEnvironment,
  readReducedMotion,
  watchReducedMotion,
  type TierEnv,
} from "./tier";
import { clamp } from "../util/math";
import type { Tier, Vec3 } from "../types";

/** Anything the renderer draws. Added before `start()`, drawn every frame. */
export interface RenderLayer {
  /** runs once, after the scene exists */
  attach?(scene: THREE.Scene): void;
  /** runs every frame, before the draw call */
  update?(dtSec: number, timeSec: number, camera: THREE.Camera): void;
  /** runs once, on teardown */
  dispose?(): void;
}

export interface RendererOptions {
  /** the canvas to draw into; created and appended if absent */
  canvas?: HTMLCanvasElement;
  /** overrides tier detection — `?quality=` */
  tier?: Tier;
  /**
   * An explicit non-`auto` quality setting. §9.10: it "fixes the tier and disables
   * the governor's `improve()` beyond that tier's max (but still allows degrade
   * for safety)". Distinct from `tier`, which alone only sets the ceiling.
   */
  pinnedQuality?: boolean;
  /** injected for tests */
  env?: TierEnv;
  /** `prefers-reduced-motion`, §9.11 */
  reduceMotion?: boolean;
  /** override the initial mode for the palette */
  mode?: "lydian" | "mixolydian" | "dorian" | "aeolian";
}

/**
 * Thrown when the browser cannot give us a WebGL2 context.
 *
 * Spec T4.1 calls for a WebGL2 check. Failing loudly here beats the alternative:
 * three.js would either throw an opaque error from deep inside the renderer or,
 * worse, silently fall back to WebGL1 and produce a scene missing the features
 * §9 needs. The debug page catches this and says so plainly.
 */
export class WebGL2Unavailable extends Error {
  constructor(detail: string) {
    super(`WebGL2 is required and unavailable: ${detail}`);
    this.name = "WebGL2Unavailable";
  }
}

/**
 * Reused 1×1 readback target for the governor's synchronised sample.
 *
 * Module scope rather than per-frame: `readPixels` is called inside the hot loop and
 * §12.1 forbids per-frame allocation in hot paths. The value read is discarded —
 * only the elapsed time matters — but the buffer must exist.
 */
const SYNCED_PIXEL = new Uint8Array(4);

/**
 * §9.1 / T4.1 — assert a WebGL2 context can be created on this canvas.
 *
 * The probe context is created with `failIfMajorPerformanceCaveat: true` so a
 * software rasteriser is reported as unavailable rather than accepted silently
 * — that is exactly the case §12.2 pins to the low tier, and silently running a
 * software GL context at high-tier settings is worse than saying so.
 */
function assertWebGL2(canvas: HTMLCanvasElement): void {
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl2", {
      failIfMajorPerformanceCaveat: true,
    }) as WebGL2RenderingContext | null;
  } catch (e) {
    throw new WebGL2Unavailable(e instanceof Error ? e.message : String(e));
  }
  if (!gl) {
    throw new WebGL2Unavailable(
      "canvas.getContext('webgl2') returned null; hardware acceleration may be disabled",
    );
  }
}

export interface RendererStats {
  fps: number;
  emaMs: number;
  p95Ms: number;
  tier: Tier;
  level: number;
  scale: number;
  drawCalls: number;
  triangles: number;
  /**
   * Real GPU frame cost from the last synchronised sample, or 0 before the first
   * one lands. `emaMs` is rAF-derived and pinned at vsync under GPU load; this is
   * the number that does not flatter the scene. See `DECISIONS.md`.
   */
  syncedMs: number;
}

export class VisualEngine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly rig: CameraRig;
  readonly palette: Palette;
  readonly governor: Governor;
  readonly frames: FrameStats;

  tier: Tier;

  private canvas: HTMLCanvasElement;
  private ownsCanvas: boolean;
  private raf = 0;
  private running = false;
  private lastFrame = 0;
  /** frames since start, for the synced-sample stride */
  private frameCount = 0;
  /** most recent synchronised frame cost in ms; exposed for the HUD and stats */
  private lastSyncedMs = 0;
  /**
   * §9.8's composer, or `null` when post-processing is off.
   *
   * Nullable rather than optional-by-default because the low tier is explicitly
   * allowed to skip it (§12.2's whole point is that a software rasteriser should not
   * be handed a full post stack), and the frame loop must work either way.
   */
  post: Post | null = null;
  /**
   * Smoothed RMS in 0–1, driving §9.8's `intensity = 0.8 + 0.6 * rmsSmooth`.
   * Fed by `setEnergy`'s caller via `setRms`; kept separate from `energy` because
   * §9.3's camera pull and §9.8's bloom are different signals with different
   * smoothing, and conflating them would make the bloom follow the camera.
   */
  private rmsSmooth = 0;
  private time = 0;
  private layers: RenderLayer[] = [];

  private dpr = 1;
  private appliedScale = 1;
  /** Global energy from the ingest stats, feeding the camera pull (§9.1). */
  private energy = 0;
  /** Reused so retargeting the palette never allocates (§12.1). */
  private readonly clearColor = new THREE.Color();
  /** Tears down the reduced-motion listener; no-op if never wired. */
  private stopWatchingMotion: () => void = () => {};

  /** Set on context loss so the loop can idle instead of throwing every frame. */
  private contextLost = false;
  private readonly onLost = (e: Event): void => {
    e.preventDefault();
    this.contextLost = true;
  };
  private readonly onRestored = (): void => {
    this.contextLost = false;
    this.lastFrame = 0;
  };
  private readonly onResize = (): void => {
    this.resize();
    this.governor.onSettled();
  };

  // --- pointer drag, spec §9.1 ---------------------------------------------
  //
  // Pointer Events rather than separate mouse/touch handlers: they unify the two,
  // and `setPointerCapture` means a drag that leaves the canvas still tracks, so
  // the camera does not freeze mid-flick when the pointer is released outside.

  /** Last pointer position, in CSS px. Null while not dragging. */
  private dragFrom: { x: number; y: number; t: number } | null = null;

  private readonly onPointerDown = (e: PointerEvent): void => {
    // Ignore secondary buttons: a right-click context menu is not a camera drag.
    if (e.button !== 0) return;
    this.dragFrom = { x: e.clientX, y: e.clientY, t: e.timeStamp };
    this.rig.beginDrag();
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // Capture is a convenience, not a requirement; a browser that refuses it
      // still delivers the moves to the canvas for the duration of the press.
    }
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const from = this.dragFrom;
    if (!from) return;
    const dx = e.clientX - from.x;
    const dy = e.clientY - from.y;
    from.x = e.clientX;
    from.y = e.clientY;
    // `timeStamp` is a DOMHighResTimeStamp in ms; guard against a 0 or equal pair
    // so the velocity smoothing cannot divide by zero.
    const dt = Math.max((e.timeStamp - from.t) / 1000, 1 / 1000);
    from.t = e.timeStamp;
    this.rig.drag(dx, dy, dt);
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    this.dragFrom = null;
    this.rig.endDrag();
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  private readonly onContextMenu = (e: Event): void => {
    // A drag on the canvas is a camera gesture, not a context-menu request.
    e.preventDefault();
  };

  private readonly frameCb = (now: number): void => {
    this.tick(now);
  };

  constructor(opts: RendererOptions = {}) {
    this.tier = opts.tier ?? detectTier(opts.env ?? readEnvironment());

    if (opts.canvas) {
      this.canvas = opts.canvas;
      this.ownsCanvas = false;
    } else {
      this.canvas = document.createElement("canvas");
      this.ownsCanvas = true;
      document.body.appendChild(this.canvas);
    }
    // Touch drag must not scroll the page, §9.1.
    this.canvas.style.touchAction = "none";

    assertWebGL2(this.canvas);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      // Spec §9.1: no MSAA (post-processing does the AA), no alpha, no stencil.
      // `depth: false` is deliberately NOT set — §9.2 needs depth testing even
      // though nothing writes depth.
      antialias: false,
      alpha: false,
      powerPreference: "high-performance",
      stencil: false,
      depth: true,
    });

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(CAMERA.fov, 1, CAMERA.near, CAMERA.far);
    this.rig = new CameraRig({ reduceMotion: opts.reduceMotion ?? readReducedMotion() });
    this.palette = new Palette(opts.mode ?? "lydian", 0);
    this.frames = new FrameStats();
    // dpr must be known before the governor: its ceiling *is* a pixel ratio
    // (§12.3), so it depends on the display.
    this.governor = new Governor({
      tierMaxScale: this.pixelRatioCeiling(),
      pinned: opts.pinnedQuality === true,
    });

    // §9.1 — clear colour is the palette's `deep`, not black.
    this.applyClearColor();

    this.resize();

    this.canvas.addEventListener("webglcontextlost", this.onLost, false);
    this.canvas.addEventListener("webglcontextrestored", this.onRestored, false);
    // §9.1 — user drag, mouse and touch alike.
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerUp);
    this.canvas.addEventListener("contextmenu", this.onContextMenu);
    if (typeof window !== "undefined") {
      window.addEventListener("resize", this.onResize);
      window.addEventListener("orientationchange", this.onResize);
    }
    // §9.11 — the motion preference can change mid-session, so it is watched
    // rather than sampled once. `stopWatchingMotion` tears the listener down in
    // `dispose()`; without that, every mount would leak a listener.
    this.stopWatchingMotion = watchReducedMotion((reduced) => this.rig.setReduceMotion(reduced));
  }

  /** The DOM canvas, for `document.hidden` checks and the screenshot helper. */
  get domElement(): HTMLCanvasElement {
    return this.canvas;
  }

  /**
   * Elapsed render time in seconds, advanced only by rendered frames.
   *
   * This is the clock §9.4's impact ages are measured against, and it is
   * deliberately *not* wall-clock: an impact's 2.5 s lifetime should expire in
   * 2.5 s of the piece being watched, not 2.5 s of the tab being open. Same
   * reasoning as the audio engine's injected clock in T3.5.
   */
  get clockNow(): number {
    return this.time;
  }

  /**
   * The governor's `scale` **is** the drawing-buffer pixel ratio, not a multiple
   * of `devicePixelRatio`.
   *
   * Spec §9.8 writes `setPixelRatio(dpr * renderScale)`, but that cannot be
   * reconciled with §12.3's table, whose values (`min(dpr, 2)`, `min(dpr, 1.5)`,
   * `1.0`) are pixel ratios. Reading `renderScale` as a dpr *multiple* forces the
   * low tier to a multiple of `1.0 / dpr` — 0.5 on a 2× display — which is below
   * §9.10's own floor of 0.55, so the floor would silently override the tier and
   * the low tier would render at 1.1 instead of 1.0. Logged in DECISIONS.md.
   *
   * Ceiling: `min(dpr, TIER_PARAMS[tier].maxRenderScale)` — §12.3, verbatim.
   */
  private pixelRatioCeiling(): number {
    this.dpr = typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1;
    return pixelRatioCeiling(this.dpr, this.tier);
  }

  /**
   * Match the drawing buffer to the CSS box, and apply the governor's scale.
   *
   * Called on construction, on resize, and whenever the governor changes scale.
   * §9.8 keeps the composer in step with this at T4.4.
   */
  resize(): void {
    const parent = this.canvas.parentElement;
    const w = Math.max(1, parent?.clientWidth ?? window.innerWidth ?? 1);
    const h = Math.max(1, parent?.clientHeight ?? window.innerHeight ?? 1);

    const ceiling = this.pixelRatioCeiling();
    // §9.10's 0.55 floor assumes an ordinary display. On dpr below ~0.55 (heavy
    // zoom-out, an unusual `resolution` override) the tier ceiling is lower still,
    // and the ceiling must win: rendering *above* the tier's budget is the one
    // thing the floor cannot grant. Taking `min` of the two also keeps `clamp`
    // from resolving the degenerate range differently on each side.
    const floor = Math.min(GOVERNOR.minScale, ceiling);
    const scale = clamp(this.governor.currentScale, floor, ceiling);

    this.appliedScale = scale;
    this.renderer.setPixelRatio(scale);
    this.renderer.setSize(w, h, true);

    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();

    // §9.8 — the composer's targets follow the same size, on every resize and on
    // every governor scale change. Called after `renderer.setSize` so the composer
    // reads the already-updated drawing buffer.
    this.post?.setSize(w, h);
  }

  addLayer(layer: RenderLayer): void {
    this.layers.push(layer);
    layer.attach?.(this.scene);
  }

  /** Start the rAF loop. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrame = 0;
    this.raf = requestAnimationFrame(this.frameCb);
  }

  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private tick(now: number): void {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frameCb);
    if (this.contextLost) return;

    if (this.lastFrame === 0) {
      // First frame after start or after a context restore: there is no previous
      // timestamp to difference against.
      this.lastFrame = now;
      return;
    }

    // Clamp before anything else sees it. See the note at the top of the file.
    const rawDtMs = now - this.lastFrame;
    this.lastFrame = now;
    const dtMs = Math.min(rawDtMs, THREE_MAX_DT_MS);
    const dtSec = dtMs / 1000;
    this.time += dtSec;
    const frameStart = now;

    this.frames.push(dtMs, now);
    this.palette.update(dtSec);

    // §9.1 — the clear colour tracks the palette's eased `deep`, so a harmony
    // event drifts the background rather than snapping it. `isSettled` makes
    // this free once the 2 s ease (§9.3) has finished.
    if (!this.palette.isSettled) this.applyClearColor();

    const hidden = typeof document !== "undefined" && document.hidden;
    const syncedMs = this.takeSyncedSample(frameStart);
    const g = this.governor.update(dtMs, now, hidden, syncedMs);
    if (g.changed) {
      // §9.10 / §9.8 — a level change sheds effects, and a scale change resizes the
      // composer's targets. Both live on the same event, so neither can be missed.
      this.post?.setGovernorLevel(this.governor.currentLevel);
      this.resize();
    }

    this.rig.update(dtSec, this.energy);
    this.applyRig();

    for (const layer of this.layers) layer.update?.(dtSec, this.time, this.camera);

    // §9.8 — the composer is the only thing that draws to screen. When post is off
    // (the low tier's own budget, or an explicit opt-out) the renderer's direct
    // draw is used instead, so nothing depends on the composer existing.
    if (this.post) {
      this.post.update(dtSec, this.rmsSmooth);
      this.post.render(dtSec);
    } else {
      this.renderer.render(this.scene, this.camera);
    }

    // `syncedMs` was sampled *above*, before this frame's draw — which is the point:
    // the readback there waits on the previous frame's commands, so under a saturated
    // pipeline it reports the real backlog rather than an idle GPU. Storing it after
    // the draw keeps the assignment next to the work it describes.
    if (syncedMs !== null) this.lastSyncedMs = syncedMs;
  }

  /**
   * Every `GOVERNOR.syncedStrideFrames`, time this frame end to end with the GPU
   * forced to finish. Returns `null` on the frames in between.
   *
   * **Why `readPixels` and not `gl.finish()`.** Measured, not assumed: under
   * Chromium's command-buffer WebGL `gl.finish()` does not block — a 400-iteration
   * control shader timed 0.0 ms through it. A 1×1 `readPixels` is the readback that
   * actually forces completion. The pixel *value* is discarded; only the elapsed time
   * is wanted, and reading the centre of the frame keeps the read inside the live
   * drawing buffer rather than depending on anything the scene drew there.
   *
   * **Why a stride.** The readback is a pipeline stall. Taking it every frame would
   * make the governor's own measurement a permanent part of the load it measures.
   *
   * Called after `renderer.render()`, inside the same rAF — outside one, the drawing
   * buffer may already have been composited and discarded.
   */
  private takeSyncedSample(frameStart: number): number | null {
    this.frameCount++;
    if (this.frameCount % GOVERNOR.syncedStrideFrames !== 0) return null;
    const gl = this.renderer.getContext();
    if (!gl) return null;
    const px = SYNCED_PIXEL;
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return performance.now() - frameStart;
  }

  /**
   * The drawing-buffer pixel ratio actually applied, after the governor's scale and
   * the tier ceiling. §9.7's point sizing needs it. A getter rather than a public
   * field so nothing can set it behind `resize`'s back.
   */
  get renderScale(): number {
    return this.appliedScale;
  }

  /** Feed global energy; the camera pulls in as traffic rises (§9.1). */
  setEnergy(energy: number): void {
    this.energy = clamp(energy, 0, 1);
  }

  /**
   * Feed the smoothed RMS that §9.8's bloom intensity follows.
   *
   * §9.11 requires this to be low-passed at τ ≥ 0.15 s, and that filtering lives in
   * `Post.update` — the value handed in is already the engine's smoothed RMS, and
   * applying a second filter here would double the lag for no benefit.
   */
  setRms(rms: number): void {
    this.rmsSmooth = clamp(rms, 0, 1);
  }

  /**
   * Attach §9.8's composer. Called once, after construction.
   *
   * The tier comes from the engine rather than from the caller so `Post` cannot be
   * built at a tier the governor is not actually running — a mismatch there shows up
   * as a composer whose bloom levels and grain opacity do not match the rest of the
   * scene, which is very hard to read as a tier bug.
   */
  attachPost(): Post | null {
    if (this.post) return this.post;
    // The low tier does not get a post stack by default: §12.2 pins software
    // rendering to low precisely because it cannot afford full-screen passes.
    if (this.tier === "low") return null;
    this.post = new Post({
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      tier: this.tier,
    });
    // `resize()` sizes the composer from the same CSS box it just gave the renderer,
    // so the two cannot disagree about the drawing buffer.
    this.resize();
    return this.post;
  }

  /** Retarget the palette — call on harmony events (§9.3). */
  setHarmony(mode: "lydian" | "mixolydian" | "dorian" | "aeolian", rootPc: number): void {
    this.palette.set(mode, rootPc, false);
    // The clear colour follows the palette (§9.1) — but through the *eased*
    // colour, not the target, so the background drifts with the scene instead of
    // snapping ahead of it.
    this.applyClearColor();
  }

  /** §9.1 — clear colour is the palette's current `deep`. Reused, not reallocated. */
  private applyClearColor(): void {
    const c = this.palette.current.deep;
    this.clearColor.setRGB(c.r, c.g, c.b, THREE.LinearSRGBColorSpace);
    this.renderer.setClearColor(this.clearColor, 1);
  }

  /** Switch tier and re-ceiling the governor (§8.12 allows a live switch). */
  setTier(tier: Tier): void {
    this.tier = tier;
    this.governor.setTierMaxScale(this.pixelRatioCeiling());
    this.resize();
  }

  /** §9.11 — honour a mid-session change to the motion preference. */
  setReduceMotion(on: boolean): void {
    this.rig.setReduceMotion(on);
  }

  /** §10.2 — fire a visual event's trauma shake, subject to reduced motion. */
  addTrauma(amount: number): void {
    this.rig.addTrauma(amount);
  }

  private applyRig(): void {
    const p = this.rig.position;
    this.camera.position.set(p.x, p.y, p.z);
    // The rig owns the pose; the camera is a consumer of it. Nothing writes
    // back, so a mid-session camera tweak cannot desynchronise the two.
    this.camera.lookAt(0, 0, 0);
  }

  /** Listener pose for the audio engine (§8.9). Reused — never reallocated. */
  readonly listenerPose: { position: Vec3; forward: Vec3 } = {
    position: { x: 0, y: 0, z: 0 },
    forward: { x: 0, y: 0, z: 1 },
  };

  /** Copy the rig's pose into `listenerPose` without allocating. */
  readListenerPose(): { position: Vec3; forward: Vec3 } {
    const p = this.rig.position;
    const f = this.rig.forward;
    this.listenerPose.position.x = p.x;
    this.listenerPose.position.y = p.y;
    this.listenerPose.position.z = p.z;
    this.listenerPose.forward.x = f.x;
    this.listenerPose.forward.y = f.y;
    this.listenerPose.forward.z = f.z;
    return this.listenerPose;
  }

  getStats(): RendererStats {
    const info = this.renderer.info;
    return {
      // Prefer the measured 1 s average; fall back to the EMA-derived value
      // until the first window closes, so the HUD is never blank at startup.
      fps: this.frames.fpsWindowed || this.frames.fps,
      emaMs: this.frames.frameMsEma,
      p95Ms: this.frames.frameMsP95,
      tier: this.tier,
      level: this.governor.currentLevel,
      scale: this.appliedScale,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      syncedMs: this.lastSyncedMs,
    };
  }

  dispose(): void {
    this.stop();
    this.stopWatchingMotion();
    for (const layer of this.layers) layer.dispose?.();
    this.layers.length = 0;
    this.post?.dispose();
    this.post = null;

    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    if (typeof window !== "undefined") {
      window.removeEventListener("resize", this.onResize);
      window.removeEventListener("orientationchange", this.onResize);
    }

    // Dispose the GPU resources this module created. The scene is empty until
    // layers are added, and each layer disposes its own.
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) for (const m of mat) m.dispose();
      else mat?.dispose();
    });
    this.scene.clear();
    this.renderer.dispose();

    if (this.ownsCanvas) this.canvas.remove();
  }
}
