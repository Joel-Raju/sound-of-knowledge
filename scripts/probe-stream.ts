/**
 * Stream reconnaissance — spec §6.1 / task T1.1.
 *
 * Connects to the Wikimedia EventStreams SSE endpoint, parses `data:` lines
 * for `DURATION_SEC`, and reports:
 *   - raw events/s overall
 *   - share by project family (wikipedia / wikidata / other)
 *   - kind mix (edit / new / log / categorize / external)
 *   - bot ratio
 *   - revert-heuristic hit rate
 *   - the 95th percentile of **Wikipedias-only** events/s
 *
 * That p95 is what `EPS_REF` is calibrated from (spec §7.3):
 *   `EPS_REF = round(1.5 × p95(eps))`.
 *
 * Usage:
 *   npx tsx scripts/probe-stream.ts [seconds]
 *
 * ⚠️ This environment has no network route to stream.wikimedia.org, so this
 * script will report NETWORK-UNAVAILABLE and exit 1. That is the correct
 * outcome here and is recorded in docs/DECISIONS.md. Re-run it from a
 * networked machine to calibrate `EPS_REF`.
 */
import { PROJECTS, REVERT_PATTERNS, STREAM_URL } from "../engine/config";

const DURATION_SEC = Number(process.argv[2] ?? 60);
const WINDOW_SEC = 1;

interface Bucket {
  t: number;
  raw: number;
  wikipedia: number;
  /**
   * The rate that actually matters for `EPS_REF`. §7.3 defines `eps` from the
   * worker's *accepted* counter, which is post-filter — and §6.2.1 accepts
   * only `type === 'edit' | 'new'`. Since `categorize` is ~54 % of the raw
   * stream, calibrating on raw throughput would overstate E by >2×.
   */
  musical: number;
  /** musical + namespace 0 (the default `namespaces: 'main'` filter, §6.3). */
  musicalMain: number;
}

async function main(): Promise<void> {
  console.log(`Probing ${STREAM_URL} for ${DURATION_SEC}s…\n`);

  // CORS check (spec §6.1). Use a GET and abort as soon as headers arrive: the
  // SSE endpoint holds the connection open indefinitely, so a HEAD request — or
  // any fetch awaited to completion — never resolves. An earlier `curl -I`
  // attempt timed out for this reason and was misread as "no network".
  try {
    const ac = new AbortController();
    const corsRes = await fetch(STREAM_URL, {
      headers: { Origin: "https://example.com", Accept: "text/event-stream" },
      signal: ac.signal,
    });
    const acao = corsRes.headers.get("access-control-allow-origin");
    console.log(`HTTP status          ${corsRes.status}`);
    console.log(`CORS allow-origin   ${acao ?? "(absent)"}`);
    console.log(`  → browser-direct ${acao ? "ALLOWED" : "BLOCKED — proxy required per §6.6"}\n`);
    ac.abort();
  } catch (err) {
    console.log(`CORS check failed: ${(err as Error).message}\n`);
  }

  const controller = new AbortController();
  const res = await fetch(STREAM_URL, {
    headers: { Accept: "text/event-stream", Origin: "https://example.com" },
    signal: controller.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`stream returned ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  const buckets: Bucket[] = [];
  const kindCounts = new Map<string, number>();
  const projectCounts = new Map<string, number>();
  let total = 0;
  let bots = 0;
  let reverts = 0;
  let edits = 0;
  let parseErrors = 0;
  let buffer = "";
  const start = Date.now();

  const isWikipediaHost = (server: string): boolean => /\.wikipedia\.org$/.test(server);

  try {
    outer: for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw) continue;

        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          parseErrors++;
          continue;
        }

        total++;
        const type = typeof obj.type === "string" ? obj.type : "unknown";
        kindCounts.set(type, (kindCounts.get(type) ?? 0) + 1);

        const server = typeof obj.server_name === "string" ? obj.server_name : "";
        const proj = isWikipediaHost(server)
          ? "wikipedia"
          : (server.replace(/^www\./, "").split(".")[0] ?? "other");
        projectCounts.set(proj, (projectCounts.get(proj) ?? 0) + 1);

        if (obj.bot === true) bots++;
        const comment = typeof obj.comment === "string" ? obj.comment : "";
        if (REVERT_PATTERNS.some((re) => re.test(comment))) reverts++;
        if (type === "edit" || type === "new") edits++;

        // Bucket by wall clock.
        const now = (Date.now() - start) / 1000;
        let b = buckets[buckets.length - 1];
        if (!b || now - b.t >= WINDOW_SEC) {
          b = { t: now, raw: 0, wikipedia: 0, musical: 0, musicalMain: 0 };
          buckets.push(b);
        }
        b.raw++;
        if (isWikipediaHost(server)) b.wikipedia++;
        // Post-normalize + default filter (source='wikipedias'):
        // accepts only edit|new (spec §6.2.1) from wikipedia-family hosts.
        if (isWikipediaHost(server) && (type === "edit" || type === "new")) {
          b.musical++;
          if (obj.namespace === 0) b.musicalMain++;
        }

        if (now >= DURATION_SEC) break outer;
      }
    }
  } catch (err) {
    // An abort during teardown surfaces as either `AbortError` or, in undici,
    // a `TypeError: terminated`. Both mean "we stopped reading", which is the
    // normal exit path here, so both are swallowed.
    const name = (err as Error).name;
    const msg = (err as Error).message;
    if (name !== "AbortError" && !/terminated|aborted/i.test(msg)) throw err;
  } finally {
    // Ordering matters: cancel the reader *before* aborting the controller.
    // Aborting while the body stream is still locked makes undici reject with
    // "terminated", which would otherwise escape the try/catch above.
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

  const elapsed = (Date.now() - start) / 1000;
  const epsAll = total / elapsed;
  const wikiRates = buckets.map((b) => b.wikipedia / WINDOW_SEC);
  const musicalRates = buckets.map((b) => b.musical / WINDOW_SEC);
  const mainNsRates = buckets.map((b) => b.musicalMain / WINDOW_SEC);
  const rawRates = buckets.map((b) => b.raw / WINDOW_SEC);

  const pct = (arr: readonly number[], p: number): number => {
    if (arr.length === 0) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
  };
  const mean = (arr: readonly number[]): number =>
    arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;

  console.log("─── Results ─────────────────────────────────────────────");
  console.log(`Duration            ${elapsed.toFixed(1)} s`);
  console.log(`Raw throughput      ${epsAll.toFixed(1)} events/s (all projects)`);
  console.log(`Parse errors        ${parseErrors}`);
  console.log("");
  console.log("Kind mix:");
  for (const [k, v] of [...kindCounts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(12)} ${((v / total) * 100).toFixed(1)}%`);
  }
  console.log("");
  console.log("Project families:");
  for (const [k, v] of [...projectCounts].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`  ${k.padEnd(12)} ${((v / total) * 100).toFixed(1)}%`);
  }
  console.log("");
  console.log(`Bot ratio           ${((bots / total) * 100).toFixed(1)}%`);
  console.log(`Revert heuristic    ${((reverts / total) * 100).toFixed(1)}%`);
  console.log(`edits+new share     ${((edits / total) * 100).toFixed(1)}%`);
  console.log("");
  console.log("Rates (1 s buckets):");
  const row = (label: string, arr: readonly number[], mark = "") =>
    console.log(
      `  ${label.padEnd(24)} mean ${mean(arr).toFixed(1).padStart(5)}/s  p95 ${pct(arr, 0.95).toFixed(1).padStart(5)}/s${mark}`,
    );
  row("raw, all projects", rawRates);
  row("wikipedia, any type", wikiRates);
  row("wikipedia + edit|new", musicalRates, "   ← EPS_REF source");
  row("  + namespace 0", mainNsRates, "   (namespaces:'main')");
  console.log("");
  console.log(
    `▶ EPS_REF = round(1.5 × p95(post-normalize)) = ${Math.round(1.5 * pct(musicalRates, 0.95))}   (spec §7.3)`,
  );
  console.log(
    `  Spec provisional default was 60. Measured p95 is ${pct(musicalRates, 0.95).toFixed(1)}/s.`,
  );
  const epsRef = Math.max(1, Math.round(1.5 * pct(musicalRates, 0.95)));
  for (const label of ["quiet", "typical", "peak"]) {
    const eps =
      label === "quiet"
        ? Math.max(0.5, mean(musicalRates) * 0.35)
        : label === "typical"
          ? mean(musicalRates)
          : pct(musicalRates, 0.95);
    const e = Math.log10(1 + eps) / Math.log10(1 + epsRef);
    console.log(`    ${label.padEnd(8)} ${eps.toFixed(1).padStart(5)}/s → E = ${e.toFixed(2)}`);
  }
  console.log("  Set EPS_REF in engine/config.ts and record the result in DECISIONS.md.");
  void PROJECTS;
}

main().catch((err: unknown) => {
  console.error(`\nNETWORK-UNAVAILABLE: ${(err as Error).message}`);
  console.error("Record 'no network' in docs/DECISIONS.md and keep EPS_REF = 60.");
  process.exit(1);
});
