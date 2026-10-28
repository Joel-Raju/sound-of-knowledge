"use client";

import { useEffect, useRef, useState } from "react";
import type { NoteFlavor } from "@/engine/types";

/**
 * Debug-only visual harness, rendered **only** under `?debug=1` by the server
 * (`app/page.tsx` reads `searchParams`).
 *
 * The `<canvas>` used to be rendered unconditionally, with only the *effect* gated: on
 * the production page that left a second full-viewport canvas above `Experience`'s
 * overlay in paint order, silently swallowing every click on Enter. Keyboard Enter
 * still worked, because that goes to the focused element — which is what made it read
 * as a flaky button rather than a z-order bug.
 *
 * Reading `window.location.search` during render to decide this was the first attempt
 * and it was worse: the server and the client's first render disagreed, and React
 * resolved it by discarding the server's markup (error #418).
 *
 * Like `DebugHarness`, the engine is **dynamically imported**: three.js is far larger
 * than the 40 KB production budget (§12.4), and a debug-only affordance must not cost
 * a production visitor a byte.
 *
 * The orb is mounted as a `RenderLayer` rather than wired into the renderer, so the
 * renderer keeps its promise of knowing nothing about what it draws (§9.4 owns the orb;
 * §9.1 owns the loop).
 */

/** The handle published on `window.__sok.visual`. */
export interface VisualHandle {
  engine: import("@/engine/visual/renderer").VisualEngine | null;
  orb: import("@/engine/visual/orb").Orb | null;
  sparks: import("@/engine/visual/sparks").Sparks | null;
  rings: import("@/engine/visual/rings").Rings | null;
  dust: import("@/engine/visual/dust").Dust | null;
  post: import("@/engine/visual/post").Post | null;
  /** "loading" | "ready" | "unsupported" | "error" */
  status: "loading" | "ready" | "unsupported" | "error";
  message?: string;
  stats(): ReturnType<import("@/engine/visual/renderer").VisualEngine["getStats"]> | null;
  /**
   * Fire `n` synthetic events so a capture has something to show.
   *
   * T4.3's debug-only spawn test pattern, and the same reason as `addImpacts`:
   * proving sparks and rings work needs a way to make one appear without a live
   * stream, and T4.3's acceptance criterion — "bright pixels > 0.2 %" — is
   * meaningless against an empty pool.
   */
  debugSpawn(n?: number): void;
  /**
   * Fire one synthetic note of a given flavor **through §10.2's fire table**.
   *
   * T4.5. `debugSpawn` used to call `sparks.spawnStreak` and friends directly, which
   * meant the table itself was never executed — only the layer methods beneath it
   * were. Routing every synthetic note through the director means the browser path
   * exercises the same code a live edit will, so T5.1 only has to change where the
   * `NoteEvent`s come from rather than rewrite the visuals.
   */
  debugFire(flavor: NoteFlavor): void;
  /** Live particle and ring counts, for the capture harness. */
  poolCounts(): { sparks: number; rings: number };
  /** §9.9 — how many anchors are currently showing. */
  labelCounts(): { active: number; notable: number };
  /**
   * §9.9's ticker feed — the most recent `notable` event, or null.
   *
   * Exposed now so the ticker can be verified before T5.2 builds the HUD that
   * consumes it. A feed nothing reads is a feed whose throttling is never observed.
   */
  lastNotable(): import("@/engine/visual/labels").NotableEvent | null;
  /** Preallocated three.js objects the spawn path reuses (§9.5, no allocation). */
  three: {
    dir: import("three").Vector3;
    origin: import("three").Vector3;
    toCore: import("three").Vector3;
    /** Cone centre for the debug pattern: the shell point furthest from the camera. */
    base: import("three").Vector3;
    /** Orthonormal basis scratch for building the cone. */
    auxA: import("three").Vector3;
    auxB: import("three").Vector3;
    accent: import("three").Color;
    core: import("three").Color;
  } | null;
  /** T4.5 — §10.2's fire table, wired to the real layers. */
  director: import("@/engine/visual/fire").VisualDirector | null;
  /** T4.5 — §9.9's six-anchor label pool. */
  labels: import("@/engine/visual/labels").LabelLayer | null;
  /**
   * Fire `n` synthetic impacts on a Fibonacci sphere. Exists so `shot.ts` and
   * the e2e suite can put structure on the orb without a live Wikipedia
   * stream — §9.4's ripples are the visual thing most likely to break silently.
   */
  addImpacts(n?: number, magnitude?: number, kind?: "push" | "dent"): void;
}

type SokWindow = Window & {
  __sok?: { visual?: VisualHandle; renderOffline?: unknown };
  __sokVisualReady?: boolean;
};

/** Deterministic stand-in for a live stream, so a screenshot is reproducible. */
const DEMO_FEATURES = {
  rms: 0.34,
  sub: 0.2,
  bass: 0.42,
  mid: 0.5,
  high: 0.22,
  air: 0.1,
  flux: 0.3,
};

/** §9.5 — edits spawn on a shell of radius 7–13 (§1047); the debug pattern uses ~9. */
const SPARK_SHELL = 9;

/**
 * Half-angle of the cone the debug pattern spawns into, in radians.
 *
 * §9.1 puts the camera at radius 5.5, **inside** the 7–13 shell, with a 58° FOV.
 * That means most of the shell is behind the viewer or outside the frustum: a
 * uniform Fibonacci sphere puts ~19 of 24 sparks off screen, and the acceptance
 * capture measures an empty frame while passing.
 *
 * So directions are spread over a cone centred on the point diametrically
 * opposite the camera — the far side of the shell, which is what §9.1 frames.
 *
 * The cone is wide (70°) rather than tight because sparks *converge* on the orb:
 * a narrow cone puts every particle on top of the core, which is the one part of
 * the frame bright enough to swallow an additive sprite. Wide enough, they arc in
 * across the dark background and are visible for most of their flight.
 */
const SPAWN_CONE = (70 * Math.PI) / 180;

/**
 * A direction on the spawn shell, within a cone around `base`.
 *
 * Fibonacci around the cone rather than a uniform sphere, and never seeded — the
 * *directions* must repeat exactly across runs or no two captures are
 * comparable, even though §9.5 makes the particle seeds random by design.
 *
 * `base` is the shell point furthest from the camera's view centre; the cone is
 * built around it with an arbitrary basis, which is enough because the pattern
 * only has to be evenly spread, not aligned to anything in the scene.
 */
function coneDirection(
  i: number,
  n: number,
  base: import("three").Vector3,
  out: import("three").Vector3,
  scratchA: import("three").Vector3,
  scratchB: import("three").Vector3,
): import("three").Vector3 {
  // Golden-angle spiral over the cone's disc: even coverage, no clustering at
  // the centre the way an equal-polar-step loop produces.
  const k = (i + 0.5) / n;
  const r = SPAWN_CONE * Math.sqrt(k);
  const theta = Math.PI * (1 + Math.sqrt(5)) * i;

  // Any pair orthogonal to `base` will do.
  scratchA.set(0, 1, 0);
  if (Math.abs(base.y) > 0.9) scratchA.set(1, 0, 0);
  scratchB.crossVectors(base, scratchA).normalize();
  scratchA.crossVectors(scratchB, base).normalize();

  return out
    .copy(base)
    .addScaledVector(scratchB, Math.cos(theta) * r)
    .addScaledVector(scratchA, Math.sin(theta) * r)
    .normalize();
}

/**
 * T4.5 — the flavor rotation `debugSpawn` walks.
 *
 * Weighted towards the streak flavors because they are what a capture measures, but
 * every §10.2 row appears: a capture taken with only streaks would never show that the
 * revert dent or the burst actually reach the screen.
 */
const DEBUG_SPAWN_FLAVORS: readonly NoteFlavor[] = [
  "add",
  "remove",
  "large",
  "add",
  "new",
  "revert",
  "bot-thud",
  "add",
  "bot-tick",
  "remove",
];

/**
 * A stand-in edit for synthetic notes.
 *
 * `importance` starts above §9.9's label threshold so `debugSpawn` can put a label on
 * screen — a debug path that never shows the feature is how that feature goes
 * unnoticed until T5.2 wires the HUD.
 */
const DEMO_EDIT: import("@/engine/types").NormalizedEdit = {
  id: 1,
  ts: 0,
  wiki: "enwiki",
  host: "en.wikipedia.org",
  lang: "en",
  project: "wikipedia",
  ns: 0,
  title: "Albert Einstein",
  actor: "registered",
  kind: "edit",
  minor: false,
  delta: 4200,
  absDelta: 4200,
  magnitude: 0.7,
  importance: 0.9,
  revNew: 5,
};

/**
 * A `NoteEvent` shaped exactly as the scheduler emits one, so §10.2's table cannot tell
 * a debug note from a real one.
 *
 * That is the whole point. `debugSpawn` used to call the layer methods directly, which
 * meant the table *above* them — the part that decides which edit becomes which visual
 * — was never executed in the browser at all. Building a real `NoteEvent` here means a
 * wrong flavor mapping shows up in a screenshot, not only in a unit test.
 */
function syntheticNote(
  flavor: NoteFlavor,
  shellPos: import("three").Vector3,
  magnitude: number,
): import("@/engine/types").NoteEvent {
  return {
    when: 0, // fired immediately; §10.2's arrival maths is relative to `now`
    voice: flavor === "revert" ? "gong" : "pluck",
    midi: 60,
    freq: 261.6,
    vel: 0.7,
    dir: { x: shellPos.x, y: shellPos.y, z: shellPos.z },
    radius: SPARK_SHELL,
    edit: {
      ...DEMO_EDIT,
      kind: flavor === "new" ? "new" : flavor === "revert" ? "revert" : "edit",
      actor: flavor === "bot-thud" || flavor === "bot-tick" ? "bot" : "registered",
      magnitude,
      importance: Math.min(1, magnitude + 0.2),
    },
    flavor,
    visual: true,
  };
}

/**
 * Debug-only visual harness. Spec T4.1 acceptance — "the main page (debug) shows
 * a dark canvas without console errors (Playwright smoke)" — extended by T4.2,
 * which puts the core orb on screen so `scripts/shot.ts` has something to
 * measure.
 *
 * **Only rendered under `?debug=1`, by the server** (`app/page.tsx` reads
 * `searchParams`). The `<canvas>` used to be rendered unconditionally, with only the
 * *effect* gated: on the production page that left a second full-viewport canvas
 * sitting above `Experience`'s overlay in paint order, so it silently swallowed every
 * click on Enter. Keyboard Enter still worked, because that goes to the focused
 * element — which is what made it read as a flaky button rather than a z-order bug.
 *
 * Reading `window.location.search` during render to decide this was the first attempt
 * and it was worse: the server and the client's first render disagreed, and React
 * resolved it by discarding the server's markup (error #418).
 *
 * Like `DebugHarness`, the engine is **dynamically imported**: three.js is far
 * larger than the 40 KB production budget (§12.4), and a debug-only affordance
 * must not cost a production visitor a byte.
 *
 * The orb is mounted as a `RenderLayer` rather than wired into the renderer, so
 * the renderer keeps its promise of knowing nothing about what it draws (§9.4
 * owns the orb; §9.1 owns the loop).
 */
export function VisualHarness(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const enabled = true;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("debug") !== "1") return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const w = window as SokWindow;
    const sok = w.__sok ?? {};

    const handle: VisualHandle = {
      engine: null,
      orb: null,
      sparks: null,
      rings: null,
      dust: null,
      post: null,
      status: "loading",
      stats: () => handle.engine?.getStats() ?? null,
      addImpacts: (n = 6, magnitude = 0.6, kind = "push") => {
        const orb = handle.orb;
        const engine = handle.engine;
        if (!orb || !engine) return;
        orb.addSyntheticImpacts(n, magnitude, kind, engine.clockNow);
      },
      debugSpawn: (n = 12) => {
        const engine = handle.engine;
        if (!engine) return;
        const three = handle.three;
        if (!three) return;

        // Point the cone away from the camera, so the sparks land on the far side
        // of the shell — the part §9.1's inside-the-cloud camera actually frames.
        three.base.copy(engine.camera.position).normalize().negate();

        for (let i = 0; i < n; i++) {
          const d = coneDirection(i, n, three.base, three.dir, three.auxA, three.auxB);
          three.origin.set(d.x * SPARK_SHELL, d.y * SPARK_SHELL, d.z * SPARK_SHELL);
          handle.debugFire(DEBUG_SPAWN_FLAVORS[i % DEBUG_SPAWN_FLAVORS.length]!);
        }
      },
      debugFire: (flavor: NoteFlavor) => {
        // Routed through the director, not straight to the layers — see `debugFire`
        // on `VisualHandle`.
        const director = handle.director;
        const three = handle.three;
        const engine = handle.engine;
        if (!director || !three || !engine) return;
        director.fire(
          syntheticNote(flavor, three.origin, 0.7),
          three.origin,
          engine.clockNow,
        );
      },
      poolCounts: () => ({
        sparks: handle.sparks?.spawned ?? 0,
        rings: handle.rings?.spawned ?? 0,
      }),
      labelCounts: () => ({
        active: handle.labels?.activeCount ?? 0,
        notable: notableSeen,
      }),
      lastNotable: () => lastNotable,
      three: null,
      director: null,
      labels: null,
    };
    sok.visual = handle;
    w.__sok = sok;

    let disposed = false;
    /** §9.9's ticker feed — counted here so `labelCounts` can report it. */
    let notableSeen = 0;
    let lastNotable: import("@/engine/visual/labels").NotableEvent | null = null;

    void (async () => {
      try {
        const mod = await import("@/engine/visual/renderer");
        if (disposed) return;

        // §11.3 — `?quality=low|medium|high` is a URL override, not persisted.
        // An explicit setting fixes the tier and disables the governor's
        // `improve()` beyond it, while still allowing `degrade()` (§9.10). It is
        // also the only way to inspect a tier other than the one the machine
        // detects — which under swiftshader is always `low`.
        const quality = params.get("quality");
        const forced =
          quality === "low" || quality === "medium" || quality === "high" ? quality : undefined;

        // `?deep=` sweeps §9.3's background lightness (C6). §9.8's tone mapping lifts it on
        // the way to the screen, so the authored value is not what the eye sees — and
        // that lift is the whole complaint.
        //
        // Set **before** the engine, because `VisualEngine` constructs its `Palette`
        // in its constructor and the override is consulted when the palette is built.
        // Setting it afterwards would silently do nothing.
        const deepArg = params.get("deep");
        if (deepArg !== null && Number.isFinite(Number(deepArg))) {
          const paletteMod = await import("@/engine/visual/palette");
          paletteMod.setDeepLightnessOverride(Number(deepArg));
        }

        const engine = new mod.VisualEngine({
          canvas,
          tier: forced,
          pinnedQuality: forced !== undefined,
        });
        if (disposed) {
          // The effect was torn down while the import was in flight — dispose
          // rather than leak a live WebGL context and a running rAF loop.
          engine.dispose();
          return;
        }

        // T4.2 — the core orb. Everything the visual engine needs from the audio
        // side arrives as `features`; with no stream attached, a fixed set stands
        // in so the orb is not a flat grey sphere in every screenshot.
        const orbModule = await import("@/engine/visual/orb");
        // `?jitter=` sweeps the march-jitter amplitude, so the screenshot
        // harness can compare settings without a rebuild per data point.
        const jitterArg = params.get("jitter");
        const jitter =
          jitterArg !== null && Number.isFinite(Number(jitterArg))
            ? Math.max(0, Math.min(1, Number(jitterArg)))
            : undefined;
        // `?absorb=` and `?emission=` sweep §9.4's core-detail terms (C11). Both are
        // runtime-switchable so a value can be looked at before it is committed.
        // `?deep=` sweeps §9.3's background lightness (C6). §9.8's tone mapping lifts it on
        // the way to the screen, so the authored value is not what the eye sees — and
        // the lift is the whole complaint.
        const absorbArg = Number(params.get("absorb"));
        const emissionArg = Number(params.get("emission"));
        const orb = new orbModule.Orb({
          tier: engine.tier,
          jitter,
          absorb: Number.isFinite(absorbArg) && params.get("absorb") !== null ? absorbArg : undefined,
          emission:
            Number.isFinite(emissionArg) && params.get("emission") !== null
              ? emissionArg
              : undefined,
        });

        engine.addLayer({
          attach: (scene) => {
            scene.add(orb.mesh);
          },
          update: (_dt, time) => {
            orb.update(time, DEMO_FEATURES, engine.palette);
          },
          dispose: () => orb.dispose(),
        });

        // T4.3 — sparks and rings, as their own layers so each owns its update
        // (they share only `uTime`). Sparks sit above the orb in draw order and
        // are additive, so the scene needs no sorting between them.
        //
        // `?nosparks=1` omits both layers entirely. §9.5 draws every instance every
        // frame, so the pool costs the same whether or not anything is alive — the
        // only way to measure what the instanced draw actually costs is to compare
        // against a scene that does not have it.
        if (params.get("nosparks") !== "1") {
          const sparksMod = await import("@/engine/visual/sparks");
          const ringsMod = await import("@/engine/visual/rings");
          const dustMod = await import("@/engine/visual/dust");
          const sparks = new sparksMod.Sparks({ tier: engine.tier });
          const rings = new ringsMod.Rings();
          // T4.4 — §9.7's ambient dust, behind everything per §9.2's order.
          const dust = new dustMod.Dust({ tier: engine.tier });

          // `?dustAlpha=` and `?dustDensity=` drive the two quantities the C11b
          // decision turns on — §9.7's twinkle formula spans [0.25, 1.0] but never
          // says what it multiplies, so the base opacity is unspecified and this is
          // where a chosen value comes from. Both exist so the choice can be swept
          // and looked at rather than argued about.
          const dustAlpha = Number(params.get("dustAlpha"));
          if (Number.isFinite(dustAlpha) && params.get("dustAlpha") !== null) {
            dust.setBaseAlpha(Math.max(0, Math.min(1, dustAlpha)));
          }
          const dustDensity = Number(params.get("dustDensity"));
          if (Number.isFinite(dustDensity) && params.get("dustDensity") !== null) {
            dust.setDensity(Math.max(0, Math.min(4, dustDensity)));
          }

          engine.addLayer({
            attach: (scene) => {
              scene.add(dust.points);
              scene.add(sparks.mesh);
              scene.add(rings.mesh);
            },
            update: (_dt, time) => {
              dust.update(
                time,
                engine.renderScale,
                DEMO_FEATURES.high,
                engine.palette.current.dust,
              );
              sparks.update(time);
              rings.update(time);
            },
            dispose: () => {
              dust.dispose();
              sparks.dispose();
              rings.dispose();
            },
          });
          handle.sparks = sparks;
          handle.rings = rings;
          handle.dust = dust;

          // §9.11 — the orb's ripple amplitude and the sparks' duration both follow
          // the motion preference, and both are registered here so they cannot be
          // implemented on the rig and then missed on the layers.
          engine.addReducedMotionConsumer(orb);
          engine.addReducedMotionConsumer(sparks);

          // Scratch objects for `debugSpawn`. Preallocated here rather than inside
          // the spawn path so firing n particles allocates nothing (§9.5, §12.1).
          const THREE = await import("three");
          const pal = engine.palette.current;
          handle.three = {
            dir: new THREE.Vector3(),
            origin: new THREE.Vector3(),
            toCore: new THREE.Vector3(),
            base: new THREE.Vector3(),
            auxA: new THREE.Vector3(),
            auxB: new THREE.Vector3(),
            // `Palette` speaks `Rgb`; the spark attributes take `THREE.Color`.
            accent: new THREE.Color(pal.accent.r, pal.accent.g, pal.accent.b),
            core: new THREE.Color(pal.core.r, pal.core.g, pal.core.b),
          };
        }

        engine.start();
        handle.engine = engine;
        handle.orb = orb;
        // T4.4 — §9.8's composer. Attached before `start()` so no frame is ever drawn
        // directly and then composited; `?nopost=1` forces the direct path, which is
        // how the A/B against the previous T4.3 captures is taken.
        handle.post =
          params.get("nopost") === "1"
            ? null
            : engine.attachPost({
                // C11 — AgX vs ACES, switchable so they can be compared in one sweep.
                toneMapping: params.get("tonemap") === "aces" ? "aces" : "agx",
              });
        // `?nobloom=1` and `?novignette=1` isolate individual §9.8 effects. Needed
        // because tone mapping turned out **not** to be what lifts the background or
        // flattens the orb — so the sweep has to be able to switch effects off, not
        // just curves.
        if (handle.post) {
          if (params.get("nobloom") === "1") handle.post.setEnabled("bloom", false);
          if (params.get("novignette") === "1") handle.post.setEnabled("vignette", false);
          if (params.get("nonoise") === "1") handle.post.setEnabled("noise", false);
        }

        // --- T4.5 — §9.9's label pool and §10.2's fire table ---------------
        //
        // The label layer is appended to `document.body`, not rendered by React: it owns
        // six `<a>` elements it mutates every frame, and handing that to React's
        // reconciler would cost a diff per frame to change six transforms.
        const labelsMod = await import("@/engine/visual/labels");
        const labels = new labelsMod.LabelLayer(document, (e) => {
          notableSeen++;
          lastNotable = e;
        });
        document.body.appendChild(labels.layer);
        handle.labels = labels;

        const fireMod = await import("@/engine/visual/fire");
        const THREE = await import("three");
        const palette = engine.palette;
        // §9.9/§10.2 speak in `THREE.Color`; `Palette` speaks `Rgb`. One pooled
        // `THREE.Color` per call site rather than an allocation per note (§12.1).
        const toColor = new THREE.Color();
        const director = new fireMod.VisualDirector({
          sparks: {
            spawnStreak: (o, d, c, m, opts) => handle.sparks!.spawnStreak(o, d, c, m, opts),
            spawnBurst: (o, c, m) => handle.sparks!.spawnBurst(o, c, m),
            spawnBotPulse: (o, d, c, m) => handle.sparks!.spawnBotPulse(o, d, c, m),
          },
          rings: { spawn: (o, c, at) => handle.rings!.spawn(o, c, at) },
          orb: { addImpact: (d, m, k, at) => handle.orb!.addImpact(d, m, k, at) },
          colorFor: (kind, magnitude) => {
            // `Palette.colorFor` is the one place that knows how an event kind maps to
            // a colour (the `large` mix, the `revert` push toward white, …). Reading
            // `palette.current[...]` here would have bypassed all of it.
            const rgb = palette.colorFor(kind, magnitude);
            return toColor.setRGB(rgb.r, rgb.g, rgb.b);
          },
          post: handle.post ?? undefined,
          addTrauma: (a) => engine.rig.addTrauma(a),
          labels,
        });
        handle.director = director;

        // §10.2's deferred impacts are flushed per frame — "a small fixed array
        // `pendingImpacts[32]` … flushed each frame". Attached as a layer so it runs
        // inside the existing rAF loop rather than on a timer of its own.
        engine.addLayer({
          attach: () => {},
          update: (_dt, time) => {
            director.flush(time);
            labels.update(
              time,
              engine.camera,
              canvas.clientWidth,
              canvas.clientHeight,
            );
          },
          dispose: () => labels.dispose(),
        });

        // `handle.sparks` / `handle.rings` / `handle.dust` are set above, inside the
        // `?nosparks` guard — they stay null when the layers are not mounted.
        handle.status = "ready";
        setError(null);
      } catch (err) {
        if (disposed) return;
        // Duck-typed by name: the engine module is what threw, and importing it
        // again here to test the class would defeat the dynamic import.
        const message = err instanceof Error ? err.message : String(err);
        handle.status =
          err instanceof Error && err.name === "WebGL2Unavailable" ? "unsupported" : "error";
        handle.message = message;
        setError(message);
      } finally {
        if (!disposed) w.__sokVisualReady = true;
      }
    })();

    return () => {
      disposed = true;
      handle.engine?.dispose();
      handle.engine = null;
      handle.orb = null;
      handle.sparks = null;
      handle.rings = null;
      handle.dust = null;
      handle.three = null;
      handle.director = null;
      handle.labels = null;
      lastNotable = null;
      handle.status = "loading";
      if (w.__sok?.visual === handle) delete w.__sok.visual;
    };
  }, []);

  // Rendered only under `?debug=1` — see the `enabled` note above. On the debug page
  // the canvas is always present so the engine has a real layout box to size against.
  if (!enabled) return <></>;
  return (
    <>
      <canvas
        ref={canvasRef}
        data-testid="visual-canvas"
        className="fixed inset-0 h-full w-full bg-black"
        aria-label="Sound of Knowledge visual field"
      />
      {error !== null && (
        <div
          data-testid="visual-error"
          className="fixed inset-x-0 bottom-0 z-10 bg-neutral-900/90 p-3 text-xs text-neutral-300"
        >
          {error}
        </div>
      )}
    </>
  );
}
