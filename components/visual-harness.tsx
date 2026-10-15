"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Debug-only visual harness. Spec T4.1 acceptance — "the main page (debug) shows
 * a dark canvas without console errors (Playwright smoke)" — extended by T4.2,
 * which puts the core orb on screen so `scripts/shot.ts` has something to
 * measure.
 *
 * Like `DebugHarness`, the engine is **dynamically imported**: three.js is far
 * larger than the 40 KB production budget (§12.4), and a debug-only affordance
 * must not cost a production visitor a byte.
 *
 * The orb is mounted as a `RenderLayer` rather than wired into the renderer, so
 * the renderer keeps its promise of knowing nothing about what it draws (§9.4
 * owns the orb; §9.1 owns the loop).
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
  /** Live particle and ring counts, for the capture harness. */
  poolCounts(): { sparks: number; rings: number };
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

export function VisualHarness(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        const sparks = handle.sparks;
        const rings = handle.rings;
        const orb = handle.orb;
        if (!engine || !sparks || !orb) return;
        const three = handle.three;
        if (!three) return;
        const t = engine.clockNow;
        const dir = three.dir; // preallocated Vector3
        const origin = three.origin;
        const toCore = three.toCore;
        const colour = three.accent;
        const core = three.core;

        // Point the cone away from the camera, so the sparks land on the far side
        // of the shell — the part §9.1's inside-the-cloud camera actually frames.
        three.base.copy(engine.camera.position).normalize().negate();

        for (let i = 0; i < n; i++) {
          const d = coneDirection(i, n, three.base, dir, three.auxA, three.auxB);
          origin.set(d.x * SPARK_SHELL, d.y * SPARK_SHELL, d.z * SPARK_SHELL);
          // Inward: §9.5's target is dirToCore * 1.25.
          toCore.set(-d.x, -d.y, -d.z);
          if (i % 5 === 4) {
            sparks.spawnBurst(origin, core, 0.8);
          } else if (i % 7 === 6) {
            sparks.spawnBotPulse(origin, toCore, colour, 0.4);
          } else {
            sparks.spawnStreak(origin, toCore, colour, 0.7);
          }
        }
        if (rings) {
          for (let i = 0; i < 3; i++) {
            const d = coneDirection(i, 3, three.base, dir, three.auxA, three.auxB);
            origin.set(d.x * SPARK_SHELL, d.y * SPARK_SHELL, d.z * SPARK_SHELL);
            rings.spawn(origin, core, t);
            toCore.set(d.x, d.y, d.z);
            orb.addImpact(toCore, 0.8, "dent", t);
          }
        }
      },
      poolCounts: () => ({
        sparks: handle.sparks?.spawned ?? 0,
        rings: handle.rings?.spawned ?? 0,
      }),
      three: null,
    };
    sok.visual = handle;
    w.__sok = sok;

    let disposed = false;

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
        const orb = new orbModule.Orb({ tier: engine.tier, jitter });

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
      handle.status = "loading";
      if (w.__sok?.visual === handle) delete w.__sok.visual;
    };
  }, []);

  // The canvas is always mounted so the debug page has a real layout box to size
  // against; without `?debug=1` it stays empty and transparent.
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
