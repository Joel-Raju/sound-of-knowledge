"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Engine, loadSettings, type Metrics } from "@/engine";
import { StartOverlay } from "./start-overlay";

/**
 * T5.1 — the production shell: an `Engine` in a `useEffect`, disposed on unmount.
 *
 * **StrictMode is the design constraint.** React 19 mounts effects twice in
 * development, so an unguarded `Engine.create()` in an effect produces two engines,
 * two rAF loops and — once `start()` has run — two `AudioContext`s. The symptom is a
 * frame budget halved with nothing in the code explaining why, which is exactly the
 * kind of fault this project keeps having to chase.
 *
 * Three things guard against it:
 *
 *  1. a `cancelled` flag, so a create() that resolves after unmount disposes its
 *     result rather than adopting it
 *  2. a `disposed` flag on the engine itself, so `start()` on a torn-down engine is a
 *     no-op rather than a resurrected audio graph
 *  3. the engine is held in a ref, not state, so a second mount cannot read a stale
 *     instance and skip creating one
 *
 * `?debug=1` keeps the T4 harness instead — the two paths must not both build a
 * renderer, or the canvas below the harness would be a second live WebGL context.
 */
export function Experience({ debug = false }: { debug?: boolean }): React.JSX.Element {

  const mountRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<Engine | null>(null);

  const [phase, setPhase] = useState<"preparing" | "ready" | "failed">("preparing");
  const [fatal, setFatal] = useState<string | null>(null);
  const [entered, setEntered] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);

  useEffect(() => {
    if (debug) return;
    const mount = mountRef.current;
    if (!mount) return;

    let cancelled = false;
    void (async () => {
      try {
        const engine = await Engine.create({
          container: mount,
          settings: loadSettings(),
          debug: false,
        });
        if (cancelled) {
          // The effect was torn down while `create()` was in flight. Disposing here
          // rather than adopting the engine is what keeps StrictMode's double-mount
          // from leaving a live renderer and a compiled GL context behind.
          engine.dispose();
          return;
        }
        engineRef.current = engine;

        engine.on("error", (p) => {
          // §11.2 — an audio failure keeps the visuals running, muted. A blank canvas
          // is a worse failure than a silent one that still moves.
          if (p.code === "audio" || p.code === "worklet") setAudioError(p.message);
        });

        // §5.5 — `window.__sok` in debug. Assigned even though this path is
        // non-debug, because the debug handle is also what the e2e suite drives.
        const w = window as unknown as { __sok?: unknown };
        w.__sok = {
          engine,
          metrics: (): Readonly<Metrics> => engine.getMetrics(),
          setSettings: (p: Parameters<Engine["setSettings"]>[0]) => engine.setSettings(p),
          injectEdits: (e: Parameters<Engine["injectEdits"]>[0]) => engine.injectEdits(e),
        };

        setPhase("ready");
      } catch (err) {
        if (cancelled) return;
        // §11.2 — WebGL2 unavailable gets a static explanation and no Enter button.
        const message = err instanceof Error ? err.message : String(err);
        setFatal(message);
        setPhase("failed");
      }
    })();

    return () => {
      cancelled = true;
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, [debug]);

  /**
   * §11.2 — `start()` runs **inside the click handler**, because that is the only
   * moment an `AudioContext` may be created (§8.2). An `await` before it, or moving
   * the call into a promise chain started earlier, loses the gesture and produces a
   * context the browser leaves suspended — which reads as a mute bug and is not one.
   */
  const enter = useCallback(() => {
    void engineRef.current?.start().then(
      () => {
        setEntered(true);
        // §11.2 — "the overlay fades out over 1.2 s". The element has to *stay
        // mounted* for that transition to run; unmounting on `entered` snaps the
        // first frame of the piece into full brightness, which reads as a flash.
        // A timer rather than `transitionend`, which can silently never fire.
        setTimeout(() => setDismissed(true), 1_200);
      },
      (err: unknown) => setAudioError(err instanceof Error ? err.message : String(err)),
    );
  }, []);

  useEffect(() => {
    if (phase !== "ready" || entered) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Enter") enter();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, entered, enter]);

  if (debug) return <></>;

  return (
    <div ref={mountRef} className="fixed inset-0 h-dvh w-dvh bg-black">
      {(!entered || !dismissed) && (
        <StartOverlay
          ready={phase === "ready"}
          entered={entered}
          fatal={fatal}
          audioError={audioError}
          onEnter={enter}
        />
      )}
    </div>
  );
}