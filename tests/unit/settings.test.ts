/**
 * §11.3 — settings validation.
 *
 * **The threat model is `localStorage`, not a network.** These values survive code
 * upgrades and can be hand-edited, so every field has to survive a wrong *type*, not
 * just a wrong *value*. The rule throughout: a bad field falls back to its default
 * rather than throwing, because a corrupt preference must never be able to stop the
 * piece from starting.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  validateSettings,
  loadSettings,
  saveSettings,
  readUrlOverrides,
  langAllowed,
  isAllLanguages,
  COMMON_LANGS,
  SOURCES,
  DENSITIES,
  QUALITIES,
  SETTINGS_KEY,
} from "@/engine/settings";

/** A `localStorage` stand-in. The engine's test environment is Node. */
function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

const withStorage = (s: Storage, fn: () => void): void => {
  (globalThis as { localStorage?: Storage }).localStorage = s;
  try {
    fn();
  } finally {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  }
};

describe("§11.3 — defaults", () => {
  it("match the spec's table field for field", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      volume: 0.8,
      muted: false,
      source: "wikipedias",
      langs: [],
      density: "normal",
      quality: "auto",
      spatialAudio: true,
      showTitles: true,
      reduceMotion: false,
      avSyncMs: 0,
    });
  });

  it("are not mutated by validation", () => {
    validateSettings({ volume: 0.1, langs: ["en"] });
    expect(DEFAULT_SETTINGS.volume).toBe(0.8);
    expect(DEFAULT_SETTINGS.langs).toEqual([]);
  });
});

describe("§11.3 — validation accepts well-formed values", () => {
  it("keeps every valid field", () => {
    const s = validateSettings({
      volume: 0.25,
      muted: true,
      source: "all",
      langs: ["en", "de"],
      density: "dense",
      quality: "low",
      spatialAudio: false,
      showTitles: false,
      reduceMotion: true,
      avSyncMs: -40,
    });
    expect(s).toEqual({
      volume: 0.25,
      muted: true,
      source: "all",
      langs: ["en", "de"],
      density: "dense",
      quality: "low",
      spatialAudio: false,
      showTitles: false,
      reduceMotion: true,
      avSyncMs: -40,
    });
  });

  it("accepts the boundary values", () => {
    expect(validateSettings({ volume: 0 }).volume).toBe(0);
    expect(validateSettings({ volume: 1 }).volume).toBe(1);
    expect(validateSettings({ avSyncMs: -100 }).avSyncMs).toBe(-100);
    expect(validateSettings({ avSyncMs: 100 }).avSyncMs).toBe(100);
  });
});

describe("§11.3 — validation rejects wrong types without throwing", () => {
  it("falls back on a non-numeric volume", () => {
    // `"loud"` reaching `AudioEngine.setVolume` is a silent failure or a NaN in the
    // mix; a wrong default is merely uninteresting.
    expect(validateSettings({ volume: "loud" }).volume).toBe(0.8);
    expect(validateSettings({ volume: NaN }).volume).toBe(0.8);
    expect(validateSettings({ volume: Infinity }).volume).toBe(0.8);
    expect(validateSettings({ volume: null }).volume).toBe(0.8);
  });

  it("clamps a volume outside 0..1 rather than discarding it", () => {
    // A slider out of range is a UI bug; the user's evident intent is still legible,
    // and clamping keeps the mix valid.
    expect(validateSettings({ volume: 5 }).volume).toBe(1);
    expect(validateSettings({ volume: -5 }).volume).toBe(0);
  });

  it("falls back on an unknown enum value", () => {
    expect(validateSettings({ source: "wikibooks" }).source).toBe("wikipedias");
    expect(validateSettings({ density: "extreme" }).density).toBe("normal");
    expect(validateSettings({ quality: "ultra" }).quality).toBe("auto");
  });

  it("falls back on a boolean field given a string", () => {
    // `"false"` is truthy. Taking it as a boolean would mute the piece permanently.
    expect(validateSettings({ muted: "false" }).muted).toBe(false);
    expect(validateSettings({ spatialAudio: "yes" }).spatialAudio).toBe(true);
    expect(validateSettings({ showTitles: 0 }).showTitles).toBe(true);
  });

  it("filters a bad language list rather than discarding a good one", () => {
    // One bad entry must not throw away a valid list — these come from the stream's
    // own language tags, so they are not curated data.
    expect(validateSettings({ langs: ["en", 42, null, "de", ""] }).langs).toEqual([
      "en",
      "de",
    ]);
  });

  it("falls back when langs is not an array at all", () => {
    expect(validateSettings({ langs: "en" }).langs).toEqual([]);
  });

  it("survives a non-object input", () => {
    expect(validateSettings(null).volume).toBe(0.8);
    expect(validateSettings("nope").volume).toBe(0.8);
    expect(validateSettings(42).volume).toBe(0.8);
    expect(validateSettings(undefined).volume).toBe(0.8);
  });

  it("ignores unknown keys rather than copying them through", () => {
    const s = validateSettings({ volume: 0.5, somethingRemoved: 1 });
    expect(s).not.toHaveProperty("somethingRemoved");
  });
});

describe("§11.3 — load", () => {
  it("returns defaults when nothing is stored", () => {
    withStorage(fakeStorage(), () => {
      expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    });
  });

  it("restores a stored value", () => {
    const stored = { ...DEFAULT_SETTINGS, volume: 0.3, density: "sparse" as const };
    withStorage(fakeStorage({ [SETTINGS_KEY]: JSON.stringify(stored) }), () => {
      const s = loadSettings();
      expect(s.volume).toBe(0.3);
      expect(s.density).toBe("sparse");
    });
  });

  it("falls back to defaults on unparseable JSON", () => {
    withStorage(fakeStorage({ [SETTINGS_KEY]: "{ not json" }), () => {
      expect(loadSettings().volume).toBe(0.8);
    });
  });

  it("survives a partial object from an older version", () => {
    // An older build stored fewer fields. Missing keys must take defaults, not NaN.
    withStorage(fakeStorage({ [SETTINGS_KEY]: JSON.stringify({ volume: 0.2 }) }), () => {
      const s = loadSettings();
      expect(s.volume).toBe(0.2);
      expect(s.density).toBe("normal");
      expect(s.quality).toBe("auto");
    });
  });
});

describe("§11.3 — save", () => {
  it("round-trips", () => {
    withStorage(fakeStorage(), () => {
      const s = { ...DEFAULT_SETTINGS, volume: 0.42 };
      expect(saveSettings(s)).toBe(true);
      expect(loadSettings().volume).toBe(0.42);
    });
  });

  it("returns false rather than throwing when storage is unavailable", () => {
    // Private browsing. Throwing here would take the engine down over a settings write.
    delete (globalThis as { localStorage?: Storage }).localStorage;
    expect(saveSettings(DEFAULT_SETTINGS)).toBe(false);
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });
});

describe("§11.3 — URL overrides are not persisted", () => {
  it("applies ?quality= and ?density=", () => {
    const { settings } = readUrlOverrides("?quality=low&density=sparse");
    expect(settings.quality).toBe("low");
    expect(settings.density).toBe("sparse");
  });

  it("ignores an unknown override value", () => {
    const { settings } = readUrlOverrides("?quality=ultra&density=extreme");
    expect(settings.quality).toBe("auto");
    expect(settings.density).toBe("normal");
  });

  it("leaves settings alone for an empty query", () => {
    expect(readUrlOverrides("").settings).toEqual(DEFAULT_SETTINGS);
  });

  it("reads the data mode and seed separately from Settings.source", () => {
    // `?source=` is §11.3's *data* mode. `Settings.source` chooses wikipedias vs
    // wikidata, and is `?project=`. Collapsing them would break both.
    const { data, settings } = readUrlOverrides("?source=synthetic&seed=7");
    expect(data.mode).toBe("synthetic");
    expect(data.seed).toBe(7);
    expect(settings.source).toBe("wikipedias");
  });

  it("defaults the data mode to live", () => {
    expect(readUrlOverrides("").data.mode).toBe("live");
    expect(readUrlOverrides("").data.seed).toBe(1);
    expect(readUrlOverrides("").data.debug).toBe(false);
    expect(readUrlOverrides("?debug=1").data.debug).toBe(true);
  });

  it("falls back on a non-numeric seed", () => {
    expect(readUrlOverrides("?seed=abc").data.seed).toBe(1);
  });

  it("?project= sets Settings.source", () => {
    expect(readUrlOverrides("?project=all").settings.source).toBe("all");
  });
});

describe("§11.3 — language filter", () => {
  it("an empty list means every language", () => {
    expect(isAllLanguages([])).toBe(true);
    expect(langAllowed([], "ja")).toBe(true);
    expect(langAllowed([], "anything-at-all")).toBe(true);
  });

  it("a non-empty list admits only what is in it", () => {
    expect(isAllLanguages(["en"])).toBe(false);
    expect(langAllowed(["en", "de"], "de")).toBe(true);
    expect(langAllowed(["en", "de"], "ja")).toBe(false);
  });

  it("offers twelve chips, all distinct", () => {
    expect(COMMON_LANGS).toHaveLength(12);
    expect(new Set(COMMON_LANGS).size).toBe(12);
  });
});

describe("§11.3 — the option sets", () => {
  it("are exactly the spec's values", () => {
    expect([...SOURCES]).toEqual(["wikipedias", "no-wikidata", "all"]);
    expect([...DENSITIES]).toEqual(["sparse", "normal", "dense"]);
    expect([...QUALITIES]).toEqual(["auto", "low", "medium", "high"]);
  });
});