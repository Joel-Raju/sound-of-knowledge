/**
 * DSP cost benchmark. Spec §12.1 — "16 simultaneous voices render ≥ 10× faster
 * than real time" — and task T3.1.
 *
 * Renders 60 s of 48 kHz audio across 16 concurrent voice slots in pure Node,
 * with no Web Audio anywhere. This is the spec's stand-in for the audio thread
 * having headroom: if the DSP cannot outrun real time here, the browser will
 * glitch.
 *
 * Usage: npm run bench   (or: npx tsx scripts/bench.ts [seconds] [voices])
 */
import { Bell } from "../engine/audio/dsp/bell";
import { Pluck } from "../engine/audio/dsp/pluck";
import { Sub } from "../engine/audio/dsp/sub";
import { Gong } from "../engine/audio/dsp/gong";
import { Thud } from "../engine/audio/dsp/thud";
import { Tick } from "../engine/audio/dsp/tick";
import type { Voice } from "../engine/audio/dsp/voice";
import { buildVoiceParams } from "../engine/audio/voice-params";
import {
  BELL_RATIOS,
  GONG_SHIMMER_HZ,
  GONG_TAU0,
  PLUCK_TAU_LO,
  SUB_DURATION,
  THUD_DURATION,
  TICK_DURATION,
  VOICE_GAIN,
  BELL_TAU_A_LO,
  BELL_I0_LO,
} from "../engine/config";
import type { NoteEvent, NormalizedEdit } from "../engine/types";

const SR = 48000;
const seconds = Number(process.argv[2] ?? 60);
const voices = Number(process.argv[3] ?? 16);

const edit: NormalizedEdit = {
  id: 1,
  ts: 0,
  wiki: "enwiki",
  host: "en.wikipedia.org",
  lang: "en",
  project: "wikipedia",
  ns: 0,
  title: "Benchmark",
  actor: "registered",
  kind: "edit",
  minor: false,
  delta: 50,
  absDelta: 50,
  magnitude: 0.3,
  importance: 0.4,
  revNew: 1,
};

const note = (voice: NoteEvent["voice"], midi: number): NoteEvent => ({
  when: 0,
  voice,
  midi,
  freq: midi > 0 ? 440 * Math.pow(2, (midi - 69) / 12) : 0,
  vel: 0.7,
  dir: { x: 0, y: 0, z: 1 },
  radius: 9,
  flavor: "add",
  visual: false,
  edit,
});

/** Build one voice of each kind, with parameters derived exactly as at runtime. */
function makeVoice(voice: NoteEvent["voice"], midi: number): Voice {
  const n = note(voice, midi);
  const vp = buildVoiceParams(n);
  let v: Voice;
  switch (voice) {
    case "bell":
      v = new Bell();
      break;
    case "pluck":
      v = new Pluck();
      break;
    case "sub":
      v = new Sub();
      break;
    case "gong":
      v = new Gong();
      break;
    case "thud":
      v = new Thud();
      break;
    default:
      v = new Tick();
      break;
  }
  v.setSampleRate(SR);
  v.onStart(n.freq, n.vel, vp.dur, vp.p, n.edit.id);
  return v;
}

const pool: Voice[] = [];
const KIND_CYCLE: NoteEvent["voice"][] = ["bell", "pluck", "sub", "gong", "thud", "tick"];
/** Each slot keeps its own parameters so it can retrigger itself in place. */
const slotParams: { freq: number; vel: number; dur: number; p: Float64Array }[] = [];
for (let i = 0; i < voices; i++) {
  const kind = KIND_CYCLE[i % KIND_CYCLE.length]!;
  const midi = 60 + (i % 24);
  const n = note(kind, midi);
  const vp = buildVoiceParams(n);
  pool.push(makeVoice(kind, midi));
  slotParams.push({ freq: n.freq, vel: n.vel, dur: vp.dur, p: vp.p });
}

// Keep every voice retriggering so the benchmark measures sustained cost
// rather than a fast decay to silence. Stagger the first trigger so the pool
// does not all fire on the same frame.
const RETRIGGER = new Float64Array(pool.length);
const CYCLE_SEC = 2.5;
for (let i = 0; i < pool.length; i++) RETRIGGER[i] = (i / pool.length) * CYCLE_SEC;

const totalSamples = Math.round(seconds * SR);
const out = new Float32Array(128); // one render quantum
const dt = 1 / SR;

console.log("─── DSP benchmark ───────────────────────────────────────");
console.log(`voices        ${voices} (${KIND_CYCLE.join(", ")})`);
console.log(`sample rate   ${SR} Hz`);
console.log(`duration      ${seconds} s (${totalSamples.toLocaleString()} frames)`);
console.log("");

const t0 = process.hrtime.bigint();
let sum = 0;
let peak = 0;
let retriggers = 0;

for (let i = 0; i < totalSamples; i++) {
  const t = i * dt;
  let s = 0;
  for (let k = 0; k < pool.length; k++) {
    const v = pool[k]!;
    const el = t - RETRIGGER[k]!;
    if (el < 0) continue;
    if (!v.active) {
      // Re-trigger this slot in place with its own parameters. Retriggering
      // matters: without it every voice decays within a second and the rest
      // of the benchmark measures silence, which is far cheaper and tells us
      // nothing about headroom.
      const sp = slotParams[k]!;
      v.onStart(sp.freq, sp.vel, sp.dur, sp.p, k + 1);
      RETRIGGER[k] = t;
      retriggers++;
    }
    const y = v.sample(el, dt);
    s += y;
  }
  sum += s;
  const a = Math.abs(s);
  if (a > peak) peak = a;
  if (i % 128 === 127) out.fill(s);
}

const t1 = process.hrtime.bigint();
const elapsedSec = Number(t1 - t0) / 1e9;
const rtf = seconds / elapsedSec;
const perVoice = rtf / voices;

console.log(`render time   ${elapsedSec.toFixed(3)} s`);
console.log(`real-time factor ${rtf.toFixed(1)}x  (budget: >= 10x)`);
console.log(`  per voice   ${perVoice.toFixed(1)}x`);
console.log(`triggers      ${retriggers}`);
console.log(`mean |sum|    ${(Math.abs(sum) / totalSamples).toFixed(6)}`);
console.log(
  `peak |sum|    ${peak.toFixed(4)}  (mix sanity only; per-voice gain applied separately)`,
);
console.log("");

// Per-voice gains are informational here; the real mix check is §13.3.
console.log("voice gains (config §8.6):");
for (const [k, g] of Object.entries(VOICE_GAIN)) console.log(`  ${k.padEnd(8)} ${g}`);

// Constants the benchmark relies on, asserted so a config edit cannot silently
// make this benchmark vacuous.
const checks: [string, boolean][] = [
  ["BELL_RATIOS has 3 entries", BELL_RATIOS.length === 3],
  ["gong tau0 = 4.5", GONG_TAU0 === 4.5],
  ["gong shimmer = 0.7", GONG_SHIMMER_HZ === 0.7],
  ["sub dur = 4 s", SUB_DURATION === 4],
  ["thud dur = 0.45 s", THUD_DURATION === 0.45],
  ["tick dur = 0.12 s", TICK_DURATION === 0.12],
  ["pluck tau1 lo = 0.9", PLUCK_TAU_LO === 0.9],
  ["bell tauA lo = 1.2", BELL_TAU_A_LO === 1.2],
  ["bell I0 lo = 1.2", BELL_I0_LO === 1.2],
];
let failed = false;
for (const [label, ok] of checks) {
  if (!ok) {
    console.error(`  x ${label}`);
    failed = true;
  }
}

if (rtf < 10) {
  console.error(
    `\nFAIL: real-time factor ${rtf.toFixed(1)}x is below the 10x budget (spec §12.1).`,
  );
  failed = true;
}

if (failed) {
  process.exit(1);
}
console.log("");
console.log("PASS: DSP cost is within budget.");
void out;
