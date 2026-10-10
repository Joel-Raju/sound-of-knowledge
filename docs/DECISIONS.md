# Decisions Log — Sound of Knowledge v2 Rewrite

Every deviation from the spec is recorded here. Format:

> **YYYY-MM-DD · TASK-ID**
> **Spec said:** …
> **Did:** …
> **Why:** …

---

## 2026-10-10 · T0.1 · Environment constraint: no network access to Wikimedia

**Spec said:** §6.1 — the browser connects directly to
`https://stream.wikimedia.org/v2/stream/recentchange`; task T1.1 must verify CORS
with `curl -sI` and task T1.3 may record a live stream.

**Did:** The build/test environment has **no network route to Wikimedia**.
Verified with `curl -sI -m 10 https://stream.wikimedia.org/v2/stream/recentchange`
→ connection failure. The npm registry *is* reachable (`registry.npmjs.org` → 200),
so dependency installation is unaffected.

**Why:** This blocks three spec items at once:
1. **T1.1 CORS check** — cannot be performed. The CORS question is answered in
   v1's favour already: v1 shipped a *server-side* proxy
   (`app/api/wiki-stream/route.ts`) but `Scene.tsx` connected to the upstream URL
   directly in an earlier revision, so direct connection is known to work in
   practice. Recorded as "assumed permissive, unverified".
2. **T1.1 fixtures** — the 12 redacted real events will be **hand-written from the
   §6.1 shape** and explicitly labelled as synthetic.
3. **T1.3 replay recording** — `public/replay/sample.ndjson` will be generated with
   `scripts/gen-synthetic.ts`, not `scripts/record-stream.ts`.

**Consequence:** `EPS_REF` stays at the spec default of **60** (§7.3) rather than
`1.5 × p95(measured)`. This is explicitly permitted by §7.3 ("Until measured, use
60"). The energy curve is therefore *calibrated to a guess*. Re-measure with
`npx tsx scripts/probe-stream.ts` from a networked machine before release; the
constant is a single named value in `engine/config.ts`.

---

## 2026-10-10 · T0.1 · Branch naming: `v2-rewrite`, not `v2`

**Spec said:** §15 T0.1 — `git checkout -b v2-rewrite`.

**Did:** Created `v2-rewrite` from `master` (`8bb5a1d`). A separate `v2` branch
also exists at the same commit, plus tag `backup/v2-pre-nuke` from an earlier
branch deletion in the same session.

**Why:** The spec names `v2-rewrite` explicitly; the pre-existing `v2` branch was
created moments earlier by the user and is left untouched so the rewrite is not
confused with it.

---

## 2026-10-10 · T0.1 · `server_name` vs `server_url`

**Spec said:** §6.1/§6.2.7 — the host field is `server_name`.

**Did:** The normaliser will read `server_name` first and fall back to `server_url`
(v1 used `server_url` against live data and it worked).

**Why:** Upstream has carried both spellings across schema revisions; v1's
working code used `server_url`. Accepting either is strictly more robust and
costs one property read. Recorded here so the fallback is not mistaken for a
spec violation.

---

## 2026-10-10 · T0.1 · Stale generated types in `dist/` break the build after deleting a route

**Spec said:** nothing — incidental.

**Symptom:** after `git rm -r app/api`, `npm run build` failed with
`Cannot find module '../../../app/api/wiki-stream/route.js'` from
`dist/dev/types/validator.ts`.

**Did:** `rm -rf dist .next` before rebuilding. Add `dist/` to the ESLint
`globalIgnores` and make sure `dist/` stays gitignored (it already is).

**Why:** Next.js 16's TypeScript validator emits route-type assertions into
`dist/`, and the inherited `tsconfig.json` `include` list contains
`dist/types/**/*.ts` and `dist/dev/types/**/*.ts`. Deleting a route does not
invalidate the cached validator, so the build typechecks a reference to a file
that no longer exists. `rm -rf dist .next` is the fix. This will recur whenever
a route is added or removed during the rewrite (notably T1.5, which may
reintroduce `app/api/wiki-stream/route.ts`).