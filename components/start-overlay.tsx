"use client";

import { useState } from "react";

/**
 * §11.2 — the start overlay.
 *
 * The button is disabled showing "Preparing…" until `Engine.create()` resolves, which
 * is what makes §11.2's "shader warm-up before enabling Enter" real: the prop is not
 * "the module loaded", it is "a frame has been drawn".
 *
 * **The overlay does not unmount on enter, it fades.** It stays mounted for 1.2 s so
 * the transition is a CSS opacity change; removing it outright snaps the first frame
 * of the piece into full brightness, which reads as a flash.
 */
export function StartOverlay({
  ready,
  entered,
  fatal,
  audioError,
  onEnter,
}: {
  ready: boolean;
  /** the parent reports success; the fade follows it, not the click */
  entered: boolean;
  /** §11.2 — WebGL2 unavailable: a static message, no Enter button. */
  fatal: string | null;
  audioError: string | null;
  onEnter: () => void;
}): React.JSX.Element {
  const [showHow, setShowHow] = useState(false);

  /**
   * `onEnter()` runs **synchronously inside the handler**.
   *
   * §8.2: an `AudioContext` may only be created from a user gesture. Deferring this
   * by even one macrotask loses the gesture, and the browser then leaves the context
   * suspended — which presents as a mute bug, not as a permission error, and is very
   * hard to trace back to a `setTimeout`. So the fade is driven by the `entered` prop
   * the parent sets *after* `start()` resolves, not by anything here.
   */
  const enter = (): void => {
    if (!ready || fatal || entered) return;
    onEnter();
  };

  return (
    <div
      data-testid="start-overlay"
      className={`absolute inset-0 z-20 flex flex-col items-center justify-center gap-6 bg-neutral-950/90 px-6 text-center transition-opacity duration-[1200ms] ${
        entered ? "pointer-events-none opacity-0" : "opacity-100"
      }`}
    >
      <h1 className="text-3xl font-semibold tracking-tight text-neutral-100 sm:text-4xl">
        Sound of Knowledge
      </h1>
      <p className="max-w-md text-balance text-sm text-neutral-400">
        Listen to humanity writing its encyclopedia, live.
      </p>

      {fatal ? (
        // §11.2 — no Enter button when there is nothing to enter.
        <p
          data-testid="start-fatal"
          className="max-w-md text-sm text-neutral-500"
          role="status"
        >
          This piece needs WebGL2, which this browser or device does not appear to
          support. {fatal}
        </p>
      ) : (
        <>
          <button
            data-testid="enter-button"
            type="button"
            disabled={!ready || entered}
            onClick={enter}
            className="rounded-full border border-neutral-700 px-8 py-3 text-sm text-neutral-100 transition-colors enabled:hover:border-neutral-400 disabled:cursor-wait disabled:text-neutral-600"
          >
            {ready ? "Enter" : "Preparing…"}
          </button>
          <p className="text-xs text-neutral-600">Best with headphones.</p>
        </>
      )}

      {audioError && (
        // §11.2 — the worklet failing still runs visuals, muted. Said plainly, because
        // a silent piece with no explanation reads as broken rather than degraded.
        <p
          data-testid="start-audio-error"
          className="max-w-md text-xs text-amber-700/80"
          role="status"
        >
          Audio could not start, so this is silent. The visuals are still running.{" "}
          {audioError}
        </p>
      )}

      <div className="mt-2 flex items-center gap-4 text-xs text-neutral-600">
        <button
          type="button"
          data-testid="how-it-works"
          onClick={() => setShowHow((v) => !v)}
          className="underline underline-offset-4 hover:text-neutral-400"
        >
          How it works
        </button>
        <a
          href="https://github.com/"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-4 hover:text-neutral-400"
        >
          GitHub
        </a>
      </div>

      {showHow && (
        <p
          data-testid="how-it-works-body"
          className="max-w-lg text-pretty text-xs leading-relaxed text-neutral-500"
        >
          Every edit to Wikipedia becomes a note. Its length tells you the size of the
          change, its pitch the article it touched, and its direction in space which
          language it came from. Reverts ring outward and dent the orb. New pages
          burst. Nothing is sampled away silently — the meter reports what was really
          played.
        </p>
      )}
    </div>
  );
}