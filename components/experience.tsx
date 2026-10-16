"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Engine, loadSettings, type Metrics } from "@/engine";
import { readUrlOverrides } from "@/engine/settings";
import { StartOverlay } from "./start-overlay";
import { Hud } from "./hud";
import { ErrorBanner, NoWebGL, type ErrorKind } from "./error-banner";

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
export function Experience({
  debug = false,
  search = "",
}: {
  debug?: boolean;
  /** the page's query string, passed down from the server component */
  search?: string;
}): React.JSX.Element {

  const mountRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<Engine | null>(null);

  // §11.3 — URL overrides, resolved once per render from the query string the server
  // passed down. `?source=` is the DATA mode (live/replay/synthetic); `?project=` is
  // `Settings.source` (wikipedias / no-wikidata / all). Two different meanings, two
  // parameters — collapsing them would break both.
  const { settings: urlSettings, data } = useMemo(
    () => readUrlOverrides(search, loadSettings()),
    [search],
  );
  const dataMode = data.mode;
  const seed = data.seed;

  const [phase, setPhase] = useState<"preparing" | "ready" | "failed">("preparing");
  const [fatal, setFatal] = useState<string | null>(null);
  const [entered, setEntered] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [hudHidden, setHudHidden] = useState(false);
  /** §11.8 — which banner, if any. `null` is the common case. */
  const [banner, setBanner] = useState<{ kind: ErrorKind; detail?: string } | null>(null);
  /** §11.7/§11.8 — the context being suspended or interrupted is recoverable. */
  const [audioSuspended, setAudioSuspended] = useState(false);

  useEffect(() => {
    if (debug) return;
    const mount = mountRef.current;
    if (!mount) return;

    let cancelled = false;
    void (async () => {
      try {
        const engine = await Engine.create({
          container: mount,
          // §11.3 — URL overrides. Read on the server from `searchParams` and handed
          // down, because reading `window.location` during render is a hydration
          // mismatch (React #418, seen in T5.1).
          settings: urlSettings,
          data: { mode: dataMode, seed: seed },
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
        // Held in state as well as a ref: the HUD renders from it, and a ref change
        // does not re-render. Two sources on purpose — the ref is for the imperative
        // gesture path, the state is for rendering.
        setEngine(engine);

        engine.on("error", (p) => {
          // §11.2/§11.8 — an audio failure keeps the visuals running, muted. A blank
          // canvas is a worse failure than a silent one that still moves.
          if (p.code === "audio" || p.code === "worklet") {
            setAudioError(p.message);
            setBanner({ kind: p.code, detail: p.message });
          } else if (p.code === "stream") {
            setBanner({ kind: "stream", detail: p.message });
          }
        });

        // §6.6/§11.8 — a stream that cannot be reached falls back to replay
        // automatically, which is a state the visitor should be told about but not
        // asked to act on. `reconnecting` is transient and not banner-worthy.
        engine.on("status", (p) => {
          if (p.stream === "replay") setBanner({ kind: "stream", detail: p.detail });
          else if (p.stream === "live") setBanner((b) => (b?.kind === "stream" ? null : b));
        });

        // §11.8 — `webglcontextlost` → "restoring…"; if the rebuild fails, offer Reload.
        engine.on("gl", (p) => {
          setBanner({ kind: p.restored ? "gl-lost" : "gl-failed" });
          if (p.restored) {
            // Clear on the next tick once a frame is actually drawing again, rather
            // than leaving a banner over a working canvas.
            window.setTimeout(() => setBanner((b) => (b?.kind === "gl-lost" ? null : b)), 1_200);
          }
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
      setEngine(null);
    };
    // `urlSettings` / `dataMode` / `seed` are derived from `search` by `useMemo`, so
    // they are stable for a given URL and re-running on them only rebuilds the engine
    // when the query string actually changed — which is the point of listing them.
  }, [debug, urlSettings, dataMode, seed]);

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

  /**
   * §8.2 / §11.8 — a suspended or interrupted context only resumes on a gesture.
   *
   * Polled rather than event-driven because the reasons a context suspends are a
   * browser's business, not ours: a tab switch, a phone call, an OS audio-focus
   * change, or the piece being backgrounded on mobile. The check runs on the `stats`
   * event, which is already capped at 4 Hz, so this costs nothing extra.
   */
  useEffect(() => {
    if (!engine) return;
    return engine.on("stats", () => {
      const suspended = engine.getMetrics().audioState !== "running";
      setAudioSuspended(suspended && engine.getMetrics().audioState !== "none");
    });
  }, [engine]);

  /** §11.8 — the Resume audio affordance. Must be a gesture; it is a click. */
  const resumeAudio = useCallback(() => {
    void engineRef.current?.resumeAudio().then(
      () => {
        setAudioSuspended(false);
        setAudioError(null);
        setBanner((b) => (b?.kind === "audio" ? null : b));
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

  // §11.8 — "WebGL2 unsupported → static message, no experience". Owned here rather
  // than inside `StartOverlay` so there is exactly one message for this condition
  // instead of two that can drift apart.
  if (phase === "failed") return <NoWebGL detail={fatal ?? undefined} />;

  return (
    // `h-dvh` but deliberately **no `w-dvh`**. With `position: fixed` and
    // `inset-0`, adding an explicit width over-constrains the box: CSS resolves
    // `left`/`width`/`right` by ignoring `right`, so `w-dvh` sized the container to
    // 100 units of viewport **height** and left the right-hand part of the window
    // unpainted. `h-dvh` is kept because §11.7 wants the height to track the mobile
    // toolbar, and the same over-constraint is desirable there.
    <div ref={mountRef} className="fixed inset-0 h-dvh bg-black">
      {(!entered || !dismissed) && (
        <StartOverlay
          ready={phase === "ready"}
          entered={entered}
          fatal={fatal}
          audioError={audioError}
          onEnter={enter}
        />
      )}
      {/* §11.8 — a suspended context is recoverable, so it gets the Resume button;
          §11.7 — iOS interrupts for calls and app switches, which is the common case. */}
      {entered && audioSuspended && !banner && (
        <ErrorBanner kind="audio" onResumeAudio={resumeAudio} />
      )}
      {banner && (
        <ErrorBanner
          kind={banner.kind}
          detail={banner.detail}
          onResumeAudio={banner.kind === "audio" || banner.kind === "worklet" ? resumeAudio : undefined}
          onReload={banner.kind === "gl-failed" ? () => window.location.reload() : undefined}
          onDismiss={() => setBanner(null)}
        />
      )}
      {/* §11.4 — the HUD appears once the piece has started, so it does not compete
          with the overlay for the only thing the visitor is looking at. */}
      {entered && <Hud engine={engine} hidden={hudHidden} onHiddenChange={setHudHidden} />}
    </div>
  );
}