"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Debug-only visual harness. Spec T4.1 acceptance — "the main page (debug) shows
 * a dark canvas without console errors (Playwright smoke)".
 *
 * Like `DebugHarness`, the engine is **dynamically imported**: three.js is far
 * larger than the 40 KB production budget (§12.4), and a debug-only affordance
 * must not cost a production visitor a byte. This mounts `VisualEngine` on a
 * full-viewport canvas, driven by the palette's `deep` clear colour (§9.1).
 *
 * It exposes `window.__sok.visual` for the e2e tests and later tasks (the visual
 * queue in T4.5 attaches through the same handle).
 */

/** The handle published on `window.__sok.visual`. Mirrors `RendererStats`. */
export interface VisualHandle {
  /** The live engine. Absent until `status` is "ready". */
  engine: import("@/engine/visual/renderer").VisualEngine | null;
  /** "loading" | "ready" | "unsupported" | "error" */
  status: "loading" | "ready" | "unsupported" | "error";
  /** Message for `unsupported` / `error`. */
  message?: string;
  stats(): ReturnType<import("@/engine/visual/renderer").VisualEngine["getStats"]> | null;
}

type SokWindow = Window & {
  __sok?: { visual?: VisualHandle; renderOffline?: unknown };
  __sokVisualReady?: boolean;
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
      status: "loading",
      stats: () => handle.engine?.getStats() ?? null,
    };
    sok.visual = handle;
    w.__sok = sok;

    let disposed = false;

    void (async () => {
      try {
        const mod = await import("@/engine/visual/renderer");
        if (disposed) return;

        const engine = new mod.VisualEngine({ canvas });
        if (disposed) {
          // The effect was torn down while the import was in flight — dispose
          // rather than leak a live WebGL context and a running rAF loop.
          engine.dispose();
          return;
        }

        engine.start();
        handle.engine = engine;
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
