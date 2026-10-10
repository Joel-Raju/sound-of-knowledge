/**
 * Writes the bundled replay recording: `public/replay/sample.ndjson`.
 *
 * Spec §6.7 — ~3 minutes, ≤ 300 KB, one `{"dt": ms, "e": {...}}` line per event.
 *
 * By default this generates the file with `SyntheticSource`. If a live capture
 * is available, `scripts/record-stream.ts` writes the same format and that file
 * should be used instead (real traffic exercises the real classifier, and
 * specifically the revert heuristic, which the synthetic model only approximates).
 *
 * Idempotent for a fixed seed: running it twice produces byte-identical output.
 *
 * Usage: npx tsx scripts/gen-synthetic.ts [seed] [seconds]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REPLAY_MAX_BYTES, REPLAY_TARGET_SEC } from "../engine/config";
import { SyntheticSource } from "../engine/ingest/synthetic";
import type { ReplayLine } from "../engine/ingest/replay";
import type { NormalizedEdit } from "../engine/types";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "public/replay/sample.ndjson");

/** Strip fields the replay format does not carry and ids must be re-issued. */
function toReplayLine(edit: NormalizedEdit, dtMs: number): ReplayLine {
  const { id: _id, ts: _ts, ...rest } = edit;
  void _id;
  void _ts;
  return { dt: Math.round(dtMs), e: rest };
}

async function generate(seed: number, seconds: number): Promise<{ text: string; emitted: number }> {
  const source = new SyntheticSource({ seed });
  const lines: string[] = [];
  let prevTs = source.startTs;
  let emitted = 0;

  const STEP_MS = 50; // same cadence as the real batching loop
  for (let t = 0; t < seconds * 1000; t += STEP_MS) {
    for (const e of source.next(STEP_MS)) {
      const dt = e.ts - prevTs;
      prevTs = e.ts;
      lines.push(JSON.stringify(toReplayLine(e, dt)));
      emitted++;
    }
  }

  return { text: lines.length > 0 ? `${lines.join("\n")}\n` : "", emitted };
}

async function main(): Promise<void> {
  const seed = Number(process.argv[2] ?? 20261010);
  const targetSeconds = Number(process.argv[3] ?? REPLAY_TARGET_SEC);

  // The synthetic model runs at ~14 events/s (spec §6.7), which for 3 minutes
  // is ~2 500 lines × ~265 B ≈ 660 KB — nearly double the §6.7 budget of
  // 300 KB. Real traffic is ~6 events/s post-normalize and fits comfortably.
  // So rather than hard-failing the synthetic fallback, shorten the recording
  // until it fits and say so. The replay loops forever regardless (§6.7), so a
  // shorter file is functionally equivalent.
  let seconds = targetSeconds;
  let text = "";
  let emitted = 0;
  let bytes = 0;
  let attempts = 0;

  for (;;) {
    const gen = await generate(seed, seconds);
    text = gen.text;
    emitted = gen.emitted;
    bytes = Buffer.byteLength(text, "utf8");
    attempts++;
    if (bytes <= REPLAY_MAX_BYTES || attempts >= 12 || seconds < 20) break;
    // Scale duration by the size ratio, with 2 % headroom.
    seconds = Math.max(20, Math.floor(seconds * (REPLAY_MAX_BYTES / bytes) * 0.98));
  }

  if (bytes > REPLAY_MAX_BYTES) {
    console.error(
      `ERROR: generated ${(bytes / 1024).toFixed(1)} KB > ${REPLAY_MAX_BYTES / 1024} KB budget (spec §6.7).`,
    );
    process.exit(1);
  }
  if (seconds < targetSeconds) {
    console.log(`NOTE: shortened to ${seconds}s to fit the ${REPLAY_MAX_BYTES / 1024} KB budget.`);
  }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, text, "utf8");

  console.log(`Wrote ${OUT}`);
  console.log(`  seed        ${seed}`);
  console.log(
    `  duration    ${seconds}s${seconds < targetSeconds ? ` (target ${targetSeconds}s)` : ""}`,
  );
  console.log(`  events      ${emitted} (${(emitted / seconds).toFixed(1)}/s)`);
  console.log(
    `  size        ${(bytes / 1024).toFixed(1)} KB  (budget ${REPLAY_MAX_BYTES / 1024} KB)`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
