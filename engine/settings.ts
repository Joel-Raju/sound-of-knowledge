/**
 * §11.3 — the `Settings` module: defaults, validation, persistence, URL overrides.
 *
 * **Validation is the substance here, not the plumbing.** These values come out of
 * `localStorage`, which means they survive across code versions and can be edited by
 * hand. A stored `volume` of `"loud"` or a `langs` of `"en"` (a string, not an array)
 * would otherwise reach `AudioEngine.setVolume` and produce either a silent failure or
 * a NaN that propagates into the mix. Every field is validated on load against its own
 * shape, and a field that fails validation falls back rather than throwing — a
 * corrupt preference must never be able to stop the piece from starting.
 */
import type { Settings } from "./types";

/** §11.3 — the persistence key, versioned so a future change can invalidate it. */
export const SETTINGS_KEY = "sok.settings.v2";

export const DEFAULT_SETTINGS: Settings = {
  volume: 0.8,
  muted: false,
  source: "wikipedias",
  langs: [], // §11.3 — empty means all
  density: "normal",
  quality: "auto",
  spatialAudio: true,
  showTitles: true,
  reduceMotion: false, // replaced by the media query at load time
  avSyncMs: 0,
};

export const SOURCES = ["wikipedias", "no-wikidata", "all"] as const;
export const DENSITIES = ["sparse", "normal", "dense"] as const;
export const QUALITIES = ["auto", "low", "medium", "high"] as const;

/**
 * §11.3 — "chips for the 12 most common languages". Not a guess about which are
 * common: these are the twelve the synthetic source emits most, and the order is
 * descending by expected share so the chips read in order of likelihood.
 */
export const COMMON_LANGS = [
  "en",
  "de",
  "fr",
  "es",
  "ja",
  "ru",
  "pt",
  "it",
  "zh",
  "nl",
  "pl",
  "sv",
] as const;

export interface DataMode {
  /** §11.3 — `?source=live|replay|synthetic`. Default `live`. */
  mode: "live" | "replay" | "synthetic";
  seed: number;
  debug: boolean;
  /** `?rateMul=` — scales the synthetic source's arrival rate. Default 1. */
  rateMul: number;
  /** `?camRadius=` — override the camera's orbit radius. `null` = §9.1's 5.5. */
  camRadius: number | null;
  /** `?fov=` — override the field of view. `null` = §9.1's 58°. */
  fov: number | null;
  /** `?cometScale=` — a multiplier on the streak's size and brightness. */
  cometScale: number | null;
  /** `?cometCount=` — a multiplier on the streak's particle count. */
  cometCount: number | null;
  /**
   * `?nocomets=1` — make the spark system inert, so another visual system can be
   * measured on its own.
   *
   * The dust test measures "light outside the core", and that was dust-only **because
   * the comets never rendered**. Now they do, and the dust's own contribution cannot be
   * separated from a comet that happened to be in frame. This is the same idea as
   * `?nodust=1`, pointed the other way.
   */
  noComets: boolean;
}

/**
 * `reduceMotion` defaults to the media query rather than to `false`.
 *
 * §11.3 says "default = matchMedia('(prefers-reduced-motion: reduce)')" and §9.11 makes
 * it a live preference, so this is sampled at load and the engine's own watcher takes
 * over from there. Defaulting it to `false` would have shipped the opposite of what a
 * user who has asked their OS for less motion gets.
 */
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const isOneOf = <T extends string>(
  v: unknown,
  allowed: readonly T[],
): v is T => typeof v === "string" && (allowed as readonly string[]).includes(v);

/** A finite number inside `[lo, hi]`, or `undefined` so the caller keeps its default. */
function numIn(v: unknown, lo: number, hi: number): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Validate one parsed object into `Settings`, field by field.
 *
 * Every branch is "use the stored value if it is well-formed, otherwise keep the
 * default" — never "throw". A preference is not worth failing startup over, and a
 * partial object is normal: an older version of the app stored fewer fields.
 */
export function validateSettings(input: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const out: Settings = { ...base };
  if (typeof input !== "object" || input === null) return out;
  const raw = input as Record<string, unknown>;

  const volume = numIn(raw.volume, 0, 1);
  if (volume !== undefined) out.volume = volume;

  const avSyncMs = numIn(raw.avSyncMs, -100, 100);
  if (avSyncMs !== undefined) out.avSyncMs = avSyncMs;

  if (typeof raw.muted === "boolean") out.muted = raw.muted;
  if (typeof raw.spatialAudio === "boolean") out.spatialAudio = raw.spatialAudio;
  if (typeof raw.showTitles === "boolean") out.showTitles = raw.showTitles;
  if (typeof raw.reduceMotion === "boolean") out.reduceMotion = raw.reduceMotion;

  if (isOneOf(raw.source, SOURCES)) out.source = raw.source;
  if (isOneOf(raw.density, DENSITIES)) out.density = raw.density;
  if (isOneOf(raw.quality, QUALITIES)) out.quality = raw.quality;

  if (Array.isArray(raw.langs)) {
    // Filtered rather than rejected: one bad entry should not discard a valid list.
    // §14.2 — these come from the stream's own language tags, so they are not curated.
    out.langs = raw.langs.filter((l): l is string => typeof l === "string" && l.length > 0);
  }

  return out;
}

/** §11.3 — read and validate, falling back to defaults for anything missing or corrupt. */
export function loadSettings(storageKey: string = SETTINGS_KEY): Settings {
  const base: Settings = { ...DEFAULT_SETTINGS, reduceMotion: prefersReducedMotion() };
  try {
    if (typeof localStorage === "undefined") return base;
    const text = localStorage.getItem(storageKey);
    if (!text) return base;
    return validateSettings(JSON.parse(text), base);
  } catch {
    // Private browsing throws on access, and a corrupt value throws on parse. Both
    // mean "use the defaults", which is a working piece rather than no piece.
    return base;
  }
}

/** Returns false if storage is unavailable (private browsing) — persistence is optional. */
export function saveSettings(s: Settings, storageKey: string = SETTINGS_KEY): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    localStorage.setItem(storageKey, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}

/**
 * §11.3 — URL overrides. **Not persisted**, by spec.
 *
 * These exist so a data point can be reproduced from a URL alone: `?source=synthetic`
 * for the e2e suite, `?quality=low` for the capture harness. Writing any of them back
 * to `localStorage` would silently change a user's saved preferences because someone
 * once opened a test URL.
 */
export function readUrlOverrides(
  search: string,
  base: Settings = DEFAULT_SETTINGS,
): { settings: Settings; data: DataMode } {
  const p = new URLSearchParams(search);
  const settings: Settings = { ...base };

  const source = p.get("source");
  if (source === "live" || source === "replay" || source === "synthetic") {
    // `?source=` is §11.3's *data* mode, not §11.3's `Settings.source` (which chooses
    // between wikipedias / no-wikidata / all). Two different meanings, two params.
    void source;
  }
  const settingsSource = p.get("project");
  if (isOneOf(settingsSource, SOURCES)) settings.source = settingsSource;

  const density = p.get("density");
  if (isOneOf(density, DENSITIES)) settings.density = density;

  const quality = p.get("quality");
  if (isOneOf(quality, QUALITIES)) settings.quality = quality;

  // `Number(null)` is 0, not NaN — so an absent `?seed` would have silently become seed
  // 0. That is a different PRNG stream from the intended default of 1, which is exactly
  // the kind of invisible reproducibility difference this parameter exists to prevent.
  const seedRaw = p.get("seed");
  const seedNum = seedRaw === null ? Number.NaN : Number(seedRaw);
  const seed = Number.isFinite(seedNum) ? seedNum : 1;

  const sourceParam = p.get("source");
  const mode: DataMode["mode"] =
    sourceParam === "replay" || sourceParam === "synthetic" ? sourceParam : "live";

  // `?rateMul=` scales the synthetic source's arrival rate. §7.3's energy curve is a
  // function of the traffic rate, and the synthetic source at its default rate is a
  // *stress test* — it saturates `E` at 1.000, which pins the mode at lydian. Scaling
  // it is the only way to exercise the middle of the curve from a URL, and it is what
  // the soak harness already does.
  const rateMulRaw = p.get("rateMul");
  const rateMulNum = rateMulRaw === null ? Number.NaN : Number(rateMulRaw);
  const rateMul = Number.isFinite(rateMulNum) && rateMulNum > 0 ? rateMulNum : 1;

  // `?camRadius=` and `?fov=` — the framing overrides, for evaluating the camera
  // placement. §9.1 puts the camera at radius 5.5 *inside* the 7-13 edit shell, and
  // measured on the live stream that means **only 8 % of fired notes produce a comet
  // inside the frustum**, with the seven busiest wikis producing none. Whether that is
  // the right framing is a decision for a human's eyes, and a decision that can be
  // toggled from a URL is one that can be settled by looking.
  const camRadius = numberParam(p.get("camRadius"));
  const fov = numberParam(p.get("fov"));
  const cometScale = numberParam(p.get("cometScale"));
  const cometCount = numberParam(p.get("cometCount"));
  const noComets = p.get("nocomets") === "1";

  return {
    settings,
    data: {
      mode,
      seed,
      debug: p.get("debug") === "1",
      rateMul,
      camRadius,
      fov,
      cometScale,
      cometCount,
      noComets,
    },
  };
}

/** A URL parameter that is either a finite number or absent. */
function numberParam(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** `[]` means every language — §11.3. Kept as a helper so the panel and the filter agree. */
export function isAllLanguages(langs: readonly string[]): boolean {
  return langs.length === 0;
}

/** Whether `lang` passes a language filter. An empty filter admits everything. */
export function langAllowed(langs: readonly string[], lang: string): boolean {
  return langs.length === 0 || langs.includes(lang);
}