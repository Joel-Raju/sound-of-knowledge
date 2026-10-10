/**
 * Batch wire format between the ingest worker and the main thread. Spec §6.5.
 *
 * The batch is a `Float64Array` of `n * STRIDE` values, **transferred** (not
 * copied) so the zero-copy path keeps the worker cheap. Strings travel as
 * parallel arrays; `lang` and `wiki` are not sent at all and are re-derived on
 * the main side from `host` using the same `parseHost` the worker used, which
 * guarantees both sides agree.
 *
 * ⚠️ The field order below is a protocol. Changing it requires changing both
 * sides together. `STRIDE` lives in `config.ts`.
 */
import { PROJECTS, STRIDE } from "../config";
import { parseHost, wikiFromLang } from "./normalize";
import type { Actor, EditKind, NormalizedEdit, ProjectId } from "../types";

// ─── Field offsets (spec §6.5) ───────────────────────────────────────────────
export const F_ID = 0;
export const F_TS = 1;
export const F_NS = 2;
export const F_KIND = 3; // 0 edit, 1 new, 2 revert
export const F_ACTOR = 4; // 0 registered, 1 anon, 2 bot
export const F_MINOR = 5; // 0/1
export const F_DELTA = 6;
export const F_MAGNITUDE = 7;
export const F_IMPORTANCE = 8;
export const F_PROJECT = 9; // index into PROJECTS
export const F_REVNEW = 10;

export { STRIDE };

const KIND_TO_CODE: Record<EditKind, number> = { edit: 0, new: 1, revert: 2 };
const ACTOR_TO_CODE: Record<Actor, number> = { registered: 0, anon: 1, bot: 2 };
const CODE_TO_KIND: EditKind[] = ["edit", "new", "revert"];
const CODE_TO_ACTOR: Actor[] = ["registered", "anon", "bot"];

/** Reverse index for `PROJECTS`; codes are part of the wire protocol. */
const PROJECT_TO_CODE = new Map<ProjectId, number>(PROJECTS.map((p, i) => [p, i]));

export interface BatchMsg {
  t: "batch";
  n: number;
  num: Float64Array;
  titles: string[];
  hosts: string[];
}

/**
 * Encode `n` edits into a transferable batch.
 *
 * Allocation here is one `Float64Array` plus two string arrays **per batch**
 * (≤ 20/s), not per event — the event objects themselves are reused by the
 * caller, which is what keeps this off the §1.2 hot-path concern.
 */
export function encodeBatch(edits: readonly NormalizedEdit[]): BatchMsg {
  const n = edits.length;
  const num = new Float64Array(n * STRIDE);
  const titles: string[] = [];
  const hosts: string[] = [];

  for (let i = 0; i < n; i++) {
    const e = edits[i];
    if (e === undefined) continue;
    const o = i * STRIDE;
    num[o + F_ID] = e.id;
    num[o + F_TS] = e.ts;
    num[o + F_NS] = e.ns;
    num[o + F_KIND] = KIND_TO_CODE[e.kind];
    num[o + F_ACTOR] = ACTOR_TO_CODE[e.actor];
    num[o + F_MINOR] = e.minor ? 1 : 0;
    num[o + F_DELTA] = e.delta;
    num[o + F_MAGNITUDE] = e.magnitude;
    num[o + F_IMPORTANCE] = e.importance;
    num[o + F_PROJECT] = PROJECT_TO_CODE.get(e.project) ?? PROJECTS.length - 1;
    num[o + F_REVNEW] = e.revNew;
    titles.push(e.title);
    hosts.push(e.host);
  }

  return { t: "batch", n, num, titles, hosts };
}

/**
 * Decode a batch back into `NormalizedEdit` objects.
 *
 * This *does* allocate — one object per event, ≤ ~100/s. Spec §1.2 explicitly
 * permits this ("Per-event allocation of one `NormalizedEdit` object on the
 * main thread (≤ ~100/s) is allowed"); it is the boundary between the wire
 * format and the engine.
 */
export function decodeBatch(msg: BatchMsg): NormalizedEdit[] {
  const out: NormalizedEdit[] = [];
  const n = msg.n;
  const { num, titles, hosts } = msg;

  for (let i = 0; i < n; i++) {
    const o = i * STRIDE;
    const host = hosts[i] ?? "";
    const { lang, project } = parseHost(host);
    const kindCode = num[o + F_KIND] ?? 0;
    const actorCode = num[o + F_ACTOR] ?? 0;
    const projCode = num[o + F_PROJECT] ?? PROJECTS.length - 1;
    const delta = num[o + F_DELTA] ?? 0;

    out.push({
      id: num[o + F_ID] ?? 0,
      ts: num[o + F_TS] ?? 0,
      wiki: wikiFromLang(lang),
      host,
      lang,
      project: PROJECTS[projCode] ?? project,
      ns: num[o + F_NS] ?? 0,
      title: titles[i] ?? "",
      actor: CODE_TO_ACTOR[actorCode] ?? "registered",
      kind: CODE_TO_KIND[kindCode] ?? "edit",
      minor: (num[o + F_MINOR] ?? 0) === 1,
      delta,
      absDelta: Math.abs(delta),
      magnitude: num[o + F_MAGNITUDE] ?? 0,
      importance: num[o + F_IMPORTANCE] ?? 0,
      revNew: num[o + F_REVNEW] ?? 0,
    });
  }

  return out;
}
