"use client";

import { useEffect, useRef } from "react";
import type { Settings } from "@/engine/types";
import { COMMON_LANGS, isAllLanguages } from "@/engine/settings";

/**
 * §11.3 — the settings panel: a slide-over, keyboard-accessible.
 *
 * Every change applies **live** (`engine.setSettings`), not on close. A settings panel
 * that only commits at the end makes each adjustment a guess, and the two settings that
 * most need hearing — volume and density — are exactly the ones you want to audition.
 *
 * Focus moves into the panel on open and `Esc` closes it, because §11.5's shortcut list
 * assumes the panel is a normal dialog rather than an overlay that leaves focus behind
 * on the canvas.
 */
export function SettingsPanel({
  settings,
  onChange,
  onClose,
  debug,
}: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
  /** §11.3 — `avSyncMs` is "shown only with ?debug=1". */
  debug: boolean;
}): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const first = panelRef.current?.querySelector<HTMLElement>("button, input, select");
    first?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      // §11.6 — a simple focus trap. Tabbing out of an open panel into the HUD behind
      // it leaves keyboard users with no visible focus and no way back.
      if (e.key !== "Tab" || !panelRef.current) return;
      const focusable = [
        ...panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ];
      if (focusable.length === 0) return;
      const firstEl = focusable[0]!;
      const lastEl = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const toggleLang = (lang: string): void => {
    const has = settings.langs.includes(lang);
    onChange({
      langs: has ? settings.langs.filter((l) => l !== lang) : [...settings.langs, lang],
    });
  };

  return (
    <div
      data-testid="settings-panel"
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      className="fixed inset-y-0 right-0 z-30 flex w-full max-w-sm flex-col gap-6 overflow-y-auto border-l border-neutral-800 bg-neutral-950/95 p-5 text-sm text-neutral-300"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-base text-neutral-100">Settings</h2>
        <button
          data-testid="settings-close"
          type="button"
          aria-label="Close settings"
          onClick={onClose}
          className="flex size-11 items-center justify-center rounded text-neutral-500 hover:text-neutral-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400"
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>

      {/* --- volume ------------------------------------------------------- */}
      <label className="flex flex-col gap-2">
        <span className="flex items-center justify-between">
          <span>Volume</span>
          <span data-testid="setting-volume-value" className="text-neutral-500">
            {Math.round(settings.volume * 100)}%
          </span>
        </span>
        <input
          data-testid="setting-volume"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={settings.volume}
          onChange={(e) => onChange({ volume: Number(e.target.value) })}
          className="accent-neutral-300"
        />
      </label>

      {/* --- density ------------------------------------------------------ */}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1">Density</legend>
        <div className="flex gap-2">
          {(["sparse", "normal", "dense"] as const).map((d) => (
            <Chip
              key={d}
              testid={`setting-density-${d}`}
              active={settings.density === d}
              onClick={() => onChange({ density: d })}
            >
              {d}
            </Chip>
          ))}
        </div>
      </fieldset>

      {/* --- languages ---------------------------------------------------- */}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1">
          Languages
          {isAllLanguages(settings.langs) && (
            <span className="ml-2 text-neutral-600">all</span>
          )}
        </legend>
        <div className="flex flex-wrap gap-2">
          <Chip
            testid="setting-lang-all"
            active={isAllLanguages(settings.langs)}
            onClick={() => onChange({ langs: [] })}
          >
            All
          </Chip>
          {COMMON_LANGS.map((l) => (
            <Chip
              key={l}
              testid={`setting-lang-${l}`}
              active={settings.langs.includes(l)}
              onClick={() => toggleLang(l)}
            >
              {l}
            </Chip>
          ))}
        </div>
      </fieldset>

      {/* --- toggles ------------------------------------------------------ */}
      <Toggle
        testid="setting-spatial"
        label="Spatial audio"
        checked={settings.spatialAudio}
        onChange={(v) => onChange({ spatialAudio: v })}
      />
      <Toggle
        testid="setting-titles"
        label="Show article titles"
        checked={settings.showTitles}
        onChange={(v) => onChange({ showTitles: v })}
      />
      <Toggle
        testid="setting-reduce-motion"
        label="Reduce motion"
        checked={settings.reduceMotion}
        onChange={(v) => onChange({ reduceMotion: v })}
      />

      {/* --- quality ------------------------------------------------------ */}
      <label className="flex flex-col gap-2">
        <span>Quality</span>
        <select
          data-testid="setting-quality"
          value={settings.quality}
          onChange={(e) => onChange({ quality: e.target.value as Settings["quality"] })}
          className="rounded border border-neutral-800 bg-neutral-900 px-2 py-2"
        >
          <option value="auto">Auto</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </label>

      {debug && (
        <label className="flex flex-col gap-2">
          <span>A/V sync (ms)</span>
          <input
            data-testid="setting-avsync"
            type="number"
            min={-100}
            max={100}
            value={settings.avSyncMs}
            onChange={(e) => onChange({ avSyncMs: Number(e.target.value) })}
            className="rounded border border-neutral-800 bg-neutral-900 px-2 py-2"
          />
        </label>
      )}

      {/* §11.6 — no flashing. The one animation here is a 1.4 s cross-fade. */}
      <p className="mt-auto text-[11px] text-neutral-700">
        Shortcuts: M mute · F fullscreen · H hide · S settings · Esc close
      </p>
    </div>
  );
}

/** §11.6 — 44 px minimum, and a visible focus ring. */
function Chip({
  testid,
  active,
  onClick,
  children,
}: {
  testid: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      data-testid={testid}
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`min-h-11 rounded-full border px-3 text-xs capitalize transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400 ${
        active
          ? "border-neutral-400 text-neutral-100"
          : "border-neutral-800 text-neutral-500 hover:text-neutral-300"
      }`}
    >
      {children}
    </button>
  );
}

function Toggle({
  testid,
  label,
  checked,
  onChange,
}: {
  testid: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}): React.JSX.Element {
  return (
    <label className="flex min-h-11 cursor-pointer items-center justify-between gap-4">
      <span>{label}</span>
      <span className="relative flex items-center">
        <input
          data-testid={testid}
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="peer sr-only"
        />
        <span
          aria-hidden="true"
          className={`block h-6 w-11 rounded-full transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-neutral-400 ${
            checked ? "bg-neutral-300" : "bg-neutral-800"
          }`}
        />
      </span>
    </label>
  );
}