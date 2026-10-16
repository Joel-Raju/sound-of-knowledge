"use client";

import { useState } from "react";

/**
 * §11.8 — the error and edge states, and the one banner that shows them.
 *
 * Every condition in §11.8 is a **distinct** thing the visitor can act on, so they get
 * distinct copy and distinct affordances rather than one generic "something went
 * wrong". Three of them carry a button; a message the visitor cannot act on is worse
 * than no message, because it tells them the piece is broken without saying whether
 * they are the cause or what to try.
 *
 * ```txt
 * WebGL2 unsupported   → static message, no experience        (StartOverlay, not here)
 * Worklet load fails   → banner, visuals only                (audioError)
 * Audio suspended      → Resume audio button                 (resumeAudio)
 * Stream down          → amber, automatic replay fallback    (streamState)
 * Context lost         → "restoring…" then Reload if it fails (glLost)
 * ```
 */
export type ErrorKind =
  | "audio"
  | "worklet"
  | "stream"
  | "gl-lost"
  | "gl-failed";

export interface ErrorBannerProps {
  kind: ErrorKind;
  detail?: string;
  /** shown for `audio` / `worklet` — §11.8 says run visuals only, so this is offered */
  onResumeAudio?: () => void;
  /** shown for `gl-failed` — §11.8 says offer Reload */
  onReload?: () => void;
  onDismiss?: () => void;
}

const COPY: Record<ErrorKind, { title: string; body: string }> = {
  audio: {
    title: "Audio is paused",
    // §8.2 — a suspended context resumes on a gesture, never on its own.
    body: "Your browser paused the audio context. Resume it to hear the piece again — the visuals are still running.",
  },
  worklet: {
    title: "Audio engine failed to load",
    // §11.2/§11.8 — visuals continue, muted.
    body: "Sound could not start on this device, so this is silent. Everything visual is still working.",
  },
  stream: {
    title: "Live feed unavailable",
    // §6.6 — the automatic fallback.
    body: "Wikipedia's live feed is not reachable, so this is playing a recording instead. It will switch back on its own.",
  },
  "gl-lost": {
    title: "Display reset — restoring…",
    body: "The graphics context was released by the system. Putting it back together.",
  },
  "gl-failed": {
    title: "Graphics could not be restored",
    body: "The browser released the graphics context and it could not be rebuilt. Reloading usually fixes this.",
  },
};

export function ErrorBanner({
  kind,
  detail,
  onResumeAudio,
  onReload,
  onDismiss,
}: ErrorBannerProps): React.JSX.Element {
  const { title, body } = COPY[kind];
  // `gl-lost` is transient and self-resolving; dismissing it would leave a black canvas
  // with nothing explaining why.
  const dismissible = kind !== "gl-lost";

  return (
    <div
      data-testid="error-banner"
      data-kind={kind}
      // §11.6 — announced, but assertively: this is a state change the visitor needs,
      // not a running status they can wait out.
      role="alert"
      className="fixed inset-x-0 top-0 z-40 flex items-start justify-between gap-4 bg-amber-950/90 px-4 py-3 text-xs text-amber-100 backdrop-blur"
    >
      <div className="min-w-0">
        <p className="font-medium">{title}</p>
        <p className="mt-0.5 text-amber-200/80">{body}</p>
        {detail && (
          <p className="mt-1 truncate font-mono text-[10px] text-amber-300/50" title={detail}>
            {detail}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {(kind === "audio" || kind === "worklet") && onResumeAudio && (
          <BannerButton testid="banner-resume-audio" onClick={onResumeAudio}>
            Resume audio
          </BannerButton>
        )}
        {kind === "gl-failed" && onReload && (
          <BannerButton testid="banner-reload" onClick={onReload}>
            Reload
          </BannerButton>
        )}
        {dismissible && onDismiss && (
          <BannerButton testid="banner-dismiss" onClick={onDismiss} subtle>
            Dismiss
          </BannerButton>
        )}
      </div>
    </div>
  );
}

/** §11.6 — 44 px, and a focus ring. */
function BannerButton({
  testid,
  onClick,
  children,
  subtle,
}: {
  testid: string;
  onClick: () => void;
  children: React.ReactNode;
  subtle?: boolean;
}): React.JSX.Element {
  return (
    <button
      data-testid={testid}
      type="button"
      onClick={onClick}
      className={`min-h-11 rounded border px-3 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-200 ${
        subtle
          ? "border-transparent text-amber-200/60 hover:text-amber-100"
          : "border-amber-300/50 text-amber-100 hover:bg-amber-900/60"
      }`}
    >
      {children}
    </button>
  );
}

/** §11.8's fatal-WebGL2 case: a static explanation and no experience at all. */
export function NoWebGL({ detail }: { detail?: string }): React.JSX.Element {
  const [raw] = useState(false);
  return (
    <div
      data-testid="no-webgl"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-neutral-950 px-6 text-center"
    >
      <h1 className="text-lg text-neutral-200">Sound of Knowledge</h1>
      <p className="max-w-md text-sm text-neutral-500">
        This piece is drawn live with WebGL2, which this browser or device does not
        appear to support. Nothing here is broken — it needs a GPU.
      </p>
      {raw && detail ? (
        <p className="max-w-md font-mono text-[10px] text-neutral-700">{detail}</p>
      ) : null}
    </div>
  );
}