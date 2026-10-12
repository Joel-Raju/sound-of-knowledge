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
  /** "loading" | "ready" | "unsupported" | "error" */
  status: "loading" | "ready" | "unsupported" | "error";
  message?: string;
  stats(): ReturnType<import("@/engine/visual/renderer").VisualEngine["getStats"]> | null;
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
      status: "loading",
      stats: () => handle.engine?.getStats() ?? null,
      addImpacts: (n = 6, magnitude = 0.6, kind = "push") => {
        const orb = handle.orb;
        const engine = handle.engine;
        if (!orb || !engine) return;
        orb.addSyntheticImpacts(n, magnitude, kind, engine.clockNow);
      },
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
        const orb = new orbModule.Orb({ tier: engine.tier });

        engine.addLayer({
          attach: (scene) => {
            scene.add(orb.mesh);
          },
          update: (_dt, time) => {
            orb.update(time, DEMO_FEATURES, engine.palette);
          },
          dispose: () => orb.dispose(),
        });

        engine.start();
        handle.engine = engine;
        handle.orb = orb;
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
