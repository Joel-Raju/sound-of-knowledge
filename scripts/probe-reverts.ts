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

/**
 * Languages §6.2.6 actually has a revert pattern for. Only these can yield a
 * *valid* rate — everywhere else the number is a lower bound, because a revert
 * we cannot recognise is scored as an ordinary edit.
 */
const COVERED = new Set(["en", "de", "fr", "es", "it", "pt", "ru"]);

/** Looks revert-shaped, for surfacing probable misses in uncovered languages. */
const SUSPECT = /\b(revert|undo|rollback|rolled back|rv)\b/i;

interface LangStat {
  edits: number;
  matched: number;
  /** distinct summaries that read like reverts but did not match */
  suspects: number;
}

/**
 * Running tallies. Module scope, not local to `main`, because `ingest` is called
 * from the connection loop and must accumulate across reconnects.
 */
const counts = new Map<string, number>();
const byLang = new Map<string, LangStat>();
const suspects = new Set<string>();
let edits = 0;
let matched = 0;
const seen = new Set<string>();

/**
 * Fold one raw stream event into the running tallies.
 *
 * A function rather than inline code in the read loop, for two reasons: it is
 * the unit of work that must survive a reconnect, and it keeps the loop's only
 * job as "read bytes".
 */
function ingest(ev: Record<string, unknown>): void {
  // Spec §6.2 — only `edit` and `new` reach the piece; a revert is an edit.
  const type = String(ev.type ?? "");
  if (type !== "edit" && type !== "new") return;

  // Filter through the *shipped* parseHost, not a guess. The first draft of this
  // probe tested `wiki.endsWith("wikipedia.org")` and saw zero events for 180 s:
  // the stream's `wiki` field is the MediaWiki **database name** ("enwiki",
  // "commonswiki"), not a hostname. It recorded nothing and reported 0.00 % with
  // total confidence.
  const meta = (ev.meta ?? {}) as Record<string, unknown>;
  const { project, lang } = parseHost(String(meta.domain ?? ""));
  if (project !== "wikipedia") return;
  edits++;

  const stat = byLang.get(lang) ?? { edits: 0, matched: 0, suspects: 0 };
  stat.edits++;
  byLang.set(lang, stat);

  const comment = typeof ev.comment === "string" ? ev.comment : "";
  if (isRevert(comment)) {
    matched++;
    stat.matched++;
  } else if (comment && SUSPECT.test(comment)) {
    // Keyed with a NUL so one bot loop cannot inflate a language's suspect count.
    suspects.add(`${lang}\u0000${comment}`);
  }
  if (comment && !seen.has(comment)) {
    seen.add(comment);
    counts.set(comment, (counts.get(comment) ?? 0) + 1);
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = resolve(OUT, `comments-${stamp}.txt`);

  console.log(`recording ${seconds}s from ${STREAM_URL}`);
  console.log("the stream carries no revert flag — §6.2.6 matches the summary text\n");

  // Tallies live at module scope so `ingest` can reach them. Redeclaring them
  // here shadows them: `ingest` counts into one set while this prints another,
  // which reports a confident "0 edits" no matter what was actually recorded.

  const ctrl = new AbortController();
  const deadline = Date.now() + seconds * 1000;
  const roundTimes: number[] = [];
  const roundErrors: string[] = [];

  /**
   * One connection. Returns when the stream ends **or** fails.
   *
   * The first 20-minute attempt died at ~11 min with `UND_ERR_SOCKET` after
   * 25 MB, and because the handler only caught my own abort, every count died
   * with the process — 11 minutes of measurement thrown away by an unhandled
   * edge. An SSE stream is *designed* to be reconnected, so this is expected
   * rather than exceptional.
   */
  const captureRound = async (): Promise<boolean> => {
    let res: Response;
    try {
      res = await fetch(STREAM_URL, {
        signal: ctrl.signal,
        headers: { "User-Agent": "sound-of-knowledge/2.0 (revert-heuristic probe)" },
      });
    } catch (e) {
      if ((e as Error).name === "AbortError") return false;
      roundErrors.push(`connect: ${(e as Error).message}`);
      return true;
    }
    if (!res.ok || !res.body) {
      roundErrors.push(`connect: stream returned ${res.status}`);
      return true;
    }
    const t0 = Date.now();
    process.stderr.write(`connected (${roundTimes.length === 0 ? "" : "re"})\n`);

    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let buf = "";
    try {
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
          ingest(ev);
        }
      }
      roundTimes.push((Date.now() - t0) / 1000);
      return true;
    } catch (e) {
      roundTimes.push((Date.now() - t0) / 1000);
      // Our own deadline abort is not a fault worth reporting — otherwise the
      // final, expected disconnect appears in a list of "reconnect reasons"
      // alongside genuine drops.
      if (Date.now() < deadline) roundErrors.push(`stream: ${(e as Error).message}`);
      return true;
    } finally {
      // Release the socket even on the happy path.
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
    }
  };

  // Keep reconnecting until the deadline. A short backoff so a hard failure
  // does not spin.
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const timer = setTimeout(() => ctrl.abort(), remaining);
    try {
      const more = await captureRound();
      if (!more) break;
    } finally {
      clearTimeout(timer);
      // A fresh AbortController per round; aborting one poisons the next fetch.
      Object.assign(ctrl, new AbortController());
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  const lines = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const body = lines.map(([c, n]) => `${String(n).padStart(5)}  ${c}`).join("\n");
  writeFileSync(file, body);

  console.log(`\nWikipedia edits seen : ${edits}`);
  console.log(
    `matched as revert    : ${matched}  (${((matched / Math.max(1, edits)) * 100).toFixed(2)} %)`,
  );
  console.log(`distinct summaries   : ${lines.length}`);
  if (roundTimes.length > 0) {
    console.log(
      `connection(s)        : ${roundTimes.length}, ` +
        `${roundTimes.map((t) => t.toFixed(0) + "s").join(" + ")}`,
    );
  }
  for (const e of roundErrors.slice(0, 5)) console.log(`  reconnect reason: ${e}`);

  // Attribute the suspects we collected back to their languages.
  for (const key of suspects) {
    const sep = key.indexOf("\u0000");
    const lang = key.slice(0, sep);
    const stat = byLang.get(lang);
    if (stat) stat.suspects++;
  }

  const langRows = [...byLang.entries()]
    .filter(([, s]) => s.edits >= 20) // enough volume for a rate to mean anything
    .sort((a, b) => b[1].edits - a[1].edits);

  console.log("\n--- by language (>= 20 edits) ---");
  console.log("  lang  edits  matched   rate    covered");
  for (const [lang, s] of langRows) {
    const rate = ((s.matched / s.edits) * 100).toFixed(2).padStart(5);
    console.log(
      `  ${lang.padEnd(5)} ${String(s.edits).padStart(5)} ${String(s.matched).padStart(7)} ${rate}%  ` +
        `${COVERED.has(lang) ? "yes" : "NO — rate is a lower bound"}`,
    );
  }

  // The headline: English alone, where §6.2.6's patterns demonstrably work,
  // sizes the real revert rate against the spec's 3 % model.
  const en = byLang.get("en");
  console.log("\n--- the model test ---");
  console.log("  spec §6.2 models 3 % reverts. English is the only language here whose");
  console.log("  detection is known-good, so its rate is the only one that measures");
  console.log("  something real rather than the bottom of a bound.\n");
  if (en && en.edits >= 50) {
    const p = en.matched / en.edits;
    const rate = p * 100;
    console.log(`  English: ${en.matched} / ${en.edits} = ${rate.toFixed(2)} %`);
    // Binomial 95 % interval, so a small count is not over-read.
    const se = Math.sqrt((p * (1 - p)) / en.edits);
    const lo = Math.max(0, (p - 1.96 * se) * 100);
    const hi = Math.min(100, (p + 1.96 * se) * 100);
    console.log(`  95 % CI: ${lo.toFixed(2)} % – ${hi.toFixed(2)} %`);
    if (hi < 3) {
      console.log(
        `\n  3 % is NOT supported by this sample — even the upper bound sits below it.\n` +
          `  The model, not the pattern, is what is wrong.`,
      );
    } else if (lo > 3) {
      console.log(`\n  English reverts run above 3 % — the model understates.`);
    } else {
      console.log(`\n  ~3 % is consistent with this sample.`);
    }
  } else {
    console.log(`  not enough English volume (${en?.edits ?? 0} edits) to size the model`);
  }

  const coveredRows = langRows.filter(([l]) => COVERED.has(l));
  const coveredEdits = coveredRows.reduce((a, [, s]) => a + s.edits, 0);
  const coveredMatched = coveredRows.reduce((a, [, s]) => a + s.matched, 0);
  if (coveredEdits > 0) {
    const r = (coveredMatched / coveredEdits) * 100;
    console.log(
      `\n  covered languages combined: ${coveredMatched} / ${coveredEdits} = ${r.toFixed(2)} %`,
    );
  }
  console.log(`\n  written: ${file}`);

  console.log("\n--- most common summaries ---");
  for (const [c, n] of lines.slice(0, 40)) {
    console.log(
      `${String(n).padStart(5)}  ${n > 0 && isRevert(c) ? "[R] " : "    "}${c.slice(0, 96)}`,
    );
  }

  // The interesting number: summaries that read like reverts but did not match.
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
