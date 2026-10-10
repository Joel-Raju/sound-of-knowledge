/**
 * User-controlled source filters and event dedupe. Spec §6.3.
 *
 * Pure functions plus a fixed-capacity dedupe ring. No DOM, no worker globals.
 */
import type { NormalizedEdit } from "../types";

export interface FilterConfig {
  source: "wikipedias" | "no-wikidata" | "all";
  /** empty array = all languages */
  langs: string[];
  namespaces: "main" | "all";
}

export const DEFAULT_FILTERS: FilterConfig = {
  source: "wikipedias",
  langs: [],
  namespaces: "main",
};

/**
 * Spec §6.3 — `passes(edit, cfg)`.
 *
 * The `source` axis and the `langs` axis are independent by design: choosing
 * `wikipedias` restricts to the Wikipedia family, and `langs` then narrows
 * within it. With `langs` empty the axis is a no-op.
 */
export function passes(edit: NormalizedEdit, cfg: FilterConfig): boolean {
  // Source axis (spec §6.3).
  if (cfg.source === "wikipedias" && edit.project !== "wikipedia") return false;
  if (cfg.source === "no-wikidata" && edit.lang === "wikidata") return false;

  // Language axis.
  if (cfg.langs.length > 0) {
    let found = false;
    for (let i = 0; i < cfg.langs.length; i++) {
      if (cfg.langs[i] === edit.lang) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }

  // Namespace axis: 'main' is MediaWiki namespace 0, i.e. articles.
  if (cfg.namespaces === "main" && edit.ns !== 0) return false;

  return true;
}

/**
 * Spec §6.3 — dedupe ring of the last `DEDUPE_CAPACITY` (2000) event ids.
 *
 * A reconnect that resumes with `Last-Event-ID` can redeliver events we have
 * already played, and a duplicate would be heard twice and counted twice.
 * Re-exported from `util/ring-buffer`; the worker owns the instance.
 */
export { IdDedupeRing as DedupeRing } from "../util/ring-buffer";
export { DEDUPE_CAPACITY } from "../config";
