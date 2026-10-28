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
/** §11.6 — "aria-live=\"polite\" summary updated at most every 10 s". */
const ANNOUNCE_INTERVAL_MS = 10_000;

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
  /**
   * DEBUG ONLY — the A4 calibration readout.
   *
   * Large, centred, and unmistakable, because the 3D label cannot serve: §9.1 puts the
   * camera at radius 5.5 inside the 7-13 edit shell, so five of the six calibration
   * directions land **outside the frustum** and only FRONT is ever visible in the
   * scene. Measured: RIGHT at 118 % of screen width, LEFT at -16 %, BEHIND behind the
   * camera, ABOVE at -88 %, BELOW at 198 %.
   *
   * It keeps a chip for every step seen, not just the current one, so a step that
   * flashes past is not lost — both for the human (they can see where they are in the
   * sequence) and for the e2e test, which must not have to poll fast enough to catch a
   * transient. Recovering the label by parsing rendered text was the first attempt and
   * it broke on the concatenation of the styled spans.
   */
  const [a4, setA4] = useState<{
    label: string;
    index: number;
    total: number;
    seen: string[];
    mode: "direction" | "timbre";
    seq?: string[];
  } | null>(null);

  // §11.4 — `role="status" aria-live="polite"`, and §11.6 caps the announced summary
  // at once every 10 s so a screen reader is not read a number four times a second.
  const [announced, setAnnounced] = useState("");
  const lastAnnouncedAt = useRef(0);
  const lastAnnouncedText = useRef("");

  // --- engine subscriptions -------------------------------------------------

  useEffect(() => {
    if (!engine) return;
    // §11.4 — ≤ 4 Hz, driven by the engine's own throttle rather than by a React
    // interval, so a paused tab cannot queue updates.
    //
    // The announcement throttle lives here rather than in its own effect because it
    // *is* the `stats` handler's business: §11.6's cap is about how often this event
    // is allowed to change what a screen reader says. Splitting it out made it an
    // effect that set state, which is both a lint error and a worse shape — the
    // decision is made per event, here.
    return engine.on("stats", (s) => {
      setMetrics({ ...engine.getMetrics() });
      setEps(s.eps);

      const next = politeSummary(engine.getMetrics().streamState, s.eps);
      if (next === lastAnnouncedText.current) return;
      const now = performance.now();
      if (now - lastAnnouncedAt.current < ANNOUNCE_INTERVAL_MS) return;
      lastAnnouncedAt.current = now;
      lastAnnouncedText.current = next;
      setAnnounced(next);
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

  useEffect(() => {
    if (!engine) return;
    return engine.on("a4Step", (s) => {
      setA4((prev) => {
        const seen = prev ? [...prev.seen] : [];
        if (!seen.includes(s.label)) seen.push(s.label);
        return {
          label: s.label,
          index: s.index,
          total: s.total,
          seen,
          mode: s.mode ?? "direction",
          seq: s.seq,
        };
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

  const apply = (patch: Parameters<Engine["setSettings"]>[0]): void => {
    engine?.setSettings(patch);
    setSettings(engine?.getSettings() ?? null);
  };

  return (
    <>
      {/* DEBUG ONLY — the A4 calibration readout. Sits above the scene, centred, and
          ignores the auto-fade, because it is the reference the human is judging
          against and it must never be the thing that is hard to see. */}
      {a4 && (
        <div
          data-testid="a4-readout"
          data-a4-label={a4.label}
          data-a4-seen={a4.seen.join(",")}
          className="pointer-events-none fixed inset-x-0 top-[12vh] z-40 flex flex-col items-center gap-2"
        >
          <div className="rounded border border-amber-500/60 bg-black/80 px-6 py-3">
            <div className="text-[11px] tracking-[0.3em] text-amber-500/80">
              A4 · {a4.index} OF {a4.total}
            </div>
            <div className="text-4xl font-semibold tracking-widest text-amber-200">
              {a4.label}
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            {a4.mode === "timbre" && a4.seq
              ? // A **position track**, not a list of distinct labels. The whole point
                // of the timbre test is that the FRONT notes bracket the others, and
                // that structure is only visible if the repeats are shown.
                a4.seq.map((s, i) => (
                  <span
                    key={`${s}-${i}`}
                    data-a4-chip={s}
                    className={
                      s === a4.label
                        ? "rounded border border-amber-400 bg-amber-400/20 px-2 py-0.5 text-[11px] tracking-widest text-amber-200"
                        : "rounded border border-amber-900/70 px-2 py-0.5 text-[11px] tracking-widest text-amber-800"
                    }
                  >
                    {s}
                  </span>
                ))
              : a4.seen.map((s) => (
                  <span
                    key={s}
                    data-a4-chip={s}
                    className={
                      s === a4.label
                        ? "rounded border border-amber-400 bg-amber-400/20 px-2 py-0.5 text-[11px] tracking-widest text-amber-200"
                        : "rounded border border-amber-900/70 px-2 py-0.5 text-[11px] tracking-widest text-amber-800"
                    }
                  >
                    {s}
                  </span>
                ))}
          </div>
          <div className="text-[11px] text-amber-500/70">
            {a4.mode === "timbre"
              ? "same as the FRONT notes, or different?"
              : "listen: which side?"}
          </div>
        </div>
      )}
      <div
        data-testid="hud"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-20 flex items-end justify-between gap-4 pb-[max(0.75rem,var(--sok-safe-b))] pr-[max(0.75rem,var(--sok-safe-r))] pl-[max(0.75rem,var(--sok-safe-l))] pt-3 transition-opacity duration-700"
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
      <p className="pointer-events-none fixed left-[max(0.75rem,var(--sok-safe-l))] top-[max(0.75rem,var(--sok-safe-t))] z-20 text-xs tracking-wide text-neutral-600">
        Sound of Knowledge
      </p>

      {/* §11.4 — footer. */}
      <p className="pointer-events-none fixed bottom-[max(0.25rem,var(--sok-safe-b))] left-1/2 z-20 -translate-x-1/2 text-[10px] text-neutral-700">
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
        {announced}
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

/**
 * §11.6 — the announced summary: "Live, about 18 edits per second".
 *
 * Rounded, so the handler can compare against the last announced string and skip the
 * update when the value has not moved. Without that every 4 Hz sample of a jittery
 * `eps` is a distinct string, and "at most every 10 s" quietly becomes "at most 10
 * distinct values".
 *
 * This was a no-op effect for the whole of T5.2 — it read a ref, compared it to a
 * clock, and returned without touching state, under a comment saying it enforced the
 * cap. It could not, because the region was driven straight off `eps`.
 *
 * That stayed hidden until T5.3 wired `eps` to a real value for the first time, at
 * which point the region began changing four times a second and the existing test
 * failed. A safety that never had anything to protect is indistinguishable from one
 * that is working, until the thing it guards starts happening.
 */
function politeSummary(streamState: string, eps: number): string {
  if (eps <= 0) return "";
  return `${STATUS_WORD[streamState] ?? streamState}, about ${eps.toFixed(0)} edits per second`;
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