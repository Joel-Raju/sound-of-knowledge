"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Engine, Metrics } from "@/engine";
import { SettingsPanel } from "./settings-panel";

/**
 * §11.4 — the HUD.
 *
 * **Two update rates, and the difference is the whole design.** §11.4 says React state
 * updates at ≤ 4 Hz from the `stats` event, and the ticker updates only on `notable`.
 * That is not a performance note, it is a correctness note: the ticker fires at most
 * once per 2.5 s and the status line four times a second, and if both rode one
 * 4 Hz state update the ticker would visibly re-render at a rate it never fires at.
 *
 * The ticker text is rendered as a React text node. §11.4 forbids
 * `dangerouslySetInnerHTML`, and titles arrive from a live public API — this is the
 * same reason `labels.ts` uses `textContent` and never `innerHTML`.
 */

/** §11.4 — "after 5 s without pointer/touch/keyboard activity". */
const AUTO_FADE_MS = 5_000;
/** §11.4 — "HUD fades to 25 % opacity (status line stays)". */
const FADED_OPACITY = 0.25;
/** §11.4 — the status line does not fade. */
const STATUS_OPACITY = 1;

const STATUS_COLOURS: Record<string, string> = {
  live: "bg-emerald-500",
  connecting: "bg-amber-500",
  replay: "bg-sky-500",
  reconnecting: "bg-amber-500",
  error: "bg-red-500",
};

const STATUS_WORD: Record<string, string> = {
  live: "Live",
  connecting: "Connecting",
  replay: "Replay",
  reconnecting: "Reconnecting",
  error: "Error",
};

export interface HudProps {
  engine: Engine | null;
  hidden: boolean;
  onHiddenChange: (v: boolean) => void;
}

export function Hud({ engine, hidden, onHiddenChange }: HudProps): React.JSX.Element {
  const [metrics, setMetrics] = useState<Readonly<Metrics> | null>(null);
  const [ticker, setTicker] = useState<TickerLine | null>(null);
  const [eps, setEps] = useState(0);
  const [faded, setFaded] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [settings, setSettings] = useState(() => engine?.getSettings() ?? null);

  // §11.4 — `role="status" aria-live="polite"`, and §11.6 caps the announced summary
  // at once every 10 s so a screen reader is not read a number four times a second.
  const lastAnnounced = useRef(0);

  // --- engine subscriptions -------------------------------------------------

  useEffect(() => {
    if (!engine) return;
    // §11.4 — ≤ 4 Hz, driven by the engine's own throttle rather than by a React
    // interval, so a paused tab cannot queue updates.
    return engine.on("stats", (s) => {
      setMetrics({ ...engine.getMetrics() });
      setEps(s.eps);
    });
  }, [engine]);

  useEffect(() => {
    if (!engine) return;
    // The ticker updates *only* on `notable` — never on `stats`.
    return engine.on("notable", (n) => {
      // The **href** comes from §9.9's `LabelLayer`, already built — re-deriving it
      // here would be a second copy of `buildArticleHref` to keep in step, and its
      // space→underscore ordering is load-bearing.
      //
      // The **text** does not: §9.9's labels read `LANG␣␣Title` (two spaces, an anchor
      // floating in space) while §11.4's ticker reads `LANG · Title` (a middot, a line
      // of prose). Different formats for different surfaces, so sharing one string
      // would be wrong rather than merely duplicated.
      setTicker({
        href: n.href,
        text: `${n.edit.lang} · ${n.edit.title}`,
        edit: n.edit,
      });
    });
  }, [engine]);

  // --- auto-fade (§11.4) ----------------------------------------------------

  useEffect(() => {
    const wake = (): void => setFaded(false);
    const arm = (): void => {
      setFaded(false);
      window.clearTimeout(arm.timer);
      arm.timer = window.setTimeout(() => setFaded(true), AUTO_FADE_MS);
    };
    arm.timer = 0 as unknown as number;

    const events = ["pointermove", "pointerdown", "touchstart", "keydown"] as const;
    for (const e of events) window.addEventListener(e, wake, { passive: true });
    arm();
    return () => {
      window.clearTimeout(arm.timer);
      for (const e of events) window.removeEventListener(e, wake);
    };
  }, []);

  // --- keyboard shortcuts (§11.5) -------------------------------------------

  const fullscreen = useCallback((): void => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void document.documentElement.requestFullscreen().catch(() => {});
  }, []);

  const screenshot = useCallback((): void => {
    if (!engine) return;
    // §5.5 — `screenshot()` renders a frame then reads the canvas, so the image is
    // never a half-drawn buffer.
    void engine.screenshot().then((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `sound-of-knowledge-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }, [engine]);

  useEffect(() => {
    if (!engine) return;
    const onKey = (e: KeyboardEvent): void => {
      // §11.5 — "shortcuts ignored while typing in inputs". Without this, pressing `m`
      // to type a value into the settings panel mutes the piece instead.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        if (e.key !== "Escape") return;
        setPanelOpen(false);
        return;
      }
      switch (e.key.toLowerCase()) {
        case "m":
          engine.setSettings({ muted: !engine.getSettings().muted });
          setSettings(engine.getSettings());
          break;
        case "f":
          fullscreen();
          break;
        case "h":
          onHiddenChange(!hidden);
          break;
        case "s":
          setPanelOpen((v) => !v);
          break;
        case "escape":
          setPanelOpen(false);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [engine, hidden, onHiddenChange, fullscreen]);

  // --- announcements (§11.6) ------------------------------------------------

  useEffect(() => {
    if (!metrics) return;
    const now = performance.now();
    if (now - lastAnnounced.current < 10_000) return;
    lastAnnounced.current = now;
  }, [metrics]);

  if (hidden) {
    // Still one affordance back, or `H` with the UI hidden is unrecoverable without
    // knowing the shortcut. §11.4's "hide UI" that cannot be undone is a trap.
    return (
      <button
        data-testid="hud-restore"
        type="button"
        aria-label="Show interface"
        onClick={() => onHiddenChange(false)}
        className="fixed bottom-3 left-3 z-30 rounded border border-neutral-800 px-2 py-1 text-[11px] text-neutral-600 hover:text-neutral-300"
      >
        Show UI (H)
      </button>
    );
  }

  const state = metrics?.streamState ?? "connecting";
  const summary = metrics
    ? `${STATUS_WORD[state] ?? state} · ${eps.toFixed(0)} edits/s · ${cap(metrics.mode)} in ${metrics.keyName}`
    : "Starting…";

  const delta = ticker?.edit ? signed(ticker.edit.delta) : "";
  const polite = eps > 0
    ? `${STATUS_WORD[state] ?? state}, about ${eps.toFixed(0)} edits per second`
    : "";

  const apply = (patch: Parameters<Engine["setSettings"]>[0]): void => {
    engine?.setSettings(patch);
    setSettings(engine?.getSettings() ?? null);
  };

  return (
    <>
      <div
        data-testid="hud"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-20 flex items-end justify-between gap-4 p-3 transition-opacity duration-700"
        style={{ opacity: faded ? FADED_OPACITY : 1 }}
      >
        {/* Bottom-left: status dot + line, and the ticker under it. */}
        <div className="pointer-events-auto flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span
              data-testid="status-dot"
              className={`inline-block size-2 shrink-0 rounded-full ${STATUS_COLOURS[state] ?? "bg-neutral-600"}`}
            />
            {/* §11.4 — the status line does *not* fade with the rest of the HUD. */}
            <span
              data-testid="hud-status"
              style={{ opacity: STATUS_OPACITY }}
              className="text-xs text-neutral-400"
            >
              {summary}
            </span>
          </div>
          {ticker && (
            <a
              data-testid="ticker"
              href={ticker.href}
              target="_blank"
              rel="noopener noreferrer"
              className="max-w-[46ch] truncate text-xs text-neutral-500 hover:text-neutral-300"
            >
              {ticker.text}
              {delta && <span className="ml-2 text-neutral-600">{delta}</span>}
            </a>
          )}
        </div>

        {/* Bottom-right: the five icon buttons. */}
        <div className="pointer-events-auto flex items-center gap-1">
          <IconButton
            testid="btn-mute"
            label={settings?.muted ? "Unmute" : "Mute"}
            title={`${settings?.muted ? "Unmute" : "Mute"} (M)`}
            onClick={() => apply({ muted: !settings?.muted })}
            active={settings?.muted === true}
            glyph={settings?.muted ? "🔇" : "🔊"}
          />
          <IconButton
            testid="btn-settings"
            label="Settings"
            title="Settings (S)"
            onClick={() => setPanelOpen((v) => !v)}
            active={panelOpen}
            glyph="⚙"
          />
          <IconButton
            testid="btn-fullscreen"
            label="Fullscreen"
            title="Fullscreen (F)"
            onClick={fullscreen}
            glyph="⛶"
          />
          <IconButton
            testid="btn-screenshot"
            label="Screenshot"
            title="Save a screenshot"
            onClick={screenshot}
            glyph="⤓"
          />
          <IconButton
            testid="btn-hide"
            label="Hide interface"
            title="Hide interface (H)"
            onClick={() => onHiddenChange(true)}
            glyph="◐"
          />
        </div>
      </div>

      {/* §11.4 — top-left wordmark. */}
      <p className="pointer-events-none fixed left-3 top-3 z-20 text-xs tracking-wide text-neutral-600">
        Sound of Knowledge
      </p>

      {/* §11.4 — footer. */}
      <p className="pointer-events-none fixed bottom-1 left-1/2 z-20 -translate-x-1/2 text-[10px] text-neutral-700">
        Data:{" "}
        <a
          href="https://wikitech.wikimedia.org/wiki/EventStreams"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2"
        >
          Wikimedia EventStreams
        </a>
      </p>

      {/* §11.6 — the polite live region. Visually hidden so it never costs layout. */}
      <p data-testid="hud-live-region" role="status" aria-live="polite" className="sr-only">
        {polite}
      </p>

      {panelOpen && settings && (
        <SettingsPanel
          settings={settings}
          onChange={apply}
          onClose={() => setPanelOpen(false)}
          debug={false}
        />
      )}
    </>
  );
}

/**
 * §11.6 — "≥ 44 px touch targets". The visible glyph is small; the button is not.
 * A 24 px icon button with a 24 px hit area is the most common way a HUD is unusable
 * on a phone, and it is invisible until someone tries.
 */
function IconButton({
  testid,
  label,
  title,
  onClick,
  glyph,
  active,
}: {
  testid: string;
  label: string;
  title: string;
  onClick: () => void;
  glyph: string;
  active?: boolean;
}): React.JSX.Element {
  return (
    <button
      data-testid={testid}
      type="button"
      aria-label={label}
      title={title}
      aria-pressed={active}
      onClick={onClick}
      className={`flex size-11 items-center justify-center rounded text-sm transition-colors ${
        active ? "text-neutral-200" : "text-neutral-500 hover:text-neutral-200"
      } focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400`}
    >
      <span aria-hidden="true">{glyph}</span>
    </button>
  );
}

/** The ticker's own shape: `en · Albert Einstein`, with the signed byte delta. */
interface TickerLine {
  text: string;
  href: string;
  edit: { delta: number };
}

/** §11.4's `Dorian in C` — the mode name, capitalised. */
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** `+1,240` / `−310`. §11.4 shows the signed byte delta. */
function signed(delta: number): string {
  const n = Math.abs(delta).toLocaleString("en-US");
  return delta >= 0 ? `+${n}` : `−${n}`;
}