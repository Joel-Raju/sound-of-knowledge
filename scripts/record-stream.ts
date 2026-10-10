/**
 * Records live Wikimedia traffic to the replay format. Spec §6.7 / §6.6.
 *
 * This is the *preferred* source for `public/replay/sample.ndjson`: a real
 * capture exercises the real normalizer, so the replay fallback reproduces
 * genuine bot ratios, revert heuristics and project mixes rather than the
 * synthetic model. `scripts/gen-synthetic.ts` is the fallback when the network
 * is unavailable — record the substitution in `docs/DECISIONS.md`.
 *
 * Output format is identical to the synthetic generator, so the two files are
 * interchangeable:
 *   `{"dt": <ms since previous>, "e": {<NormalizedEdit without id/ts>}}`
 *
 * Usage: npx tsx scripts/record-stream.ts [seconds] [outfile]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REPLAY_MAX_BYTES, STREAM_URL } from "../engine/config";
import { normalize } from "../engine/ingest/normalize";
import { passes, DEFAULT_FILTERS } from "../engine/ingest/filters";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function main(): Promise<void> {
  const seconds = Number(process.argv[2] ?? 180);
  const out = resolve(ROOT, process.argv[3] ?? "public/replay/sample.ndjson");

  console.log(`Recording ${seconds}s from ${STREAM_URL} → ${out}`);

  const controller = new AbortController();
  const res = await fetch(STREAM_URL, {
    headers: { Accept: "text/event-stream" },
    signal: controller.signal,
  });
  if (!res.ok || !res.body) throw new Error(`stream returned ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  const lines: string[] = [];
  const stats = { parseErrors: 0, seen: 0, kept: 0, bot: 0, revert: 0, newPage: 0 };
  let buffer = "";
  let prevTs = Date.now();
  const start = Date.now();

  try {
    outer: for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunk = buffer.split("\n");
      buffer = chunk.pop() ?? "";

      for (const line of chunk) {
        if (!line.startsWith("data:")) continue;
        const body = line.slice(5).trim();
        if (!body) continue;

        let obj: unknown;
        try {
          obj = JSON.parse(body);
        } catch {
          continue;
        }
        stats.seen++;

        const edit = normalize(obj, stats);
        if (!edit) continue;
        if (!passes(edit, DEFAULT_FILTERS)) continue;

        // Redact nothing — `normalize` already discarded the username (§14.2).
        if (edit.actor === "bot") stats.bot++;
        if (edit.kind === "revert") stats.revert++;
        if (edit.kind === "new") stats.newPage++;
        stats.kept++;

        const dt = Math.max(0, edit.ts - prevTs);
        prevTs = edit.ts;
        const { id: _id, ts: _ts, ...rest } = edit;
        void _id;
        void _ts;
        lines.push(JSON.stringify({ dt, e: rest }));

        if (Date.now() - start >= seconds * 1000) break outer;
      }
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (!/terminated|abort/i.test(msg)) throw err;
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
    try {
      controller.abort();
    } catch {
      /* already aborted */
    }
  }

  const text = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  const bytes = Buffer.byteLength(text, "utf8");

  const total = stats.kept || 1;
  console.log("\n─── Recording summary ────────────────────────────────────");
  console.log(`Duration          ${((Date.now() - start) / 1000).toFixed(1)}s`);
  console.log(`Raw events seen   ${stats.seen}`);
  console.log(`Kept (post-filter) ${stats.kept}`);
  console.log(`Parse errors      ${stats.parseErrors}`);
  console.log(`Bot ratio         ${((stats.bot / total) * 100).toFixed(1)}%`);
  console.log(
    `Revert ratio      ${((stats.revert / total) * 100).toFixed(1)}%  ← compare with HUMAN-CHECK E3`,
  );
  console.log(`New-page ratio    ${((stats.newPage / total) * 100).toFixed(1)}%`);
  console.log(
    `Size              ${(bytes / 1024).toFixed(1)} KB / ${REPLAY_MAX_BYTES / 1024} KB budget`,
  );

  if (stats.kept === 0) {
    console.error("\nERROR: nothing captured — keeping the existing sample.ndjson.");
    process.exit(1);
  }
  if (bytes > REPLAY_MAX_BYTES) {
    console.error(
      `\nERROR: over the ${REPLAY_MAX_BYTES / 1024} KB budget — shorten the recording.`,
    );
    process.exit(1);
  }

  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, text, "utf8");
  console.log(`\nWrote ${out}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
