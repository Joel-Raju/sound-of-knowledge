/**
 * Normalisation of raw Wikimedia `recentchange` events. Spec §6.2.
 *
 * Pure functions, no DOM, no worker globals — unit-testable in Node and shared
 * verbatim between the ingest worker and the main thread (spec §6.5 re-derives
 * `lang`/`wiki` on the main side with the same `parseHost`).
 *
 * PRIVACY (spec §14.2): `user` is read **only** to classify `actor`, and is
 * never stored, returned, logged or transmitted. `NormalizedEdit` has no user
 * field. Do not add one.
 */
import {
  IPV4_RE,
  IPV6_RE,
  MAG_LOG_DIV,
  REVERT_PATTERNS,
  TEMP_ACCOUNT_RE,
  TITLE_MAX_CHARS,
  WIKI_PROJECT_HOSTS,
} from "../config";
import type { Actor, EditKind, NormalizedEdit, ProjectId } from "../types";

/** Stats counter incremented on every malformed event (§6.2). */
export interface NormalizeStats {
  parseErrors: number;
}

function bump(stats: NormalizeStats | undefined): void {
  if (stats) stats.parseErrors++;
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * Spec §6.2.6 — revert detection is a **heuristic**: the `recentchange` stream
 * carries no revert flag, so we match the edit summary. Best-effort by nature;
 * a miss scores a revert as an ordinary edit. Patterns live in `config.ts` so
 * they can be tuned from the live probe (see HUMAN-CHECK E3 — measured hit rate
 * is 0.2 %, below the 3 % the synthetic model assumes).
 */
export function isRevert(comment: string | undefined | null): boolean {
  if (typeof comment !== "string" || comment.length === 0) return false;
  for (let i = 0; i < REVERT_PATTERNS.length; i++) {
    if (REVERT_PATTERNS[i]!.test(comment)) return true;
  }
  return false;
}

/**
 * Spec §6.2.7 — host parsing.
 *
 * `en.wikipedia.org` → `{ lang: 'en', project: 'wikipedia' }`
 * `www.wikidata.org` → `{ lang: 'wikidata', project: 'wikidata' }`
 * `commons.wikimedia.org` → `{ lang: 'commons', project: 'commons' }`
 * `meta.wikimedia.org`  → `{ lang: 'meta', project: 'meta' }`
 * anything else → `{ lang: 'other', project: 'other' }`
 */
export function parseHost(serverName: string): { lang: string; project: ProjectId } {
  if (typeof serverName !== "string" || serverName.length === 0) {
    return { lang: "other", project: "other" };
  }
  const host = serverName.toLowerCase().trim();

  // Wikipedia family: <lang>.<project>.org
  const m = /^([a-z0-9-]+)\.([a-z]+)\.org$/.exec(host);
  if (m) {
    const lang = m[1]!;
    const proj = m[2]!;
    for (let i = 0; i < WIKI_PROJECT_HOSTS.length; i++) {
      if (WIKI_PROJECT_HOSTS[i] === proj) {
        return { lang, project: proj as ProjectId };
      }
    }
  }

  if (host === "www.wikidata.org" || host === "wikidata.org") {
    return { lang: "wikidata", project: "wikidata" };
  }
  if (host === "commons.wikimedia.org") {
    return { lang: "commons", project: "commons" };
  }
  if (host === "meta.wikimedia.org") {
    return { lang: "meta", project: "meta" };
  }
  return { lang: "other", project: "other" };
}

/**
 * Rebuild the `wiki` database name from a language code, so the main thread
 * can reconstruct `NormalizedEdit.wiki` from `host` alone (spec §6.5 sends only
 * `host` across the wire).
 *   'en' → 'enwiki', 'commons' → 'commonswiki', 'wikidata' → 'wikidatawiki'.
 */
export function wikiFromLang(lang: string): string {
  if (lang === "other" || lang.length === 0) return "other";
  return `${lang}wiki`;
}

/**
 * Spec §6.2.4 — actor classification.
 *
 * `bot: true` wins outright. Otherwise MediaWiki's logged-out editors are
 * identified by an IPv4 literal, an IPv6-like string (≥ 2 colons), or a
 * temporary account name (`~2025-1-abcde`), which replaced raw IPs for
 * logged-out editors. Everything else is a registered account.
 */
export function classifyActor(user: unknown, bot: unknown): Actor {
  if (bot === true) return "bot";
  if (typeof user !== "string" || user.length === 0) return "registered";

  if (IPV4_RE.test(user)) return "anon";
  if (TEMP_ACCOUNT_RE.test(user)) return "anon";
  // IPv6-like: hex digits and colons, at least two colons (so `dead:beef` and
  // bare hex usernames do not qualify).
  if (user.indexOf(":") >= 0 && IPV6_RE.test(user)) {
    let colons = 0;
    for (let i = 0; i < user.length; i++) if (user[i] === ":") colons++;
    if (colons >= 2) return "anon";
  }
  return "registered";
}

/** Spec §6.2.8 — underscores to spaces, truncated with an ellipsis. */
export function normalizeTitle(raw: string): string {
  const spaced = raw.replace(/_/g, " ");
  if (spaced.length <= TITLE_MAX_CHARS) return spaced;
  return `${spaced.slice(0, TITLE_MAX_CHARS - 1)}…`;
}

/**
 * Spec §6.2.9 — `magnitude = clamp(log2(1 + absDelta) / 14, 0, 1)`.
 * 16 KB ≈ 1.0; 100 B ≈ 0.48; 1 B ≈ 0.07.
 */
export function magnitudeOf(absDelta: number): number {
  if (!Number.isFinite(absDelta) || absDelta <= 0) return 0;
  const m = Math.log2(1 + absDelta) / MAG_LOG_DIV;
  return m < 0 ? 0 : m > 1 ? 1 : m;
}

/**
 * Spec §6.2.10 —
 *   `clamp(0.15 + 0.60·magnitude + 0.35(new) + 0.30(revert) + 0.10(ns 0) − 0.15(bot), 0, 1)`
 */
export function importanceOf(magnitude: number, kind: EditKind, ns: number, actor: Actor): number {
  let imp = 0.15 + 0.6 * magnitude;
  if (kind === "new") imp += 0.35;
  if (kind === "revert") imp += 0.3;
  if (ns === 0) imp += 0.1;
  if (actor === "bot") imp -= 0.15;
  return imp < 0 ? 0 : imp > 1 ? 1 : imp;
}

/**
 * Spec §6.2 — raw `recentchange` object → `NormalizedEdit | null`.
 *
 * **Never throws.** Anything malformed returns `null` and increments
 * `stats.parseErrors`, because a single bad event must not kill the stream.
 *
 * Rules are applied in the spec's order: type gate, required fields, delta,
 * actor, kind, host, title, magnitude, importance, timestamp.
 */
export function normalize(raw: unknown, stats?: NormalizeStats): NormalizedEdit | null {
  if (raw === null || typeof raw !== "object") {
    bump(stats);
    return null;
  }
  const o = raw as Record<string, unknown>;

  // 1. Type gate (spec §6.2.1). `categorize` and `log` are ~62 % of live
  //    traffic, so this is the single biggest reduction step.
  const type = o.type;
  if (type !== "edit" && type !== "new") {
    return null; // not a parse error — an expected, ignored type
  }

  // 2. Required fields (spec §6.2.2).
  if (!isNum(o.id)) {
    bump(stats);
    return null;
  }
  if (!isNonEmptyString(o.title)) {
    bump(stats);
    return null;
  }
  const length = o.length;
  if (length === null || typeof length !== "object") {
    bump(stats);
    return null;
  }
  const lenObj = length as Record<string, unknown>;
  if (!isNum(lenObj.new)) {
    bump(stats);
    return null;
  }
  // `server_name` is the current spelling; `server_url` has also been seen
  // upstream and is what v1 used against live data (see DECISIONS.md, T0.1).
  let server = o.server_name;
  if (!isNonEmptyString(server)) {
    const url = o.server_url;
    if (isNonEmptyString(url)) server = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  }
  if (!isNonEmptyString(server)) {
    bump(stats);
    return null;
  }

  let wiki: string;
  if (isNonEmptyString(o.wiki)) {
    wiki = o.wiki;
  } else {
    // Tolerated: derive from host rather than reject the event.
    wiki = wikiFromLang(parseHost(server).lang);
  }

  // 3. Delta (spec §6.2.3). For `new`, a missing `length.old` is 0.
  const newLen = lenObj.new;
  const oldLen = isNum(lenObj.old) ? lenObj.old : 0;
  const delta = newLen - oldLen;
  const absDelta = Math.abs(delta);

  // 4. Actor (spec §6.2.4). `user` is used here and then dropped — never
  //    stored, logged, or returned (spec §14.2).
  const actor = classifyActor(o.user, o.bot);

  // 5. Kind (spec §6.2.5).
  const kind: EditKind =
    type === "new" ? "new" : isRevert(o.comment as string | undefined) ? "revert" : "edit";

  const ns = isNum(o.namespace) ? o.namespace : 0;
  const minor = o.minor === true;
  const { lang, project } = parseHost(server);
  const magnitude = magnitudeOf(absDelta);

  // 11. Timestamp (spec §6.2.11). Upstream is unix *seconds*.
  let ts: number;
  if (isNum(o.timestamp)) ts = o.timestamp * 1000;
  else ts = Date.now();

  const revision = o.revision;
  let revNew = 0;
  if (revision !== null && typeof revision === "object") {
    const rn = (revision as Record<string, unknown>).new;
    if (isNum(rn)) revNew = rn;
  }

  return {
    id: o.id,
    ts,
    wiki,
    host: server,
    lang,
    project,
    ns,
    title: normalizeTitle(o.title),
    actor,
    kind,
    minor,
    delta,
    absDelta,
    magnitude,
    importance: importanceOf(magnitude, kind, ns, actor),
    revNew,
  };
}
