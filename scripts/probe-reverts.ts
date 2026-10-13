/**
 * Revert-heuristic recall probe. Spec §6.2.6, checklist E3.
 *
 * E3 recorded a heuristic hit rate of 0.2 % against a 3 % model. Two possible
 * causes: the patterns miss real reverts, or real traffic simply has fewer
 * reverts than the model. Those look identical from the rate alone, so this
 * records **the edit summaries themselves** and lets them be counted.
 *
 * Writes one summary per line to `artifacts/reverts/comments-<ts>.txt` with a
 * histogram at the end, so the misses can be *read* rather than guessed at.
 * This is the same discipline as the §8.4 mix reports and the shader probe:
 * a rate with no examples behind it cannot be acted on.
 *
 * Usage: npx tsx scripts/probe-reverts.ts [--seconds 180] [--port 4350]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STREAM_URL, REVERT_PATTERNS } from "../engine/config";
import { parseHost } from "../engine/ingest/normalize";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "artifacts/reverts");

const args = process.argv.slice(2);
const seconds = Number(args[args.indexOf("--seconds") + 1]) || 180;

const isRevert = (c: string | undefined | null): boolean =>
  !!c && REVERT_PATTERNS.some((p) => p.test(c));

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = resolve(OUT, `comments-${stamp}.txt`);

  console.log(`recording ${seconds}s from ${STREAM_URL}`);
  console.log("the stream carries no revert flag — §6.2.6 matches the summary text\n");

  const counts = new Map<string, number>();
  let edits = 0;
  let matched = 0;
  const seen = new Set<string>();

  const ctrl = new AbortController();
  const stop = setTimeout(() => ctrl.abort(), seconds * 1000);

  try {
    const res = await fetch(STREAM_URL, {
      signal: ctrl.signal,
      headers: { "User-Agent": "sound-of-knowledge/2.0 (revert-heuristic probe)" },
    });
    if (!res.ok || !res.body) throw new Error(`stream returned ${res.status}`);
    process.stderr.write("connected; recording\n");

    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(line.slice(5));
        } catch {
          continue;
        }
        // Spec §6.2 — only `edit` and `new` reach the piece; a revert is an edit.
        const type = String(ev.type ?? "");
        if (type !== "edit" && type !== "new") continue;

        // Filter through the *shipped* parseHost, not a guess. The first draft
        // of this probe tested `wiki.endsWith("wikipedia.org")` and saw zero
        // events for 180 s: the stream's `wiki` field is the MediaWiki
        // **database name** ("enwiki", "commonswiki"), not a hostname. It
        // recorded nothing and reported 0.00 % with total confidence.
        const meta = (ev.meta ?? {}) as Record<string, unknown>;
        const { project } = parseHost(String(meta.domain ?? ""));
        if (project !== "wikipedia") continue;
        edits++;

        const comment = typeof ev.comment === "string" ? ev.comment : "";
        if (isRevert(comment)) matched++;
        if (comment && !seen.has(comment)) {
          seen.add(comment);
          counts.set(comment, (counts.get(comment) ?? 0) + 1);
        }
      }
    }
  } catch (e) {
    if ((e as Error).name !== "AbortError") throw e;
  } finally {
    clearTimeout(stop);
  }

  const lines = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const body = lines.map(([c, n]) => `${String(n).padStart(5)}  ${c}`).join("\n");
  writeFileSync(file, body);

  console.log(`\nWikipedia edits seen : ${edits}`);
  console.log(
    `matched as revert    : ${matched}  (${((matched / Math.max(1, edits)) * 100).toFixed(2)} %)`,
  );
  console.log(`distinct summaries   : ${lines.length}`);
  console.log(`written              : ${file}`);

  console.log("\n--- most common summaries ---");
  for (const [c, n] of lines.slice(0, 40)) {
    console.log(
      `${String(n).padStart(5)}  ${n > 0 && isRevert(c) ? "[R] " : "    "}${c.slice(0, 96)}`,
    );
  }

  // The interesting number: summaries that read like reverts but did not match.
  const SUSPECT = /\b(revert|undo|rollback|rolled back|rv)\b/i;
  const missed = lines.filter(([c]) => !isRevert(c) && SUSPECT.test(c));
  console.log(`\n--- look like reverts but did NOT match: ${missed.length} distinct ---`);
  for (const [c, n] of missed.slice(0, 40)) {
    console.log(`${String(n).padStart(5)}  ${c.slice(0, 96)}`);
  }
  if (missed.length > 0) {
    console.log("\nEvery line above is a candidate miss. Read them before changing");
    console.log("the patterns — a rate with no examples behind it cannot be acted on.");
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
