/**
 * Offline music simulation. Spec §15 task T2.3.
 *
 * Runs the real `Scheduler` over five minutes of synthetic edits on a virtual
 * clock, with no Web Audio anywhere, and prints the acceptance evidence:
 *
 *   - chord changes occur every 4 bars
 *   - mode changes occur only at multiples of 8 bars
 *   - average melodic notes/s is within ±30 % of `targetNotesPerSec`
 *   - no step ever carries more than 2 melodic notes
 *
 * The last two are the ones that matter musically: they say the instrument
 * plays the density it was asked to, and never glissandos.
 *
 * Usage: npx tsx scripts/sim-music.ts [seconds] [eps] [seed]
 */
import { Scheduler } from "../engine/music/scheduler";
import { SyntheticSource } from "../engine/ingest/synthetic";
import { mulberry32 } from "../engine/util/random";
import { STEP_SEC, STEPS_PER_BAR, CHORD_BARS, HUMANIZE_SEC } from "../engine/config";
import type { HarmonyEvent } from "../engine/music/harmony";
import type { NoteEvent } from "../engine/types";

const seconds = Number(process.argv[2] ?? 300);
const eps = Number(process.argv[3] ?? 6);
const seed = Number(process.argv[4] ?? 20261010);

let now = 0;
const notes: NoteEvent[] = [];
const harmony: HarmonyEvent[] = [];

const sched = new Scheduler({
  now: () => now,
  isHidden: () => false,
  rng: mulberry32(seed),
  note: (n) => {
    notes.push(n);
    return true;
  },
  harmony: (e) => harmony.push(e),
});

const source = new SyntheticSource({ seed, rateMul: eps / 14 });

// --- run -------------------------------------------------------------------
const TICK = 0.025;
const steps = Math.round(seconds / TICK);
for (let i = 0; i < steps; i++) {
  const edits = source.next(TICK * 1000);
  if (edits.length) sched.onBatch(edits);
  sched.onStats({ accepted: eps * 0.5, botAccepted: eps * 0.2 * 0.5, windowMs: 500 });
  now += TICK;
  sched.onTick();
}

// --- analyse ---------------------------------------------------------------
const origin = sched.gridOrigin;
const gridStep = (w: number): number => (w - origin) / STEP_SEC;

const byVoice = new Map<string, number>();
for (const n of notes) byVoice.set(n.voice, (byVoice.get(n.voice) ?? 0) + 1);

const melodic = notes.filter((n) => n.flavor === "add" || n.flavor === "remove");
const maxPerStep = new Map<number, number>();
let worstOffGrid = 0;
let offGridCount = 0;

for (const n of notes) {
  const s = gridStep(n.when);
  const off = Math.abs(s - Math.round(s)) * STEP_SEC;
  if (off > worstOffGrid) worstOffGrid = off;
  if (off > HUMANIZE_SEC + 1e-6) offGridCount++;
  if (n.flavor === "add" || n.flavor === "remove") {
    const k = Math.round(s);
    maxPerStep.set(k, (maxPerStep.get(k) ?? 0) + 1);
  }
}
let peakMelodicPerStep = 0;
for (const [, c] of maxPerStep) if (c > peakMelodicPerStep) peakMelodicPerStep = c;

const chordEvents = harmony.filter((e) => e.kind === "chord");
const modeEvents = harmony.filter((e) => e.kind === "mode");
const keyEvents = harmony.filter((e) => e.kind === "key");

const chordBars: number[] = chordEvents.map((e) => e.state.barCounter);
const chordEvery4 = chordBars.every((b) => b % CHORD_BARS === 0);
const modeOnPhrase = modeEvents.every((e) => e.state.barCounter % 8 === 0);

const avgMelodic = melodic.length / seconds;
const stats = sched.getStats();
const metrics = sched.getMetrics();

// target notes/s is recomputed here from the final energy so the report is
// self-consistent even if energy drifted during the run.
const targetNotesPerSec = sched.targetNotesPerSim("normal");

console.log("─── Music simulation ──────────────────────────────────────");
console.log(`duration          ${seconds}s @ ${eps} eps (seed ${seed})`);
console.log(`notes scheduled   ${metrics.notesScheduled}`);
console.log(`dropped notes     ${metrics.droppedNotes}`);
console.log(`melodic notes/s   ${avgMelodic.toFixed(2)}  (target ${targetNotesPerSec.toFixed(2)})`);
console.log(`ratio             ${(avgMelodic / targetNotesPerSec).toFixed(3)}  (want 0.7–1.3)`);
console.log("");
console.log("Voice mix:");
for (const [k, v] of [...byVoice].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(8)} ${String(v).padStart(6)}`);
}
console.log("");
console.log(
  `harmony: ${chordEvents.length} chords, ${modeEvents.length} mode changes, ${keyEvents.length} key changes`,
);
console.log(`  final  ${stats.mode} in ${stats.keyName}, chord ${stats.chordName}`);
console.log(`  chord changes every ${CHORD_BARS} bars : ${chordEvery4 ? "OK" : "VIOLATION"}`);
console.log(`  mode changes on phrase boundaries   : ${modeOnPhrase ? "OK" : "VIOLATION"}`);
console.log("");
console.log(`peak melodic notes on one step : ${peakMelodicPerStep}  (want ≤ 2)`);
console.log(
  `worst quantisation error       : ${(worstOffGrid * 1000).toFixed(2)} ms  (want ≤ ${(HUMANIZE_SEC * 1000).toFixed(0)} ms)`,
);
console.log(`notes off the grid             : ${offGridCount}`);
console.log(`E                              : ${stats.energy.toFixed(3)}`);
void STEPS_PER_BAR;

// --- exit non-zero on failure ---------------------------------------------
let failed = false;
const check = (ok: boolean, msg: string): void => {
  if (!ok) {
    console.error(`  ✗ ${msg}`);
    failed = true;
  }
};
console.log("");
console.log("Acceptance:");
const ratio = avgMelodic / targetNotesPerSec;
check(chordEvery4, "chord changes must land on multiples of 4 bars");
check(modeOnPhrase, "mode changes must land on multiples of 8 bars");
check(
  ratio >= 0.7 && ratio <= 1.3,
  `melodic notes/s within ±30 % of target (got ${(ratio * 100).toFixed(0)} %)`,
);
check(peakMelodicPerStep <= 2, `no step with > 2 melodic notes (got ${peakMelodicPerStep})`);
check(
  offGridCount === 0,
  `no notes outside the ±${(HUMANIZE_SEC * 1000).toFixed(0)} ms humanise window`,
);

if (failed) {
  console.error("\nFAIL — see violations above.");
  process.exit(1);
}
console.log("  all checks passed");
