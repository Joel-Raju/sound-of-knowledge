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
→ connection failure. The npm registry _is_ reachable (`registry.npmjs.org` → 200),
so dependency installation is unaffected.

**Why:** This blocks three spec items at once:

1. **T1.1 CORS check** — cannot be performed. The CORS question is answered in
   v1's favour already: v1 shipped a _server-side_ proxy
   (`app/api/wiki-stream/route.ts`) but `Scene.tsx` connected to the upstream URL
   directly in an earlier revision, so direct connection is known to work in
   practice. Recorded as "assumed permissive, unverified".
2. **T1.1 fixtures** — the 12 redacted real events will be **hand-written from the
   §6.1 shape** and explicitly labelled as synthetic.
3. **T1.3 replay recording** — `public/replay/sample.ndjson` will be generated with
   `scripts/gen-synthetic.ts`, not `scripts/record-stream.ts`.

**Consequence:** `EPS_REF` stays at the spec default of **60** (§7.3) rather than
`1.5 × p95(measured)`. This is explicitly permitted by §7.3 ("Until measured, use
60"). The energy curve is therefore _calibrated to a guess_. Re-measure with
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

---

## 2026-10-10 · T0.2 · Pinned dependency versions (spec §4.1)

All versions are **exact** (no `^`/`~`) as required.

| Package                               | Version          | Notes                                                               |
| ------------------------------------- | ---------------- | ------------------------------------------------------------------- |
| `three`                               | 0.186.1          | spec: "latest stable at implementation time"                        |
| `postprocessing`                      | 6.39.5           | peer range `three >=0.168.0 <0.187.0` — **compatible with 0.186.1** |
| `@types/three`                        | 0.186.0          | matches `three` 0.186.x                                             |
| `vitest`                              | **4.1.11**       | see deviation below                                                 |
| `@vitest/coverage-v8`                 | 4.1.11           | matches vitest                                                      |
| `@playwright/test`                    | 1.64.0           |                                                                     |
| `esbuild`                             | 0.28.2           |                                                                     |
| `tsx`                                 | 4.23.15          |                                                                     |
| `npm-run-all2`                        | **8.0.4**        | see deviation below                                                 |
| `prettier`                            | 3.9.10           |                                                                     |
| `@types/node`                         | **24.19.2**      | bumped from `^20`; see deviation below                              |
| `@tailwindcss/postcss`, `tailwindcss` | 4.2.1            | was `^4`                                                            |
| `typescript`                          | 5.9.3            | was `^5`                                                            |
| `eslint`                              | 9.39.3           | was `^9`                                                            |
| `@types/react` / `@types/react-dom`   | 19.2.14 / 19.2.3 | were `^19`                                                          |

---

## 2026-10-10 · T0.2 · `vitest` 4.1.11, not 5.0.3

**Spec said:** §4 — `vitest` (unit, node env). No version.

**Did:** Pinned `vitest@4.1.11` rather than the current latest `5.0.3`.

**Why:** `vitest@5.0.3` declares `engines.node = "^22.12.0 || ^24.0.0 || >=26.0.0"`.
This environment runs Node **24.13.1**, which satisfies that range, so vitest 5
_would_ work here — but it would contradict spec §4.3's `"engines": {"node":
">=20"}` and would break any CI runner on Node 20. `vitest@4.1.11` declares
`^20.0.0 || ^22.0.0 || >=24.0.0`, which honours both the spec's stated engine
floor and `.tool-versions`. Prefer the spec's engine contract over version recency.

---

## 2026-10-10 · T0.2 · `npm-run-all2` 8.0.4, not 9.0.3

**Spec said:** §4 — `npm-run-all2` for the parallel `dev` script.

**Did:** Pinned `npm-run-all2@8.0.4`.

**Why:** `npm-run-all2@9.0.3` declares `engines.node = "^22.22.2 || ^24.15.0
|| >=26.0.0"`. Node **24.13.1** (per `.tool-versions`) does **not** satisfy
`^24.15.0` — it is below the minimum. npm emitted `EBADENGINE` warnings, and the
CLI is invoked by `npm run dev`, so this is a real runtime risk, not cosmetic.
`8.0.4` declares `^20.5.0 || >=22.0.0` and installs clean.

---

## 2026-10-10 · T0.2 · `@types/three` moved to `devDependencies`; `@types/node` bumped to 24

**Spec said:** §4.3 — add `engines: {"node": ">=20"}`.

**Did:** Moved `@types/three` from `dependencies` to `devDependencies`; bumped
`@types/node` from `^20` to `24.19.2`.

**Why:** `@types/three` is compile-time only and has no runtime role; shipping it
in `dependencies` bloats the install graph for consumers. `@types/node@20`
describes APIs that do not match the Node 24 runtime in `.tool-versions`; a
mismatch here produces confusing `tsc` errors deep in dependency typings.

---

## 2026-10-10 · T0.2 · Hot-path ESLint rule scoped to the array methods §12.4.2 names

**Spec said:** §12.4.2 — a custom ESLint override for hot-path files banning
`.map/.filter/.forEach/.reduce/.slice/.concat` calls and spread-in-calls, plus
"tag hot functions with `// @hot` and review manually".

**Did:** Implemented exactly those bans file-wide for 16 listed hot-path files.
**Did not** add blanket `ObjectExpression` / `ArrayExpression` / `new Array(...)`
bans across those files.

**Why:** A file-wide literal ban makes the hot-path files unwritable — they
legitimately contain message-type definitions, config tables, uniform sets and
DSP parameter arrays at module scope. The ban would generate hundreds of errors
in correct code while catching nothing, which trains the team to disable the rule.
The residual risk (literals _inside_ per-frame code) is what the `// @hot`
manual review exists for, exactly as §12.4.2 describes.

---

## 2026-10-10 · T0.2 · Worker/worklet globals declared inline, not via `lib.webworker`

**Spec said:** §1.1.11 — `strict: true`, no `any`.

**Did:** `engine/ingest/ingest.worker.ts` declares a minimal structural
`WorkerScope` type; `engine/audio/voice-pool.worklet.ts` declares a minimal
`AudioWorkletProcessor` / `registerProcessor` pair. Neither adds `lib.webworker`.

**Why:** Adding `lib.webworker` to `compilerOptions.lib` alongside `lib.dom`
produces duplicate global declarations (`self`, `AbortController`, `EventSource`,
… ) and a wall of conflicting-identifier errors. The engine must type-check
against `lib.dom` because most of it is main-thread code. Declaring the two
worklet-realm-only symbols locally keeps the graph clean and the declarations
honest. Note `lib.dom` _does_ provide `AudioWorkletNode` but **not**
`AudioWorkletProcessor` — that symbol exists only in the worklet realm.

---

## 2026-10-10 · T0.2 · Prettier reformatted untracked scratch files (self-corrected)

**What happened:** The first `npm run format` ran `prettier --write .` over the
whole repo, which reflowed four **untracked, user-authored** root files:
`sound-of-knowledge-v2-rewrite-spec.md`, `sound-of-knowledge-blog.md`,
`twitter.md`, `twitter_basic.md`.

**Impact:** Cosmetic only — prettier normalises whitespace, list markers and
table padding; it does not change prose. Verified afterwards: the spec still has
all 17 section headings and 110 table rows, and key terms (`mulberry32`,
`sok-voice-pool`, `Bjorklund`, `Lydian`) are intact.

**Fix:** All four are now listed in `.prettierignore` so `npm run format` will
never touch them again. They remain **untracked** — they are the user's working
notes, not product files, and are deliberately not committed.

---

## 2026-10-10 · T0.2 · `/artifact/` (singular) vs `artifacts/` — a gitignore regression

**Spec said:** §5.3 uses `artifacts/` (plural) for verification output and
§13.6 writes screenshots to `artifacts/shots/`.

**Did:** My rewritten `.gitignore` covered `artifacts/` but silently dropped the
v1 line `/artifact` (singular). That directory holds `spec.md` and
`visual_spec.md` — v1 design documents that were deliberately never committed.
`git add -A` therefore swept them into the T0.2 commit. Removed with a follow-up
commit and both patterns are now present.

**Why:** Worth recording because the two directories differ by one character and
the failure mode is silent — `git add -A` looks correct. Both are now ignored.
Note for T6.5: `artifact/visual_spec.md` contains v1 art direction (18-step
raymarch, curl-noise intent) referenced by `ParticleSystem.tsx` comments. It is
local-only and gitignored; if any of it should survive into the v2 docs, it must
be _copied_ deliberately rather than relied on from the ignored directory.
