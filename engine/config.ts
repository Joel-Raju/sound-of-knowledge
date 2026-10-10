/**
 * ALL tunable constants. Spec §1.1.9 — every number from the spec lives here
 * as a named constant with a `// spec §x.y` comment. No magic numbers in
 * feature code.
 *
 * Tuning guide: docs/TUNING.md. Change values here, re-run the verification
 * harness (`npm run audio:check`, `npm run test:e2e`), record the result.
 */

import type { ModeId, ProjectId, Tier, VoiceType } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Musical constants — spec §7.1
// ─────────────────────────────────────────────────────────────────────────────

export const BPM = 68; // spec §7.1
export const STEPS_PER_BAR = 16; // spec §7.1 (4/4, 16 steps per bar)
export const STEP_SEC = 60 / BPM / 4; // spec §7.1 ≈ 0.2206 s
export const LOOKAHEAD_SEC = 0.15; // spec §7.1 (foreground)
export const LOOKAHEAD_HIDDEN_SEC = 1.25; // spec §7.1 (document.hidden)
export const TICK_SEC = 0.025; // spec §7.1 (worker heartbeat, 25 ms)
export const HUMANIZE_SEC = 0.006; // spec §7.1 (±6 ms on melodic notes)
export const CHORD_BARS = 4; // spec §7.1 (≈ 14.1 s)
export const PHRASE_BARS = 8; // spec §7.1 (mode may change at phrase boundaries)
export const KEY_CHANGE_BARS = 32; // spec §7.1 (≈ 113 s)

/**
 * Reference events/second for energy normalisation:
 *   `E = log10(1 + eps) / log10(1 + EPS_REF)`.  spec §7.3.
 *
 * CALIBRATED at T1.1 — `round(1.5 × p95)` of measured post-normalize
 * Wikipedias throughput. Full 120 s measurement in docs/DECISIONS.md.
 *
 * The measurement matters: **54 % of the raw stream is `categorize` and ~8 %
 * is `log`**, both dropped by §6.2.1, so raw throughput (p95 ≈ 62/s) overstates
 * the musical event rate by ~6×. Calibrating on raw would pin E near 1.0
 * permanently.
 *
 * Resulting behaviour (caveat on Aeolian in the T1.1 decision log):
 *   quiet   ~2/s → E ≈ 0.40 (dorian)
 *   typical ~6/s → E ≈ 0.70 (mixolydian/lydian boundary)
 *   peak    ~10/s → E ≈ 0.86 (lydian)
 */
export const EPS_REF = 15; // spec §7.3 (calibrated at T1.1)

export const BOT_REF = 8; // spec §7.1 (bot edits/s reference)

/** §7.3 — energy EMA time constant. */
export const ENERGY_TAU_SEC = 6; // spec §7.3

// ─────────────────────────────────────────────────────────────────────────────
// Data pipeline — spec §6
// ─────────────────────────────────────────────────────────────────────────────

/** spec §6.4 — batch/flush window; also the sampler window. */
export const BATCH_INTERVAL_MS = 50;
/** spec §6.4 — token bucket starts at half a second of capacity. */
export const SAMPLER_BUCKET_CAP = 0.5;
/** spec §6.4 — fraction of each window's budget reserved for uniform random picks. */
export const SAMPLER_RANDOM_RESERVE = 0.25;
/** spec §6.3 — dedupe window: last 2000 event ids. */
export const DEDUPE_CAPACITY = 2000;
/** spec §6.5 — stats message cadence. */
export const STATS_INTERVAL_MS = 500;
/** spec §6.1 */
export const STREAM_URL = "https://stream.wikimedia.org/v2/stream/recentchange";
/** spec §6.6 — reconnect if no message for this long. */
export const STREAM_WATCHDOG_MS = 20_000;
/** spec §6.6 — backoff ladder, cap 30 s. */
export const STREAM_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const;
/** spec §6.6 — ±20 % jitter on backoff. */
export const STREAM_BACKOFF_JITTER = 0.2;
/** spec §6.6 — healthy for this long resets the backoff to 1 s. */
export const STREAM_HEALTHY_RESET_MS = 30_000;
/** spec §6.6 — fall back to replay after this many failures inside the window. */
export const STREAM_FAILURES_BEFORE_REPLAY = 3;
export const STREAM_FAIL_WINDOW_MS = 60_000;
/** spec §6.6 — while replaying, retry live this often. */
export const STREAM_REPLAY_RETRY_MS = 30_000;

/**
 * spec §5.5 / §6.5 — transfer encoding stride: n * STRIDE Float64 values per
 * batch. Field offsets are documented in `engine/ingest/encode.ts`.
 */
export const STRIDE = 11;

/** spec §6.2.8 — display titles are truncated to this length. */
export const TITLE_MAX_CHARS = 80;

/**
 * spec §6.2.6 — revert detection. The `recentchange` stream carries **no**
 * revert flag, so this is a comment-text heuristic and therefore best-effort:
 * a miss means a revert is scored as an ordinary edit, and a false positive
 * means a normal edit gets a gong. Both are non-fatal (§2.3.4 "honest data"
 * is preserved by the bot/revert ratios being surfaced in the HUD stats).
 *
 * Case-insensitive. Edit entries when tuning this list.
 */
export const REVERT_PATTERNS: readonly RegExp[] = [
  /^Reverted\b/i,
  /^Revert(ed)?\b/i,
  /^Undid revision/i,
  /^Undo\b/i,
  /\bmw-rollback\b/i,
  /^Rollback/i,
  // Localized prefixes (spec §6.2.6).
  /^Revertidos?/i, // es
  /Rückgängig/i, // de
  /^Révocation/i, // fr
  /^Annulation/i, // fr
  /^Annullata/i, // it
  /^Ripristino/i, // it
  /^Revertido/i, // pt
  /^Desfeita/i, // pt
  /^Откат/i, // ru
  /^Отмена/i, // ru
] as const;

/** spec §6.2.7 — host patterns for the Wikipedia family projects. */
export const WIKI_PROJECT_HOSTS = [
  "wikipedia",
  "wiktionary",
  "wikisource",
  "wikibooks",
  "wikiquote",
  "wikinews",
  "wikiversity",
  "wikivoyage",
] as const;

/** spec §6.2.4 — anonymous editor identifiers. */
export const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
export const IPV6_RE = /^[0-9a-f:]+$/i;
export const TEMP_ACCOUNT_RE = /^~/;

/** spec §6.2.9 — magnitude divisor: log2(1+absDelta)/MAG_LOG_DIV ⇒ 16 KB ≈ 1.0. */
export const MAG_LOG_DIV = 14;

/**
 * spec §6.5 — shared project table. `projectCode` in the wire format is an
 * index into this array, so **the order is part of the protocol** and must not
 * be changed without changing both sides together.
 */
export const PROJECTS: readonly ProjectId[] = [
  "wikipedia",
  "wiktionary",
  "wikisource",
  "wikibooks",
  "wikiquote",
  "wikinews",
  "wikiversity",
  "wikivoyage",
  "wikidata",
  "commons",
  "meta",
  "other",
] as const;

/** Reverse lookup for `projectCode`. Returns -1 for unknown codes. */
export function projectFromCode(code: number): ProjectId {
  return PROJECTS[code] ?? "other";
}

// ─────────────────────────────────────────────────────────────────────────────
// Harmony — spec §7.4
// ─────────────────────────────────────────────────────────────────────────────

/** C3 = 48. */
export const ROOT_MIDI_BASE = 48; // spec §7.4
/** Probability of returning to the tonic chord from a non-tonic chord. */
export const TONIC_RETURN_P = 0.45; // spec §7.4
/** Mode energy thresholds — spec §7.4. `E < b[i]` selects mode i. */
export const MODE_ENERGY_BOUNDS: readonly { mode: ModeId; below: number }[] = [
  { mode: "aeolian", below: 0.22 },
  { mode: "dorian", below: 0.45 },
  { mode: "mixolydian", below: 0.7 },
  { mode: "lydian", below: Infinity },
] as const;
/** spec §7.4 — keep the current mode if E is within ±this of the boundary. */
export const MODE_HYSTERESIS = 0.04;
/** spec §7.4 — key walk weights: +7, +5, +2, -3. */
export const KEY_WALK_OFFSETS: readonly number[] = [7, 5, 2, -3] as const;
export const KEY_WALK_WEIGHTS: readonly number[] = [0.4, 0.4, 0.1, 0.1] as const;
export const MODE_NAMES: readonly ModeId[] = ["lydian", "mixolydian", "dorian", "aeolian"] as const;
export const PITCH_CLASS_NAMES: readonly string[] = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Routing / density / scheduling — spec §7.3, §7.5–§7.8
// ─────────────────────────────────────────────────────────────────────────────

/** spec §7.3 — `targetNotesPerSec = lerp(SPARSE, DENSE, E) * densityMul`. */
export const NOTES_PER_SEC_MIN = 1.2;
export const NOTES_PER_SEC_MAX = 6.0;
export const DENSITY_MUL: Record<"sparse" | "normal" | "dense", number> = {
  sparse: 0.6,
  normal: 1.0,
  dense: 1.5,
}; // spec §7.3

/** spec §7.5 — `magnitude >= 0.60` routes to the sub voice. */
export const SUB_MAGNITUDE_THRESHOLD = 0.6;
/** spec §7.5 — probability that a large edit also plays its normal mapping. */
export const SUB_DOUBLE_PROB = 0.35;
/** spec §7.5 — velocity formula bounds. */
export const VEL_MIN = 0.15;
export const VEL_MAX = 0.9;

/** spec §7.6 — pitch ranges per voice. */
export const BELL_MIDI_LO = 76;
export const BELL_MIDI_HI = 100;
export const PLUCK_MIDI_LO = 64;
export const PLUCK_MIDI_HI = 88;
export const SUB_MIDI_LO = 28;
export const SUB_MIDI_HI = 40;
export const GONG_MIDI_LO = 36;
export const GONG_MIDI_HI = 48;
export const PAD_MIDI_LO = 52;
export const PAD_MIDI_HI = 79;
export const PAD_MAX_NOTES = 5;

/** spec §7.6 — birth arpeggio: 4 notes on successive 1/16 steps. */
export const BIRTH_NOTES = 4;
export const BIRTH_VEL_SCALE: readonly number[] = [1.0, 0.9, 0.8, 0.7] as const;

/** spec §7.7 — scheduler limits. */
export const MAX_MELODIC_PER_STEP_LOW_ENERGY = 1; // E < 0.3
export const MAX_MELODIC_PER_STEP = 2;
export const MELODIC_LOW_ENERGY = 0.3;
export const MELODIC_LOOKAHEAD_COUNT = 8; // pickBest scan depth
export const QUEUE_ITEM_MAX_AGE_SEC = 4; // spec §7.7 (drop stale)
export const SUB_MAX_PER_BAR = 2; // spec §7.7
export const SUB_MAX_CONCURRENT = 3;
export const GONG_MAX_CONCURRENT = 2;
export const GONG_COOLDOWN_SEC = 1.2; // spec §7.7
export const BIRTH_COOLDOWN_SEC = 1.5; // spec §7.7

/** spec §7.8 — Euclidean percussion. */
export const PERC_STEPS = 16;
export const THUD_K_LO = 2;
export const THUD_K_HI = 6;
export const TICK_K_LO = 3;
export const TICK_K_HI = 11;
export const THUD_ROTATE_STRIDE = 3; // phraseIndex * 3 % 16
export const TICK_ROTATE_STRIDE = 5; // phraseIndex * 5 + 2 % 16
export const BOT_NORM_REBUILD_THRESHOLD = 0.15; // spec §7.8
export const THUD_VEL_BASE = 0.45;
export const THUD_VEL_BOT = 0.35;
export const TICK_VEL_BASE = 0.2;
export const TICK_VEL_BOT = 0.2;

/** spec §7.9 — spatial mapper. */
export const LANG_HOMES = 64; // Fibonacci-sphere unit vectors
export const SHELL_RADIUS_LO = 7;
export const SHELL_RADIUS_HI = 13;
export const SHELL_RADIUS_SPAN = SHELL_RADIUS_HI - SHELL_RADIUS_LO;
export const JITTER_SIGMA_RAD = 0.3;

/** spec §10.2 — sparks target just outside the orb surface. */
export const SPARK_TARGET_RADIUS = 1.25;

// ─────────────────────────────────────────────────────────────────────────────
// Audio — spec §8
// ─────────────────────────────────────────────────────────────────────────────

/** spec §8.6 — per-voice output gains. */
export const VOICE_GAIN: Record<VoiceType, number> = {
  bell: 0.3,
  pluck: 0.35,
  sub: 0.55,
  gong: 0.12,
  thud: 0.8,
  tick: 0.25,
}; // spec §8.6

/** spec §8.6 — bell FM ratio table, indexed by `edit.id % 3`. */
export const BELL_RATIOS: readonly number[] = [3.5, 3.99, 2.76] as const;
/** spec §8.6 — bell pitch normalisation range. */
export const BELL_PITCH_LO_MIDI = 76;
export const BELL_PITCH_SPAN_MIDI = 24;
export const BELL_TAU_A_LO = 1.2; // highest pitch (shortest decay)
export const BELL_TAU_A_HI = 0.5;
export const BELL_TAU_I_RATIO = 0.35;
export const BELL_I0_LO = 1.2;
export const BELL_I0_HI = 4.0;

/** spec §8.6 — pluck partials: amp = [1.0, 0.45, 0.20], tau_k = tau1 / k. */
export const PLUCK_PARTIAL_AMPS: readonly number[] = [1.0, 0.45, 0.2] as const;
export const PLUCK_PARTIAL_DETUNE = 0.0004; // freq_k = f * k * sqrt(1 + 0.0004k²)
export const PLUCK_TAU_LO = 0.9; // lowest pitch (longest decay)
export const PLUCK_TAU_HI = 0.35;
export const PLUCK_PITCH_LO_MIDI = 64;
export const PLUCK_PITCH_SPAN_MIDI = 24;

/** spec §8.6 — sub swell. */
export const SUB_ATTACK_SEC = 0.06;
export const SUB_DECAY_TAU = 1.1;
export const SUB_PITCH_BEND = 0.012;
export const SUB_PITCH_BEND_TAU = 0.4;
export const SUB_DRIVE = 1.4;
export const SUB_HARMONIC_MIX = 0.15;
export const SUB_DURATION = 4.0;

/** spec §8.6 — gong: 7 inharmonic partials. */
export const GONG_RATIOS: readonly number[] = [1.0, 2.0, 2.76, 4.07, 5.4, 6.99, 8.93] as const;
export const GONG_AMPS: readonly number[] = [1.0, 0.6, 0.55, 0.35, 0.3, 0.2, 0.12] as const;
export const GONG_TAU0 = 4.5;
export const GONG_SHIMMER_HZ = 0.7;
export const GONG_TAU_K_FALLOFF = 0.55;
export const GONG_TRANSIENT = 0.15;
export const GONG_TRANSIENT_TAU = 0.012;
export const GONG_DURATION = 9.0;

/** spec §8.6 — thud (bot). */
export const THUD_F0 = 48;
export const THUD_PITCH_JUMP = 90;
export const THUD_PITCH_TAU = 0.03;
export const THUD_DECAY_TAU = 0.11;
export const THUD_NOISE_MIX = 0.25;
export const THUD_LP_A = 0.2;
export const THUD_TRANSIENT_TAU = 0.004;
export const THUD_DURATION = 0.45;

/** spec §8.6 — tick (bot). */
export const TICK_HP_A = 0.5;
export const TICK_DECAY_TAU = 0.022;
export const TICK_DURATION = 0.12;

/** spec §8.6 — common envelope, applied by `Voice.sample`. */
export const FADE_IN_SEC = 0.003;
export const FADE_OUT_SEC = 0.03;

/** spec §8.7 — mix sends. */
export const REVERB_SEND = 0.3;
export const DELAY_SEND = 0.12;
export const PAD_REVERB_SEND = 0.45;
export const PAD_DUCK_GAIN = 0.65;
export const PAD_DUCK_ATTACK_TC = 0.02;
export const PAD_DUCK_RELEASE_AT = 0.12;
export const PAD_DUCK_RELEASE_TC = 0.45;

/** spec §8.7 — ping-pong delay. */
export const DELAY_STEPS_A = 3;
export const DELAY_STEPS_B = 4;
export const DELAY_FEEDBACK = 0.35;
export const DELAY_LP_HZ = 3500;

/** spec §8.7 — master chain. */
export const COMP_THRESHOLD_DB = -10;
export const COMP_KNEE = 6;
export const COMP_RATIO = 8;
export const COMP_ATTACK = 0.004;
export const COMP_RELEASE = 0.2;
export const SOFTCLIP_DRIVE = 1.2;
export const SOFTCLIP_POINTS = 2048;
export const MASTER_BASE_GAIN = 0.9; // master = 0.9 * volume²

/** spec §8.7 — procedural reverb IR. */
export const IR_PRE_DELAY_SEC = 0.025;
export const IR_EARLY_COUNT = 6;
export const IR_EARLY_LO = 0.03;
export const IR_EARLY_HI = 0.09;
export const IR_EARLY_AMP_HI = 0.5;
export const IR_EARLY_AMP_LO = 0.15;
export const IR_LP_LO = 0.15;
export const IR_LP_HI = 0.92;

/** spec §8.8 — pad / drone / air. */
export const PAD_OSC_SAW_GAIN = 0.03;
export const PAD_OSC_TRI_GAIN = 0.04;
export const PAD_OSC_DETUNE_CENTS = 7;
export const PAD_LOWPASS_Q = 0.4;
export const PAD_FADE_IN_TC = 1.4;
export const PAD_FADE_OUT_TC = 1.2;
export const PAD_STOP_AFTER_SEC = 9;
export const PAD_CUTOFF_BASE_HZ = 500;
export const PAD_CUTOFF_ENERGY_HZ = 2800;
export const PAD_CUTOFF_WOBBLE_HZ = 120;
export const PAD_MAX_OSCILLATORS = 22;
export const DRONE_SUB_GAIN = 0.1;
export const DRONE_ROOT_GAIN = 0.04;
export const DRONE_GLIDE_TC = 1.0;
export const AIR_LOOP_SEC = 4;
export const AIR_HIGHPASS_HZ = 400;
export const AIR_BANDPASS_HZ = 2500;
export const AIR_BANDPASS_Q = 0.7;
export const AIR_GAIN_MIN = 0.004;
export const AIR_GAIN_MAX = 0.02;

/** spec §8.9 — spatialisation. */
export const PANNER_REF_DISTANCE = 5;
export const PANNER_ROLLOFF = 0.45;
export const PANNER_MAX_DISTANCE = 10000;

/** spec §8.10 — analyser. */
export const ANALYSER_FFT_SIZE = 2048;
export const ANALYSER_SMOOTHING = 0;
/** Band edges in Hz: sub, bass, mid, high, air. */
export const BAND_HZ: readonly (readonly [number, number])[] = [
  [20, 80],
  [80, 250],
  [250, 2000],
  [2000, 8000],
  [8000, 16000],
] as const; // spec §8.10
export const BAND_DB_FLOOR = -100;
export const BAND_DB_SPAN = 60;
export const BAND_DB_OFFSET = 80; // level = (meanDb + 80) / 60
export const RMS_DB_OFFSET = 50;
export const RMS_DB_SPAN = 40;
export const FLUX_TAU = 0.12;
export const FEATURE_ATTACK_TAU = 0.05;
export const FEATURE_RELEASE_TAU = 0.35;

/** spec §8.13 — lifecycle. */
export const MASTER_FADE_IN_SEC = 2.5;
export const MASTER_DISPOSE_FADE_SEC = 0.3;
export const MUTE_FADE_TC = 0.05;
export const OUTPUT_LATENCY_FALLBACK = 0.02;

// ─────────────────────────────────────────────────────────────────────────────
// Quality tiers — spec §8.12 (audio) and §12.3 (visual)
// ─────────────────────────────────────────────────────────────────────────────

export interface TierParams {
  /** worklet output count == voice budget (spec §8.5, §8.12) */
  voices: number;
  panning: "HRTF" | "equalpower";
  /** reverb IR length, seconds (spec §8.12) */
  reverbIrSec: number;
  padOscPerNote: number;

  /** max render scale as a multiple of devicePixelRatio (spec §12.3) */
  maxRenderScale: number;
  orbDetail: number;
  orbSteps: number;
  orbOctaves: number;
  sparkCapacity: number;
  particleFactor: number;
  dustPoints: number;
  bloomLevels: number;
  chromaticAberration: boolean;
  grainOpacity: number;
  /** musical/visual events per second (spec §12.3) */
  maxPerSec: number;
}

export const TIER_PARAMS: Record<Tier, TierParams> = {
  high: {
    voices: 16,
    panning: "HRTF",
    reverbIrSec: 3.5,
    padOscPerNote: 2,
    maxRenderScale: 2,
    orbDetail: 5,
    orbSteps: 8,
    orbOctaves: 3,
    sparkCapacity: 24576,
    particleFactor: 1.0,
    dustPoints: 30000,
    bloomLevels: 5,
    chromaticAberration: true,
    grainOpacity: 0.06,
    maxPerSec: 40,
  },
  medium: {
    voices: 12,
    panning: "HRTF",
    reverbIrSec: 2.5,
    padOscPerNote: 2,
    maxRenderScale: 1.5,
    orbDetail: 4,
    orbSteps: 5,
    orbOctaves: 2,
    sparkCapacity: 12288,
    particleFactor: 0.7,
    dustPoints: 15000,
    bloomLevels: 4,
    chromaticAberration: true,
    grainOpacity: 0.06,
    maxPerSec: 28,
  },
  low: {
    voices: 8,
    panning: "equalpower",
    reverbIrSec: 1.5,
    padOscPerNote: 1,
    maxRenderScale: 1.0,
    orbDetail: 3,
    orbSteps: 3,
    orbOctaves: 2,
    sparkCapacity: 6144,
    particleFactor: 0.5,
    dustPoints: 6000,
    bloomLevels: 3,
    chromaticAberration: false,
    grainOpacity: 0.02,
    maxPerSec: 16,
  },
} as const;

/** spec §5.5 — allocator priority bonus per voice kind (§8.5). */
export const KIND_PRIORITY_BONUS: Record<VoiceType, number> = {
  gong: 0.6,
  sub: 0.4,
  bell: 0.1,
  pluck: 0.1,
  thud: 0,
  tick: 0,
};

/** spec §8.5 — wire encoding of voice kind. Index into this table. */
export const VOICE_KINDS: readonly VoiceType[] = [
  "bell",
  "pluck",
  "sub",
  "gong",
  "thud",
  "tick",
] as const;

/** spec §8.5 — voice kinds capped at 2 concurrent / 3 concurrent. */
export const KIND_CONCURRENT_CAP: Partial<Record<VoiceType, number>> = {
  gong: GONG_MAX_CONCURRENT,
  sub: SUB_MAX_CONCURRENT,
};

/** spec §8.5 — worklet pending-queue capacity per slot. */
export const WORKLET_QUEUE_CAP = 8;

// ─────────────────────────────────────────────────────────────────────────────
// World / visuals — spec §9
// ─────────────────────────────────────────────────────────────────────────────

/** spec §9.1 — core radius; edits spawn on a 7–13 shell. */
export const CORE_RADIUS = 1.2;
export const ORB_SURFACE_RADIUS = CORE_RADIUS * 1.05; // spec §9.4 (raymarch R)
export const CAMERA_RADIUS = 5.5;
export const CAMERA_FOV = 58;
export const CAMERA_NEAR = 0.1;
export const CAMERA_FAR = 200;
export const CAMERA_ENTER_FROM = 9; // spec §9.1 (9 → target over 2.5 s)
export const CAMERA_ENTER_SEC = 2.5;
export const CAMERA_YAW_RATE = 0.03; // spec §9.1 (rad/s)
export const CAMERA_PITCH_BASE = 0.18;
export const CAMERA_PITCH_AMP = 0.12;
export const CAMERA_PITCH_RATE = 0.05;
export const CAMERA_DIST_ENERGY_PULL = 0.5; // 5.5 − 0.5·E
export const CAMERA_DIST_TAU = 3;
export const CAMERA_DRIFT_AMP = 0.15;
export const CAMERA_DRIFT_RATE = 0.05;
export const CAMERA_DRAG_SENS = 0.005;
export const CAMERA_PITCH_CLAMP = 1.2;
export const CAMERA_DRAG_DAMP = 3; // exp(−dt·3)
export const TRAUMA_DECAY_PER_SEC = 1.2;
export const TRAUMA_SHAKE_AMP = 0.03; // trauma² · this
export const TRAUMA_SHAKE_RATE = 25; // Hz
export const TRAUMA_LARGE_EDIT = 0.15;
export const TRAUMA_REVERT = 0.3;

/** spec §9.4 — orb uniforms. */
export const ORB_MAX_STEPS = 8; // shader loop bound
export const ORB_IMPACT_SLOTS = 16;
export const ORB_IMPACT_LIFETIME_SEC = 2.5;
export const ORB_DISPLACE_BASE = 0.05;
export const ORB_DISPLACE_BASS = 0.1;
export const ORB_RIPPLE_AMP = 0.06;
export const ORB_RMS_AMP = 0.03;

/** spec §9.5 — sparks. */
export const SPARK_DELAY_STEP = 0.018;
export const SPARK_DUR_LO = 1.1;
export const SPARK_DUR_HI = 1.8;
export const SPARK_COUNT_LO = 10;
export const SPARK_COUNT_HI = 26;
export const SPARK_COUNT_LARGE = 36;
export const SPARK_BURST_COUNT = 48;
export const SPARK_BOT_COUNT = 1;
export const SPARK_HEAD_BRIGHT_LO = 1.5;
export const SPARK_HEAD_BRIGHT_HI = 3.5;
/** spec §9.5 — rebase the clock before float32 time precision degrades. */
export const TIME_REBASE_SEC = 21_600; // 6 h

/** spec §9.6 — shockwave rings. */
export const RING_CAP = 24;
export const RING_DURATION = 2.2;
export const RING_SIZE_LO = 0.1;
export const RING_SIZE_HI = 3.5;
export const RING_THICK_LO = 0.1;
export const RING_THICK_HI = 0.02;
export const RING_INTENSITY = 2.5;

/** spec §9.7 — dust. */
export const DUST_RADIUS_LO = 3;
export const DUST_RADIUS_HI = 40;
export const DUST_POINT_SIZE_LO = 1;
export const DUST_POINT_SIZE_HI = 6;
export const DUST_TWINKLE_BASE = 0.25;
export const DUST_TWINKLE_AMP = 0.75;

/** spec §9.8 — post-processing. */
export const BLOOM_INTENSITY_BASE = 0.9;
export const BLOOM_INTENSITY_RMS = 0.6;
export const BLOOM_LUMA_THRESHOLD = 0.55;
export const BLOOM_LUMA_SMOOTHING = 0.25;
export const BLOOM_RADIUS = 0.75;
export const CA_OFFSET_BASE = 0.0004;
export const CA_KICK_REVERT = 0.0025;
export const CA_KICK_TAU = 0.35;
export const CA_RADIAL_MODULATION = true;
export const CA_MODULATION_OFFSET = 0.15;
export const VIGNETTE_DARKNESS = 0.55;
export const VIGNETTE_OFFSET = 0.3;
export const GRAIN_OPACITY_HIGH = 0.06;
export const GRAIN_OPACITY_LOW = 0.02;

/** spec §9.10 — performance governor. */
export const GOV_SCALE_MIN = 0.55;
export const GOV_SCALE_STEP_DOWN = 0.1;
export const GOV_SCALE_STEP_UP = 0.05;
export const GOV_EMA_ALPHA = 0.05;
export const GOV_SLOW_MS = 20;
export const GOV_FAST_MS = 14.5;
export const GOV_SLOW_HOLD_MS = 1000;
export const GOV_FAST_HOLD_MS = 4000;
export const GOV_CHANGE_COOLDOWN_MS = 2000;
export const GOV_CHANGE_COOLDOWN_FAST_MS = 4000;
export const GOV_WARMUP_MS = 3000;
export const GOV_SPIKE_MS = 250;
export const GOV_MAX_LEVEL = 6;
export const GOV_LEVEL5_RATE_MUL = 0.7;

/** spec §9.11 — reduced motion / photosensitivity limits. */
export const RM_DRIFT_MUL = 0.4;
export const RM_RIPPLE_MUL = 0.5;
export const RM_BLOOM_CAP = 0.7;
export const RM_SPARK_DUR_MUL = 1.3;
/** Every global brightness modulation is low-passed and amplitude-limited. */
export const BRIGHTNESS_TAU_MIN = 0.15;
export const BRIGHTNESS_AMPLITUDE_LIMIT = 0.35; // ±35 %
export const FLASH_MAX_HZ = 3;

// ─────────────────────────────────────────────────────────────────────────────
// A/V sync, labels, UI — spec §9.9, §10, §11
// ─────────────────────────────────────────────────────────────────────────────

/** spec §10.1 — visual queue. */
export const VISUAL_QUEUE_CAP = 256;
export const VISUAL_MAX_FIRE_PER_FRAME = 8;
export const VISUAL_STALE_SEC = 2.0;
/** spec §10.2 — delayed "at arrival" orb impacts. */
export const PENDING_IMPACT_CAP = 32;

/** spec §9.9 — label pool. */
export const LABEL_POOL_SIZE = 6;
export const LABEL_IMPORTANCE_MIN = 0.55;
export const LABEL_MIN_INTERVAL_SEC = 1.2;
export const LABEL_LIFETIME_SEC = 3.2;
export const LABEL_FADE_IN_SEC = 0.3;
export const LABEL_FADE_OUT_SEC = 0.9;
export const LABEL_OFFSET_Y = 0.25;

/** spec §9.9 / §11.4 — ticker. */
export const NOTABLE_IMPORTANCE_MIN = 0.6;
export const TICKER_MIN_INTERVAL_SEC = 2.5;

/** spec §5.5 / §11.4 — engine → shell update rate. */
export const STATS_EMIT_HZ = 4;
export const STATS_EMIT_INTERVAL_MS = 1000 / STATS_EMIT_HZ;

/** spec §11.3 — settings defaults. */
export const DEFAULT_VOLUME = 0.8;
export const DEFAULT_AV_SYNC_MS = 0;
export const AV_SYNC_MIN_MS = -100;
export const AV_SYNC_MAX_MS = 100;
export const SETTINGS_STORAGE_KEY = "sok.settings.v2"; // spec §11.3

/** spec §11.4 — HUD auto-fade. */
export const HUD_IDLE_FADE_SEC = 5;
export const HUD_FADED_OPACITY = 0.25;

/** spec §13.3 — offline render defaults. */
export const OFFLINE_SAMPLE_RATE = 48000;
export const OFFLINE_SECONDS = 120;
export const OFFLINE_ENERGY_TARGETS: readonly number[] = [0.3, 0.6, 0.9] as const;

/** spec §8.4 — mix acceptance thresholds, used by the render harness. */
export const MIX_PEAK_MAX_DB = -1.0;
export const MIX_RMS_MIN_DB = -24;
export const MIX_RMS_MAX_DB = -16;
export const MIX_CREST_MIN_DB = 10;
export const MIX_CREST_MAX_DB = 22;
export const MIX_BAND_SHARE: readonly (readonly [keyof BandShare, number, number])[] = [
  ["sub", 0.08, 0.3],
  ["bass", 0.1, 0.3],
  ["mid", 0.25, 0.5],
  ["high", 0.05, 0.25],
  ["air", 0, 0.08],
] as const;
export const CLIP_THRESHOLD = 0.999;
export const STRESS_MAX_DROP_RATIO = 0.35;

export interface BandShare {
  sub: number;
  bass: number;
  mid: number;
  high: number;
  air: number;
}

/** spec §6.7 — synthetic source model. */
export const SYNTH_BASE_RATE = 14; // events/s
export const SYNTH_RATE_AMP = 0.6;
export const SYNTH_RATE_PERIOD_SEC = 90;
export const SYNTH_BURST_PROB = 0.02; // per second
export const SYNTH_BURST_LO = 20;
export const SYNTH_BURST_HI = 60;
export const SYNTH_BURST_SPREAD_SEC = 3;
export const SYNTH_ZIPF_S = 1.1;
export const SYNTH_LANGS: readonly string[] = [
  "en",
  "de",
  "fr",
  "es",
  "ru",
  "ja",
  "it",
  "zh",
  "pt",
  "ar",
  "pl",
  "nl",
  "sv",
  "uk",
  "vi",
  "ko",
  "fa",
  "id",
  "tr",
  "cs",
  "he",
  "hu",
  "fi",
  "ca",
  "no",
  "th",
  "ro",
  "el",
  "bg",
  "da",
] as const; // spec §6.7 (30 languages)
export const SYNTH_BOT_P = 0.2;
export const SYNTH_ANON_P = 0.22;
/** Remainder (58 %) is `registered`. */
export const SYNTH_REVERT_P = 0.03;
export const SYNTH_NEW_P = 0.03;
export const SYNTH_POSITIVE_P = 0.62;
export const SYNTH_LOGNORMAL_MU = Math.log(80);
export const SYNTH_LOGNORMAL_SIGMA = 1.6;
export const SYNTH_ABSDELTA_LO = 1;
export const SYNTH_ABSDELTA_HI = 60000;
export const SYNTH_REVERT_NEGATIVE_P = 0.7;

/** spec §6.7 / T1.3 — replay recording shape. */
export const REPLAY_TARGET_SEC = 180; // ~3 min
export const REPLAY_MAX_BYTES = 300 * 1024; // §6.7 (≤ 300 KB)

// ─────────────────────────────────────────────────────────────────────────────
// Derived helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Spec §7.1 — chord duration in seconds (4 bars). */
export const CHORD_SEC = CHORD_BARS * 16 * STEP_SEC;

/** Spec §7.1 — phrase duration in seconds (8 bars). */
export const PHRASE_SEC = PHRASE_BARS * 16 * STEP_SEC;

/** Spec §7.1 — key-change cadence in seconds (32 bars). */
export const KEY_CHANGE_SEC = KEY_CHANGE_BARS * 16 * STEP_SEC;

/** Master gain from the perceptual taper in §8.7: `0.9 × volume²`. */
export function masterGainFor(volume: number): number {
  const v = volume < 0 ? 0 : volume > 1 ? 1 : volume;
  return MASTER_BASE_GAIN * v * v;
}

/** Pitch-class name for a root, e.g. 0 → "C". */
export function keyName(rootPc: number): string {
  const pc = ((rootPc % 12) + 12) % 12;
  return PITCH_CLASS_NAMES[pc] ?? "C";
}

/** Spec §5.4 — URL of the bundled worklet, loaded via `audioWorklet.addModule`. */
export const WORKLET_URL = "/engine/voice-pool.worklet.js";

/** Spec §5.4 — URL of the bundled ingest worker. */
export const INGEST_WORKER_URL = "/engine/ingest.worker.js";
