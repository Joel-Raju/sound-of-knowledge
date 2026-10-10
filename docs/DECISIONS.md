# Decisions Log — Sound of Knowledge v2 Rewrite

Every deviation from the spec is recorded here. Format:

> **YYYY-MM-DD · TASK-ID**
> **Spec said:** …
> **Did:** …
> **Why:** …

---

## ⚠️ RETRACTED ENTRIES

The entry "T0.1 · Environment constraint: no network access to Wikimedia" below
is **retracted**. It was wrong, and the root cause is worth recording because it
will mislead anyone who trusts it.

**What I claimed:** `curl -sI https://stream.wikimedia.org/v2/stream/recentchange`
failed, therefore the build environment has no route to Wikimedia, therefore
fixtures must be hand-written and `EPS_REF` cannot be calibrated.

**What is true:** the network works perfectly. `npx tsx scripts/probe-stream.ts 120`
streams live events at ~37/s with **zero parse errors**, and the endpoint returns
`access-control-allow-origin: *`.

**Root cause:** `curl -I` issues a `HEAD` request. The EventStreams endpoint is a
long-lived SSE stream — it never finishes responding, so `curl` hangs and is
killed by the `-m 10` timeout. A timeout is not a refusal. I read the timeout as
a network failure and generalised it to "no network", which then propagated into
`config.ts`, the fixtures, and the human checklist.

**Lesson:** an error that is consistent with two very different causes
(timeout ≠ refused) must be disambiguated before it is recorded as fact. The
correct probe is a `GET` that is aborted as soon as headers arrive — which is
now what `scripts/probe-stream.ts` does, with a comment saying why.

**Consequence for the build:** none of the fixtures are wrong (they are
hand-written from the §6.1 shape either way, and are labelled as such), but
`EPS_REF` **is** now genuinely calibrated — see T1.1.

---

## 2026-10-10 · T1.1 · Stream reconnaissance — CORS allowed, `EPS_REF = 15`

**Spec said:** §6.1 — verify CORS; §7.3 — `EPS_REF ≈ 1.5 × p95(eps)` measured over
60 s of live Wikipedias-only traffic.

**Measured** (`npx tsx scripts/probe-stream.ts 120`, 120 s window, 1 s buckets):

|                                               | value                               |
| --------------------------------------------- | ----------------------------------- |
| HTTP status                                   | 200                                 |
| `access-control-allow-origin`                 | `*` → **browser-direct ALLOWED**    |
| Raw throughput (all projects)                 | mean 37/s, p95 62/s                 |
| **Wikipedias + `edit\|new` (post-normalize)** | **mean 5.9/s, p95 10/s**            |
| Wikipedias + `edit\|new` + namespace 0        | mean 4.3/s, p95 8/s                 |
| Bot ratio                                     | 18.8 % (spec model: 20 % ✓)         |
| Revert-heuristic hit rate                     | 0.2 % (spec model: 3 % — see below) |
| Parse errors                                  | 0                                   |

**Kind mix:** `categorize` **54.3 %**, `edit` 33.8 %, `log` 7.5 %, `new` 4.5 %.

**Did:**

1. **`EPS_REF = 15`** in `engine/config.ts` (`round(1.5 × 10)`), replacing the
   provisional 60.
2. **No proxy.** §6.6's `app/api/wiki-stream/route.ts` stays deleted, because
   CORS is permissive. This also keeps the first-load JS smaller (§12.1) and
   avoids a serverless hop per event.

### Why the post-normalize rate is the right basis

§7.3 defines `eps` from the worker's `accepted` counter, which counts events
_after_ §6.2.1 drops everything that is not `edit`/`new`. Since `categorize` is
**54 %** of the raw stream, calibrating on raw throughput would set
`EPS_REF ≈ 93` and make the intended 6× overdense texture impossible. The probe
therefore reports all four rates and the config comment records the distinction.

### Resulting energy band

| Traffic | eps   | E    | Mode band (§7.4)             |
| ------- | ----- | ---- | ---------------------------- |
| quiet   | ~2/s  | 0.40 | dorian                       |
| typical | ~6/s  | 0.70 | mixolydian / lydian boundary |
| peak    | ~10/s | 0.86 | lydian                       |

**Known caveat, flagged rather than hidden:** Aeolian requires `E < 0.22`, i.e.
fewer than ~0.7 edits/s. On measured traffic that occurs mainly in overnight
troughs, not in a normal session. So §2.2's "calm → Aeolian/violet" end of the
palette may rarely be heard. The fix, if it turns out to matter, is to _raise_
`EPS_REF` (the provisional 60 would put typical traffic at E ≈ 0.47 and make
Aeolian reachable). I followed the spec's stated formula because `E` is a
_relative_ measure — "busy" should mean busy relative to normal — but this is the
one tuning decision most worth revisiting after a listening pass. Logged as
`HUMAN-CHECK` item **B9**.

### Revert heuristic under-fires

Measured 0.2 % vs the spec's synthetic model of 3 %. Plausible causes: my
`REVERT_PATTERNS` anchor to the start of the comment, but real revert summaries
are frequently prefixed with the editor's own tag (`/* Foo */ Reverted …`), and
English Wikipedia's revert summaries often start with `Rv` via the rollback
tool. Worth revisiting at T2.x when the gong routing can be tested against real
traffic. Not blocking.

---

## 2026-10-10 · T0.1 · ~~Environment constraint: no network access to Wikimedia~~ (RETRACTED — see above)

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

---

## 2026-10-10 · T0.3 · OKLCH gamut epsilon 1e-4 → 1e-3 (bug found by test)

**Spec said:** §9.3 — "clamp to 0..1; if out of gamut reduce C by 5 % steps
until in gamut, max 8 iterations". §13.2 — `OKLCH(0.6280, 0.2577, 29.23°) ≈
linear sRGB (1,0,0) within 0.02`.

**Did:** Raised the in-gamut tolerance from `1e-4` to `1e-3`.

**Why:** The spec's own test vector failed with a tight tolerance. OKLCH(0.628,
0.2577, 29.23) _is_ linear red and converts to `r = 1.00021` — 0.02 % over, pure
float noise. With `1e-4` that counted as "out of gamut", so the function took a
5 % chroma cut and returned `r = 0.957`, failing the spec's own tolerance by 2x.

The deeper issue is that the spec's remedy is **discontinuous**: just inside the
boundary you clamp, just outside you lose 5 % of chroma. Clamping `1.00021` is
imperceptible; desaturating a colour by 5 % is visible as a hue shift. So the
tolerance is deliberately set ~5x above the observed float noise, making us
clamp rather than desaturate at the boundary. Genuinely out-of-gamut colours
(e.g. C = 0.9) still take the reduction path, which a test now asserts
monotonically.

---

## 2026-10-10 · T0.3 · `expApproach` with `tau = 0` now jumps instead of behaving as tau = 1 s

**Spec said:** nothing explicit; §9.1 and §9.10 both pass small taus.

**Did:** `expApproach(..., tau <= 0)` returns `target` immediately.

**Why:** The original `tau || 1` fallback made `tau = 0` silently behave as a
1-second time constant. That is surprising, and it disagreed with the sibling
`smoothingCoefficient`, which already returns `1` (full application) for
`tau <= 0`. Both now mean "no smoothing". The unit test caught this.

---

## 2026-10-10 · T0.3 · `vitest.config.ts` -> `vitest.config.mts`

**Spec said:** §5.3 lists `vitest.config.ts`.

**Did:** Named the file `vitest.config.mts`.

**Why:** The package is CommonJS (`package.json` has no `"type": "module"`), so
Vite's native config loader warned that the ESM syntax in `vitest.config.ts`
"uses features unsupported by `configLoader: 'native'`" and would break on a
future Vite major. `.mts` is unambiguous under both loaders and, unlike adding
`"type": "module"`, does not affect how Next.js and the esbuild worker script
resolve modules. Logged because it is a deliberate departure from the literal
file list in §5.3.

---

## 2026-10-10 · T0.3 · FNV-1a uses `Math.imul`, not shift arithmetic

**Spec said:** §13.2 gives the vectors `fnv1a("") = 0x811c9dc5` and
`fnv1a("a") = 0xe40c292c`.

**Did:** `h = Math.imul(h, FNV_PRIME)` instead of the
`h += (h<<1) + (h<<4) + (h<<7) + (h<<8) + (h<<24)` shift form.

**Why:** Both produce identical results (the shift form is the multiplication
spelled out), but `Math.imul` states the intent — multiply by the FNV prime —
and is a single operation. The constant `FNV_PRIME` was previously declared and
unused, which the lint gate flagged; using it removed the dead code rather than
deleting the constant and leaving a reader to wonder why the prime is missing.

---

## 2026-10-10 · T1.3 · Replay sample is a real capture, not synthetic

**Spec said:** §6.7 — "`scripts/record-stream.ts` records ~3 minutes of live
Wikipedias-only data (needs network) into that format. If recording is
impossible, generate the sample with the synthetic generator."

**Did:** Recorded **180 s of live traffic** → `public/replay/sample.ndjson`
(777 events, 219 KB, 0 parse errors).

**Why:** The network turned out to be available (see the retraction at the top of
this file), so the spec's preferred source is usable. A real capture exercises the
real classifier — the synthetic model only _approximates_ it, and specifically gets
the revert heuristic wrong.

Measured against the spec's synthetic model:

| Metric         | Live                    | Spec model | Verdict                             |
| -------------- | ----------------------- | ---------- | ----------------------------------- |
| Bot ratio      | **19.8 %**              | 20 %       | excellent match                     |
| New-page ratio | 4.4 %                   | 3 %        | fine                                |
| Revert ratio   | **0.8 %**               | 3 %        | **under-fires ~4×** — see below     |
| Pass rate      | 777 / 6649 raw (11.7 %) | —          | matches the 54 % `categorize` share |

**The revert heuristic is the one real finding.** 0.8 % live vs a 3 % model. The
likely cause is that `REVERT_PATTERNS` anchors most patterns to the _start_ of the
comment, but real summaries are frequently prefixed — `/* Foo */ Reverted …` —
and English Wikipedia's rollback tool emits `Rv` rather than a word. Fixing this
is a tuning task, not a structural one, and it needs to wait until the gong
routing exists to be evaluated by ear. Tracked as `HUMAN-CHECK` **E3**.

---

## 2026-10-10 · T1.3 · `gen-synthetic.ts` auto-shortens instead of failing on the 300 KB budget

**Spec said:** §6.7 — the bundled replay must be "small, ≤ 300 KB", ~3 minutes.

**Did:** The script now measures its output and scales the duration down until it
fits, logging the reduction. At the §6.7 synthetic rate (14 events/s) three
minutes is ~2 500 lines × ~265 B ≈ **660 KB**, nearly double the budget — so the
synthetic fallback could never satisfy the spec's own constraints as written.

**Why:** The replay loops forever (§6.7), so a shorter file is functionally
identical — the only cost is less variety before the first loop. Real traffic at
~6 events/s post-normalize fits in 180 s with room to spare, which is why the
bundled file is a real capture. Failing hard would have left the offline harness
with no fallback source at all.

Worth flagging for whoever tunes the spec's numbers: **`REPLAY_TARGET_SEC = 180`
and `REPLAY_MAX_BYTES = 300 KB` are mutually inconsistent with a 14 events/s
synthetic rate.** They are only compatible at the real post-normalize rate.
