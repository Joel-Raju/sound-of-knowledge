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

---

## 2026-10-10 · T1.5 · One-shot worker builds are always production (bundle budget bug)

**Spec said:** §5.4 — "minified in production, sourcemaps in dev"; §12.1 — the
worker bundle must stay under 40 KB gzip.

**Did:** `scripts/build-workers.mjs` now derives `dev` from `--watch` alone,
instead of `watch || NODE_ENV !== "production"`.

**Why:** Running `npm run build:workers` with `NODE_ENV` unset produced an
**inlined-sourcemap** bundle of **65 KB gzip — 163 % of budget** — purely because
of an ambient variable. Production output is **7.9 KB (20 % of budget)**; the
other 57 KB was the sourcemap.

The budget reporter in the build script is what caught it, which is the argument
for having that check in the first place rather than only in CI. But keying a
build artefact off an ambient env var is the wrong contract: `npm run build`
would produce a different worker bundle depending on how the operator's shell
happened to be configured, with no error. `--watch` is the dev workflow, so it is
now the only thing that produces dev output.

---

## 2026-10-10 · T2.2 · Bjorklund must use the a/b-list formulation

**Spec said:** §7.8 "Euclid: standard Bjorklund"; §13.2 asserts exact patterns
`(3,8) = x..x..x.`, `(5,8) = x.xx.xx.`, `(4,16) = x...x...x...x...`, and that
`euclid(7,16)` has "gaps differ by ≤ 1".

**Did:** Implemented Toussaint's a/b-list formulation — `a` starts as the k
onsets, `b` as the n−k rests, each round merges `a[i]` with `b[i]` and moves
the longer list's tail into `b`.

**Why:** This is worth recording because the _obvious_ implementation is wrong
and silently so. Collapsing `a` and `b` into one list and pairing front-to-back
produces patterns that are rotations of the correct rhythm at best, and
**unevenly distributed** at worst. Concretely, the front-to-back version yields
gaps of `{4,2,2,2,2,2,2}` for `euclid(7,16)` where the a/b version yields
`{3,2,2,2,3,2,2}`. The first violates the spec's own "gaps differ by ≤ 1"
requirement, and audibly it makes the bot groove lurch instead of roll — the
single thing §7.8 asks of it.

The unit tests caught this: the naive version produced `xxx.....` for
`euclid(3,8)` and failed three of the four spec references. All four references
are now asserted and pass exactly as written, so no spec deviation was needed.

---

## 2026-10-10 · T3.1 · Voices apply their own gain

**Spec said:** §8.6 lists a gain per voice ("Bell (FM) ... gain 0.30"); §13.2
asserts "peak bound (≤ 1.0 × gain × vel × 1.1)".

**Did:** Each voice multiplies `vel` by its `VOICE_GAIN` in `onStart`.

**Why:** The peak bound only holds if the gain is part of the voice's output.
Leaving it to the caller meant the worklet had to know a per-voice gain, and
the rendered signal was up to 3× over the bound. Applying it in `onStart` makes
`VOICE_GAIN` an actual peak-level control, which is what the §8.4 mix targets
depend on.

---

## 2026-10-10 · T3.1 · Pluck and gong normalise their partial amplitudes

**Spec said:** §8.6 gives pluck `amp = [1.0, 0.45, 0.20]` and gong
`amps = [1.0, 0.60, 0.55, 0.35, 0.30, 0.20, 0.12]`; §13.2 asserts peak ≤ gain × vel.

**Did:** Divide each voice's amplitudes by their sum (1.65 and 3.12 respectively).
The ratios between partials are untouched.

**Why:** The spec gives _relative_ amplitudes, so the un-normalised pluck peaks at
1.65 before gain and the gong at 3.12 — measured 0.32 against a 0.27 bound, and
0.21 against 0.09. Beyond failing the bound, it would make `VOICE_GAIN.pluck`
a fiction and leave §8.4's mix targets untunable, since pluck would sit ~2× above
where its gain says. Normalising keeps everything §8.6 actually specifies (the
partial ratios) and makes the stated gain mean what it says. The gong's strike
transient is scaled by the same factor so its relative level is preserved.

---

## 2026-10-10 · T3.1 · Exponential decay is computed incrementally, not per sample

**Spec said:** §12.1 — "16 simultaneous voices render ≥ 10× faster than real time".

**Did:** Bell, pluck, sub and gong now hold a per-partial decay multiplier
(`exp(-dt/τ)`, precomputed in `onStart`) and multiply it each sample, instead of
calling `exp(-t/τ)` per partial per sample.

**Why:** `exp(-t/τ)` at a fixed `dt` is exactly `pow(exp(-dt/τ), n)`, so the
recurrence is mathematically identical while replacing a transcendental call
with a multiply. The first `scripts/bench.ts` run came in at **9.6× real time**,
i.e. missing the budget, and this took it to a stable **~11×**. The gong gains
most: it carries 7 partials, so that is 7 `exp()` per sample removed.

Accumulated float drift over a 9-second note is far below audibility, and each
envelope is forced to zero below 1e-7 to avoid denormal slowdowns (a classic
cause of mysterious audio-thread CPU spikes).

---

## 2026-10-10 · T3.1 · Two §13.2 assertions are not satisfiable as written

**Spec said:** §13.2 — every voice must "decay (RMS in the last 10 % ≤ 5 % of the
first 10 %)" and have "no click at start/end (first/last 1 ms abs < 0.05)".

**Did:**

- **Gong decay**: asserted at ≤ 25 % rather than 5 %. The spec's own gong
  parameters (τ₀ = 4.5 s over dur = 9.0 s) give exactly two time constants, so
  the tail is `exp(-2) ≈ 13 %`; measured 16 %. A gong that had decayed to 5 % by
  9 s would not ring, and §2.2 explicitly wants reverts to land as a "deep
  metallic gong". Every other voice meets the 5 % bound.
- **Click**: the bound is derived from the fade rather than fixed —
  `gain × vel ÷ 3 × 1.15`. Spec §8.6 specifies a **3 ms** linear fade-in, so at
  t = 1 ms the envelope is only one third open and a full-scale carrier already
  reaches `gain × vel / 3`. The literal 0.05 is not achievable alongside the
  specified fade; measured peaks were 0.050–0.063.

**Why:** Both are internal inconsistencies in the spec rather than choices, and
in both cases the specified _sound_ is clearly intended (a gong that rings, a
voice with no click). Silently loosening the numbers would hide the conflict, so
it is recorded here and the bounds are computed from first principles so a future
config change cannot quietly invalidate them.

---

## 2026-10-10 · T3.1 · The bell has no measurable "fundamental" — do not assert one

**Spec said:** §13.2 — "expected fundamental via zero-crossing/FFT for bell,
pluck and sub", within 2 %.

**Did:** No absolute pitch assertion for the bell. Pitch is asserted at the
_parameter_ level (`note.freq === 440·2^((midi-69)/12)`) and the audible result is
a `HUMAN-CHECK` item. Pluck and sub keep the 2 % assertion.

**Why:** Three measurement approaches were tried and all three failed for reasons
that are properties of the _spec's own bell design_, not of the implementation:

1. **FFT peak-picking** — lands on an FM sideband, not the carrier.
2. **Autocorrelation** — the ratio of 3.99 is deliberately _not_ 4.0, so the
   modulator phase drifts against the carrier and the waveform is only
   quasi-periodic. There is no clean period to lock onto.
3. **Carrier energy** — measured at **3e-7** of the band peak. The carrier sits
   at a Bessel null at the modulation index this voice uses (I₀ ≈ 3.2), so
   asserting the carrier is present asserts something _false_.
4. **Spectral centroid** — does not scale linearly with pitch, because the
   partial balance shifts with pitch (τ_A shortens as pitch rises). Measured
   octave ratios ranged 1.0–1.3.

Asserting any of these would have meant weakening the number until it passed,
which would hide a real property of the instrument. Worth noting for whoever
tunes this: if a strict bell pitch check is wanted, the lever is a _rational_
FM ratio (4.0) — which would change the timbre the spec explicitly specifies.

**Also worth recording:** several apparent "DSP pitch failures" during this task
were a bug in the _test helper_, not the DSP. `mkNote()` computed `freq` from the
default `midi` and then spread `over` on top, so `render(voice, sr, {midi: 64})`
changed the MIDI note without changing the frequency — every "different pitch"
render was in fact the same note. Resolving `midi` before deriving `freq` fixed a
whole class of phantom failures.

## 2026-10-10 · T3.3 · A bug no test could see: `mixBus` was a dangling node

**Spec said:** §8.3 — the mix chain `voiceBus → (dry + reverb + delay) → mixBus →
compressor → softclip → master`, with the pad, drone and air also feeding
`mixBus`.

**Did:** Fixed the construction order in `AudioEngine.init`, and added
`tests/helpers/fake-audio-context.ts` plus `tests/unit/audio-graph.test.ts` so
this class of failure is caught automatically.

**The bug:** T3.2 wired the master chain first, creating its own `voiceBus` and
`mixBus`. T3.3 then called `buildFxChain()` and _reassigned_ `this.mixBus` to the
FX chain's bus — but the compressor had already been connected to the old one.
Every bus the continuous layers use (pad, drone, air, reverb return, both delay
taps) terminated at a node with no outgoing edges. **The pad, drone and air were
completely inaudible.**

**Why it survived:** the failure is silent in the worst way — the worklet booted,
the e2e smoke tests passed, `AudioEngine.init()` resolved, and the console was
clean. The existing e2e test built its _own_ graph by hand rather than using
`AudioEngine`, so it exercised a correct topology that the product never ran.
Nothing in the suite was capable of expressing "every bus reaches the speakers".

**The fix:** build the FX chain _before_ the master chain, so `mixBus` exists
once and everything connects to the same node. The comment in `init()` now says
why the order matters.

**The guard:** `fake-audio-context.ts` records `connect` edges (no DSP, no
browser) and the graph test walks reachability. Verified by re-introducing the
original ordering: 3 tests fail, including `connects the FX mix bus to the
compressor (the T3.3 regression)`.

Worth flagging as a general lesson for the remaining tasks: **in this codebase an
e2e test that builds its own graph by hand is a test of a different program than
the one that ships.** From T3.5 on, browser tests should drive the real
`AudioEngine` via `window.__sok`, not a hand-rolled approximation.

## 2026-10-10 · T3.4 · Flux decay state is per-`Analyzer`, not module-global

**Spec said:** §8.10 — spectral flux with τ = 0.12 s decay.

**Did:** `flux`/`decay` take an explicit `{ v: number }` state object; `Analyzer`
holds its own. The exported default is a shared singleton only for pure-function
tests.

**Why:** the first implementation used a module-level `fluxState`. That is correct
only while exactly one `Analyzer` exists — which is true in the browser but not
once T3.5 adds an `OfflineAudioContext` render. Two analysers in one process
would have bled decay state into each other, and because the effect is a subtle
smoothing difference rather than a crash, it would have been very hard to trace
back to its cause. This is the same failure shape as the T3.3 bug: silent,
plausible-looking numbers, wrong system.

## 2026-10-10 · T3.4 · `bandLevels` measures the band _mean_, so test fixtures must be flat

**Spec said:** §8.10 — `level = clamp((meanDb(band) + 80) / 60, 0, 1)`.

**Did:** documented on the helper that synthetic tone fixtures must fill the
band **flat**, not with a raised cosine.

**Why:** two tests failed on first run and both were the fixture's fault, not
the implementation's:

1. A raised-cosine peak made the band mean sit well below the peak (measured
   0.73 for a 0 dB tone), so "a full-scale tone approaches 1" was asserting the
   wrong quantity. `bandLevels` is specified as a mean; a cosine measures the
   peak instead.
2. A "quiet" frame filled with −80 dB sat _above_ `toneIn`'s −100 dB floor, so
   the floor itself became a rising edge and the "ignores falling edges" test
   measured the floor rather than the band.

Worth keeping in mind for T4.x: a band _mean_ in dB is dominated by the quietest
bins, so a band with one loud partial and many silent ones reads much lower than
its peak suggests. That is the spec's intent (it tracks perceived band energy),
but it is not a peak meter, and visual coupling tuned against peaks will look
wrong.

---

# T3.5 — offline render harness and mix tuning

## 2026-10-10 · T3.5 · The offline harness must render the _real_ engine, not a copy

**Spec said:** §13.3 — create an `OfflineAudioContext`, build `AudioEngine` on it,
drive the scheduler with a virtual clock, sync, render.

**Did:** exactly that, and deliberately did _not_ factor the graph-building into
anything an e2e test could call separately.

**Why:** the T3.3 bug was invisible precisely because the e2e test built its own
approximation of the graph. A harness that assembles a "representative" chain
would have reported a passing mix for a broken engine. The only version of this
harness that is worth having renders the code that ships.

## 2026-10-10 · T3.5 · `AudioEngine` takes an injected clock — `ctx.currentTime` is useless offline

**Spec said:** (§13.3 implied) schedule everything up-front, then render.

**Did:** added `AudioEngineOptions.now?: () => number`, defaulting to
`ctx.currentTime`. The offline harness injects the scheduler's virtual clock.

**The bug:** during the scheduling pass of an `OfflineAudioContext`,
`ctx.currentTime` is **0 for the entire pass**. So:

- `PadLayer.setEnergy` is rate-limited to 1 Hz, so it fired **exactly once**, at
  t = 0, with the energy from the very first tick.
- The pad's cutoff and the air gain therefore never responded to energy at all.
- The master fade and the drone glide had the same problem.

The render still _looked_ fine — it produced sound, and every band target was in
range — which is why this survived several tuning iterations before the
non-monotonic band results across E 0.3 / 0.6 / 0.9 gave it away. All three
energy cases were silently rendering the **same** frozen automation.

This is the same failure shape as T3.3 twice over: silent, plausible, wrong.
The general rule it taught me: **anything the engine schedules "now" must read
an injected clock**, because in the offline path "now" is a lie.

## 2026-10-10 · T3.5 · §8.8's air level cannot satisfy §8.4's high-band target

**Spec said:** §8.8 — air gain `lerp(0.004, 0.020, E)`. §8.4 — 2–8 kHz must be
5–25 % of the mix's power.

**Did:** `AIR_GAIN_MIN/MAX` → `0.30 / 0.55` (≈ +35 dB), and flattened the energy
curve from a 5× ratio to 1.8×.

**Why the spec's own numbers cannot both hold.** Measured with
`scripts/probe-bands.ts`, which renders the mix with layers isolated:

| Layer   | sub   | bass  | mid    | high  |
| ------- | ----- | ----- | ------ | ----- |
| notes   | 0.0 % | 0.0 % | 97.5 % | 2.0 % |
| pad+air | 22 %  | 41 %  | 31 %   | 8.8 % |

Plucks span midi 64–88 (329–1308 Hz) and bells start at midi 76 (659 Hz), so the
melody is _entirely_ mid-band by construction. The pad is lowpassed at
`500 + 2800·E` ≈ 2.2 kHz; raising that ceiling to 5 kHz moved the high band by
**0.3 points**, because a sawtooth's 20th partial at that cutoff is ≈ −26 dB.
There is simply nothing above 2 kHz to reveal.

So the air layer is the _only_ source of 2–8 kHz — which is what §8.8 intends,
but at its stated level it contributed 0.01 of the mix's power. Reaching 5 %
required ≈ 20× its gain. In absolute terms the final air path sits ≈ 25 dB below
the mix.

The flatter curve is a second finding: at §8.8's 5× ratio the **E 0.9** render put
**30 %** of the mix above 2 kHz, which is not an "air" layer any more.

## 2026-10-10 · T3.5 · §7.7's sub limits leave the notes with zero bass

**Spec said:** `SUB_MAX_PER_BAR = 2`, `SUB_MAX_CONCURRENT = 3`.

**Did:** 3 and 5.

**Why:** at the spec values the notes carried **0.0 %** of both the sub and bass
bands. §8.4 then demanded 8–30 % sub and 10–30 % bass, which could then only be
met by the accompaniment — requiring a pad roughly 3× louder in power than the
melody. That inverts the hierarchy the entire app is built on (§2.2: edits must
read as audible events).

Letting the `sub` voice carry real low frequency is cheaper _and_ more musical:
it is what a "large edit" should sound like. With 3 per bar, note energy gains a
sub component that brings the full mix to 24–29 % sub without touching the pad.

## 2026-10-10 · T3.5 · `dur = 5τ` holds a voice slot for an inaudible tail

**Spec said:** §8.6 — bell and pluck `dur = 5τ`.

**Did:** `MELODIC_DUR_TAU = 3.5`.

**Why:** at `5τ` the envelope residual is `e⁻⁵` = 0.7 % (−43 dBFS), but the voice
slot stayed reserved for the whole duration. Silent tails were blocking live
voices, and the E 0.9 drop rate sat at 42.7 % against §8.4's 35 % ceiling.
`3.5τ` leaves the tail at 3 % — below the continuous pad, so inaudible as a cut —
and brought the drop rate to 31.3 %.

Deliberately **not** used: growing the pool above 16. §8.5 fixes 16/12/8, and the
DSP bench measures 16 concurrent voices at 10.8× real-time; 24 voices would put
that at ~7× and fail the §12 budget. The pool is the constraint, not a knob.

## 2026-10-10 · T3.5 · §8.4's "synthetic rate ×3" contradicts §13.3's `rateMul` formula

**Spec said:** §8.4 "Stress at E ≈ 0.9 (**synthetic rate ×3**)"; §13.3 "rateMul
chosen from `eps = (1 + EPS_REF)^E − 1`".

These disagree. With `EPS_REF = 15`, §13.3's formula gives `rateMul = 0.795` for
E = 0.9; "×3" would give `rateMul = 3.0`, which is `ε = 42` and therefore
**E = 1.36 — off the end of the scale**.

**Did:** used §13.3's formula, because it is explicit, derives from the
calibrated `EPS_REF`, and is the one the script actually specifies.

Worth noting that the literal "×3" reading makes §8.4 _harder_, not easier: at
4× the note rate the drop ratio would be far above 42.7 %, not below it.

## 2026-10-10 · T3.5 · `checkMixTargets` now applies to every energy, not just E 0.6

**Spec said:** §8.4 states the loudness/crest/band targets "for a 120 s synthetic
render at steady E ≈ 0.6", with a separate stress clause for E ≈ 0.9.

**Did:** the first version exempted E 0.9 from the band checks entirely, reading
that as the spec's intent. **That was wrong and it hid a real defect:** E 0.9 was
running at **30 % high-band** (target ≤ 25 %) and the report said `✓ E90`.

The full check now runs at all three energies. A mix whose spectrum only holds at
one density is not a mix.

## 2026-10-10 · T3.5 · FFT bin resolution limits what `share.sub` can mean

Not a deviation, but a property worth knowing before tuning against it: §13.3
fixes an 8192-point FFT, which at 48 kHz gives 5.86 Hz bins with a Hann main
lobe ~2 bins wide. A 10 Hz tone is therefore **indistinguishable from the 20 Hz
band edge** and is reported as `sub`. Band shares are also normalised by _in-band_
power, so they always sum to 1 and cannot be used to measure how much energy
fell outside the bands.

The consequence for anyone re-tuning: `share.sub` is a "20 Hz–80 Hz" measure only
for content well above 20 Hz. Tests for this are in
`tests/unit/mix-analysis.test.ts` (`resolves the band edges no finer than the FFT
bin width`).

## 2026-10-10 · T3.5 (fix) · "Air layer plays as strong hiss" — the numbers were green, the ears were not

**Human feedback:** checklist item **D5**, filed against the previous tune.

**Did:** air band moved 2.5 kHz → **5 kHz** (highpass 400 → 2500 Hz, Q 0.7 →
1.4) and the gain came down from `0.30/0.55` to `0.075/0.15` — about **12 dB
quieter** overall. Re-tuned the rest of the mix around it.

**The lesson, which is the point of recording it.** §8.4 states its band-share
targets as things to "tune until all of these hold". That phrasing invites
optimising the number, and I did: air was raised ~20× because it is the only
source of 2–8 kHz energy in the synthesis, which made every threshold pass.
**Every threshold passed and the mix was unacceptable.** The thresholds are
necessary, not sufficient, and no amount of green ticks substitutes for one
person listening.

Two consequences:

1. **`scripts/preview-air.ts` exists so the next level decision is made by ear.**
   It renders short clips at five air levels from one build and prints the
   resulting `high` share beside each, so the trade-off is visible before
   committing.
2. **The green `audio:check` result was partly a measurement artifact** — see the
   drone-straddles-the-band-edge finding below. I spent several tuning
   iterations chasing numbers that were partly determined by which key the
   harmony happened to wander into.

## 2026-10-10 · T3.5 (fix) · §8.4's `high ≥ 5 %` and "no hiss" are mutually exclusive here

**Measured trade-off** (`preview-air.ts`, 120 s, E ≈ 0.6):

| air gain           | `high` share | §8.4 verdict | perceptual             |
| ------------------ | ------------ | ------------ | ---------------------- |
| 0.00               | 0.7 %        | fail         | nothing                |
| 0.06               | 1.2 %        | fail         | barely there           |
| **0.15 (shipped)** | **3.8 %**    | fail         | quiet texture          |
| 0.30               | 11.9 %       | **pass**     | unknown — needs an ear |
| 0.55 (pre-fix)     | 29.9 %       | pass         | **reported as hiss**   |

**Nothing between 0.7 % and 11.9 % offers a comfortable middle**, because the
material has essentially no energy up there to amplify. This is not a tuning
failure; it is a property of the synthesis combined with §8.4's target.

**Not resolved unilaterally.** §8.4's `high` target is an acceptance criterion,
so weakening it is a spec decision, not an engineering one. The current shipped
value (0.15) deliberately **fails** `audio:check` rather than quietly passing a
relaxed threshold. Options put to the user:

- **(a)** ship 0.15, accept that `audio:check` reports one failing band, and
  revise §8.4's `high` target to match the material;
- **(b)** ship 0.30, which meets §8.4, pending confirmation that 5 kHz noise at
  that level reads as air rather than hiss;
- **(c)** keep iterating — rejected: every remaining lever is either
  spec-protected (`ROOT_MIDI_BASE`, voice registers) or moves the violation to a
  different band, which was repeatedly observed during this task.

## 2026-10-10 · T3.5 (fix) · The drone straddles the 80 Hz sub/bass boundary, making band shares wander

**Found while diagnosing the above.** §8.8 puts the drone at `rootMidi − 12`,
which with `ROOT_MIDI_BASE = 48` is **midi 36–47 = 65.4–123.5 Hz**. The §8.4
boundary between `sub` and `bass` is **80 Hz**:

| root | 0   | 1   | 2   | 3   | 5        | 7        | 9        | 11       |
| ---- | --- | --- | --- | --- | -------- | -------- | -------- | -------- |
| band | sub | sub | sub | sub | **bass** | **bass** | **bass** | **bass** |

The harmony wanders (§7.1: a key change every 32 bars ≈ 113 s), so **which side
of the boundary the drone lands on depends on where a given render happens to
end.** Two renders of the same configuration at 100 s and 120 s reported
`high` shares of 8.8 % and 0.7 % — same seed, same rate, same code.

**Consequences for anyone re-tuning:**

- **Always measure at the spec's 120 s.** Shorter windows are dominated by the
  continuous drone, because constant power dilutes as note energy accumulates
  (at 25 s the same config reported `sub` at 60 %; at 120 s, 31 %).
- Differences of a few points between runs may be the key, not the change.
- The drone is the single largest contributor to both low bands, so it is the
  first thing to suspect when `sub` and `bass` disagree between runs.

Fixing it would mean moving the drone clear of 80 Hz, which §8.8 fixes, so it is
recorded rather than changed.
