/**
 * Shared types. Spec §5.6, verbatim where the spec defines them.
 *
 * PRIVACY (spec §14.2): there is deliberately no `user` field anywhere in this
 * file. Usernames and IP addresses are used only inside `normalize()` to
 * classify `actor`, then discarded. Do not add one.
 */

export type Vec3 = { x: number; y: number; z: number };

export type EditKind = "edit" | "new" | "revert";
export type Actor = "bot" | "anon" | "registered";

export type ProjectId =
  | "wikipedia"
  | "wiktionary"
  | "wikisource"
  | "wikibooks"
  | "wikiquote"
  | "wikinews"
  | "wikiversity"
  | "wikivoyage"
  | "wikidata"
  | "commons"
  | "meta"
  | "other";

export type ModeId = "lydian" | "mixolydian" | "dorian" | "aeolian";
export type Tier = "low" | "medium" | "high";
export type VoiceType = "bell" | "pluck" | "sub" | "gong" | "thud" | "tick";

export interface NormalizedEdit {
  /** recentchange id */
  id: number;
  /** event time, unix ms */
  ts: number;
  /** 'enwiki' */
  wiki: string;
  /** 'en.wikipedia.org' */
  host: string;
  /** 'en' | 'wikidata' | 'commons' | 'meta' | ... */
  lang: string;
  project: ProjectId;
  /** MediaWiki namespace id (0 = article) */
  ns: number;
  /** display title: underscores → spaces, truncated to 80 chars */
  title: string;
  actor: Actor;
  kind: EditKind;
  minor: boolean;
  /** signed byte delta */
  delta: number;
  absDelta: number;
  /** 0..1 — spec §6.2.9 */
  magnitude: number;
  /** 0..1 — spec §6.2.10 */
  importance: number;
  /** 0 if unknown */
  revNew: number;
}

export type NoteFlavor = "add" | "remove" | "large" | "revert" | "new" | "bot-thud" | "bot-tick";

export interface NoteEvent {
  /** AudioContext time (s) the note starts */
  when: number;
  voice: VoiceType;
  /** 0 for unpitched voices */
  midi: number;
  /** Hz; 0 for unpitched voices */
  freq: number;
  /** 0..1 */
  vel: number;
  /** unit direction from core — shared with visuals */
  dir: Vec3;
  /** distance from core */
  radius: number;
  edit: NormalizedEdit;
  flavor: NoteFlavor;
  /** false for the trailing arpeggio notes of a birth */
  visual: boolean;
}

/** Smoothed 0..1 features, written in place each frame (spec §8.10). */
export interface AudioFeatures {
  rms: number;
  sub: number;
  bass: number;
  mid: number;
  high: number;
  air: number;
  flux: number;
}

export function createAudioFeatures(): AudioFeatures {
  return { rms: 0, sub: 0, bass: 0, mid: 0, high: 0, air: 0, flux: 0 };
}

/** Settings as persisted / user-controlled. Spec §11.3. */
export interface Settings {
  /** 0..1, default 0.8 */
  volume: number;
  /** default false */
  muted: boolean;
  source: "wikipedias" | "no-wikidata" | "all";
  /** [] = all */
  langs: string[];
  density: "sparse" | "normal" | "dense";
  quality: "auto" | "low" | "medium" | "high";
  spatialAudio: boolean;
  showTitles: boolean;
  reduceMotion: boolean;
  /** [-100, +100] ms, debug-visible only */
  avSyncMs: number;
}

/** URL-only overrides, never persisted. Spec §11.3. */
export type DataSourceMode = "live" | "replay" | "synthetic";

export interface EngineOptions {
  /** canvas + label layer mount point */
  container: HTMLElement;
  settings: Settings;
  /** from ?debug=1 */
  debug?: boolean;
  /** from ?source= — data mode, not persisted */
  dataMode?: DataSourceMode;
  /** from ?seed= — synthetic/PRNG seed */
  seed?: number;
}

/**
 * All numbers, updated in place, read by tests and the debug overlay.
 * Spec §5.5. Never reallocate this object — the HUD polls it.
 *
 * `level` is the **performance governor level** (§9.10, 0..6), which is what
 * the spec's debug-overlay field "tier/level" (§11.9) refers to. Master
 * volume is deliberately absent: the mute check uses `muted`.
 */
export interface Metrics {
  fps: number;
  frameMsEma: number;
  frameMsP95: number;
  renderScale: number;
  tier: Tier;
  /** governor degradation level, 0..6 */
  level: number;
  acceptedTotal: number;
  droppedTotal: number;
  notesScheduled: number;
  droppedNotes: number;
  attemptedNotes: number;
  activeVoices: number;
  visualQueueLen: number;
  audioState: AudioContextState | "none";
  mode: ModeId;
  keyName: string;
  energy: number;
  muted: boolean;
  streamState: string;
}

export function createMetrics(): Metrics {
  return {
    fps: 0,
    frameMsEma: 0,
    frameMsP95: 0,
    renderScale: 1,
    tier: "high",
    level: 0,
    acceptedTotal: 0,
    droppedTotal: 0,
    notesScheduled: 0,
    droppedNotes: 0,
    attemptedNotes: 0,
    activeVoices: 0,
    visualQueueLen: 0,
    audioState: "none",
    mode: "dorian",
    keyName: "C",
    energy: 0,
    muted: false,
    streamState: "connecting",
  };
}
