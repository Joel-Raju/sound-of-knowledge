# Progress Log — Sound of Knowledge v2 Rewrite

Spec: `sound-of-knowledge-v2-rewrite-spec.md`. Branch: `v2-rewrite`.
Baseline: tag `v1-final` (`8bb5a1d`).

A task is ticked **only** when its acceptance criteria pass. Notes are 1–3 lines.

---

## Phase 0 — Preparation

- [x] **T0.1** Branch, audit, clean slate
  - Branched `v2-rewrite` from `master`; tagged `v1-final`. Audited ~2,200 LOC of v1
    into `docs/LEGACY-NOTES.md` (11 hard-won bug fixes captured). Deleted `components/*`,
    `lib/*`, `app/api/wiki-stream/`; page replaced with placeholder. Removed
    `tone`, `@react-three/fiber`, `@react-three/drei`, `@react-three/postprocessing`, `zustand`.
- [x] **T0.2** Tooling
  - Pinned all deps exactly (§4.1). `vitest@4.1.11` and `npm-run-all2@8.0.4` chosen over
    latest because 5.x/9.x declare Node engines this environment (24.13.1) does not satisfy.
  - Strict TS (`noUncheckedIndexedAccess`, `noImplicitOverride`), ESLint flat config with
    no-`any` error + hot-path allocation bans, vitest 4, Playwright with the §13.4 Chromium
    args, Prettier, esbuild worker/worklet pipeline (`--watch` reports gzip vs the 40 KB
    budget), CI workflow with a bundle-budget gate. Stubs make `prebuild` green before the
    engine modules exist.
- [x] **T0.3** Foundation modules
  - `engine/{config,types,bus}.ts` and `engine/util/{hash,math,random,ring-buffer,oklch,perf}.ts`.
    Every spec numeric lives in `config.ts` with a `// spec §x.y` comment (tier tables
    verified against §8.12/§12.3 by test).
  - 88 unit tests, **98.8 % lines** (target 85 %). Two real bugs caught and fixed:
    OKLCH gamut epsilon was 5× too tight (spec's own red vector failed), and
    `expApproach(tau=0)` silently behaved as tau=1 s. The hot-path ESLint ban also
    caught two `new Array()` allocations on first run.

## Phase 1 — Data layer

- [x] **T1.1** Stream reconnaissance and calibration
  - **Network is available** — an earlier `curl -I` timeout was misread as a
    refused connection (HEAD never returns on an SSE stream). Retraction is
    logged prominently in `DECISIONS.md`.
  - CORS returns `access-control-allow-origin: *` → **browser-direct works, no
    proxy** (§6.6 route stays deleted). 120 s live capture, 0 parse errors.
  - **`EPS_REF = 15`** = `round(1.5 × p95)` of post-normalize throughput. Measured
    kind mix is 54 % `categorize` / 34 % `edit` / 8 % `log` / 4.5 % `new`, so raw
    throughput (p95 62/s) overstates the musical rate by ~6× — calibrating on the
    post-normalize rate as §7.3 actually specifies.
  - Fixtures: 16 redacted samples covering every case in §T1.1, hand-written from
    the §6.1 shape and labelled as such. Revert heuristic under-fires in the wild
    (0.2 % vs 3 % model) — tracked as HUMAN-CHECK E3.
- [x] **T1.2** Normalizer, filters, dedupe, encoding
  - `normalize.ts` (pure, never throws), `filters.ts`, `encode.ts` with the §6.5
    `Float64Array` stride protocol. 52 tests from the redacted fixtures; **98.6 % lines**
    overall, ingest well above the 90 % target. Privacy asserted directly: no username or
    IP survives into `NormalizedEdit`, the wire batch, or the DOM-facing fields.
- [x] **T1.3** Synthetic and replay sources
  - `synthetic.ts` (seeded mulberry32, §6.7 model: diurnal rate, bursts, Zipf languages,
    log-normal deltas) and `replay.ts` (NDJSON, loops forever, re-issues ids per lap so
    the dedupe ring cannot silence it). Ratios verified over 20 000 events.
  - `public/replay/sample.ndjson` is a **real 180 s capture**, not synthetic — network is
    available, so `record-stream.ts` is the right source. Bot ratio came out **19.8 %**
    against the spec model's 20 %.
  - `gen-synthetic.ts` auto-shortens to fit the 300 KB budget rather than failing:
    the §6.7 synthetic rate (14/s) is ~2× too dense for 3 minutes. Verified idempotent
    (identical SHA-256 across runs).
- [x] **T1.4** Sampler and SSE client
  - Token-bucket sampler with the 25 % uniform-random reserve that keeps small-edit
    texture alive under pressure, and an SSE client whose watchdog / 1-2-4-8-15-30 s
    backoff / replay fallback are all driven by injected clocks and EventSource.
- [x] **T1.5** Ingest core, worker, client wrapper
  - `IngestCore` holds all logic with **no worker globals**, so the whole pipeline is
    tested in Node against a virtual clock (213 tests total). Worker is a thin shell;
    `IngestClient` handles restart-once-on-crash (§14.1).
  - Acceptance numbers verified: emitted ≤ maxPerSec × seconds, `accepted` ≈ 1000 at
    100 eps (stats stay honest while playback is capped), heartbeat ≈ 400 per 10 s.
  - **Worker bundle 7.9 KB gzip** (20 % of the 40 KB budget). Found and fixed a real bug
    here: one-shot builds keyed production off ambient `NODE_ENV`, so an unset
    `NODE_ENV` shipped a 65 KB sourcemap-inlined bundle.
  - CORS allowed → the §6.6 proxy stays deleted.

## Phase 2 — Music engine

- [x] **T2.1** Modes, harmony, pitch
  - Mode tables transcribed verbatim; a test asserts every chord's pitch classes lie
    inside its mode's scale, so a later edit to the tables cannot silently break the
    "always one piece" guarantee.
  - **Spec-reading trap found**: `modeForEnergy` boundaries. `below: 0.45` on _dorian_ is
    the point at which **mixolydian** takes over — the dorian/mixolydian edge is 0.45, not
    0.70. Hysteresis is anchored to the `below` of the _candidate_ mode.
  - Renamed `nextChordIdx`/`nextRootPc` → `chooseNextChordIdx`/`chooseNextRootPc`: they are
    pure selectors and `onBar` applies the result; the old names implied mutation.
- [x] **T2.2** Spatial mapper, router, energy tracker, euclid
  - **Bjorklund must use the a/b-list formulation** — the obvious front-to-back pairing
    yields gaps of {4,2,2,2,2,2,2} for `euclid(7,16)`, violating the spec's own
    "gaps differ by ≤ 1" and making the bot groove lurch. Caught by tests; all four spec
    reference patterns now pass verbatim.
  - Spatial mapper perturbs along a proper tangent basis so edits stay _on_ the shell;
    nudging components directly would change the radius and read as uneven density.
- [x] **T2.3** Scheduler and offline music simulation
  - `Scheduler` with fully injected clock/visibility/RNG/sinks — no Web Audio, so the
    whole performance layer is testable in Node (308 tests total).
  - `scripts/sim-music.ts` runs 5 simulated minutes and **exits non-zero** on violation.
    At 6 eps: 2052 notes, 0 dropped, melodic 4.37/s vs target 4.57 (96 %), peak 2 melodic
    notes/step, worst quantisation error 6.00 ms (= the ±6 ms humanise bound), chords every
    4 bars, modes only on phrase boundaries. All checks pass.
  - Cross-check: the sim reports **E = 0.702 at 6 eps**, independently confirming the T1.1
    calibration (`log10(7)/log10(16) = 0.703`).

## Phase 3 — Audio engine

- [x] **T3.1** DSP voices (`engine/audio/dsp/*.ts`)
  - Six pure voices: sine/bell/pluck/sub/gong/noise, Toussaint a/b-list Djorklund,
    per-kind `VOICE_GAIN`, additive normalisation by amplitude sum, incremental
    exponential decay. No `AudioNode` in the DSP — that is what makes it testable.
  - Three §13.2 assertions are **unsatisfiable as written** and were documented
    rather than silently loosened (see `DECISIONS.md`, T3.1 batch).
- [x] **T3.2** Worklet, allocator, audio engine core
  - `voice-pool.worklet.ts` preallocates 6 voice classes × N slots with an
    8-deep pending queue per slot; `process()` allocates nothing.
  - `AudioEngine` takes a `BaseAudioContext` so the identical graph can run in
    an `OfflineAudioContext` — the only "ears" an agent has (§13.3).
- [x] **T3.3** FX chain, pad, drone, air
  - `reverb-ir.ts` renders a **seeded** stereo IR (pre-delay, closing low-pass,
    6 early reflections/ch) so the offline render is reproducible.
  - `pad-layer.ts` cross-fades two banks; budget asserted in tests at exactly
    the §8.8 cap of 22 continuous oscillators (2 banks × 5 notes × 2 + 2 drone).
  - **Bug found and fixed**: `buildFxChain` ran _after_ the master chain was
    wired, so the FX `mixBus` — which the pad, drone, air, reverb return and
    delay all feed — was connected to nothing. Silent: every smoke test passed
    and the continuous layers were inaudible. Guarded by the new graph tests.
- [x] **T3.4** Analyzer
  - `bandLevels` / `smooth` / `flux` / `rmsToUnit` are pure and unit-tested with
    synthetic dB arrays; `Analyzer` owns the node and the preallocated buffers.
  - Flux decay state is **per-instance**, not module-global — two analysers
    (live + offline render) must not corrupt each other.
  - New `tests/helpers/fake-audio-context.ts` records graph topology so silent
    dead-end wiring fails the fast unit suite rather than only e2e. Verified by
    reintroducing the T3.3 bug: 3 tests fail.
- [x] **T3.5** Scheduler↔audio wiring, offline render harness, mix tuning
  - `engine/debug/render-offline.ts` renders the **real** `AudioEngine` +
    worklet + `Scheduler` through an `OfflineAudioContext`. Deliberately not a
    hand-built approximation of the graph — that is how the T3.3 wiring bug
    stayed invisible.
  - **Found:** `AudioEngine` read `ctx.currentTime`, which is 0 for the whole
    offline scheduling pass, so all energy-driven automation fired once at t=0.
    Added an injected clock (`AudioEngineOptions.now`).
  - `scripts/render-audio.ts` + `scripts/probe-bands.ts`; WAV writer; pure
    `mix-analysis.ts` (FFT, band share, §8.4 thresholds) with 48 unit tests.
  - `npm run audio:check` passes at E ≈ 0.3 / 0.6 / 0.9 over 120 s each.
    Values and rationale in `docs/TUNING.md`; nine deviations in
    `DECISIONS.md`. Largest: air gain ≈ +35 dB (§8.8's level cannot reach
    §8.4's high-band target — the air layer is the _only_ source of 2–8 kHz).
  - Bench still passes at 10.8× RTF; worker/worklet bundles 7 KB / 3 KB gzip.

## Phase 4 — Visual engine

- [x] **T4.1** Renderer bootstrap, camera rig, palette, governor, tiers
- [x] **T4.2** Core orb
- [x] **T4.3** Sparks and rings
- [x] **T4.4** Dust and post-processing
- [x] **T4.5** Visual queue, event firing, labels, audio coupling

## Phase 5 — Product shell

- [x] **T5.1** Engine integration and React shell
- [x] **T5.2** HUD, settings, ticker, shortcuts
- [x] **T5.3** Robustness, accessibility, mobile
- [x] **T5.4** Security, metadata, deploy config

## Phase 6 — Quality, performance, documentation

- [x] **T6.1** Test completion and coverage
- [x] **T6.2** Final audio verification
- [x] **T6.3** Performance validation
- [ ] **T6.4** Cross-browser fallbacks — ⏸️ **DEFERRED by choice, not done.**
      `crossbrowser.spec.ts` exists with 4 tests, all tagged `@crossbrowser`, and the
      `firefox-smoke` / `webkit-smoke` projects correctly select them — the wiring is
      verified, not assumed. They have **never been executed**: only
      `chromium-1248` is in `~/Library/Caches/ms-playwright/`, and installing Firefox
      and WebKit was declined. Accepting the task would have required running them, so
      the task stays unticked. **Consequence: F1–F5 have no automated coverage at all
      and must be verified by hand on real hardware.** See `DECISIONS.md`, T6.4.
- [x] **T6.5** Documentation and release prep
- [x] **T6.6** Final acceptance run — run in full at `npm ci` from a deleted
      `node_modules`. Six of seven steps rc=0: typecheck, lint, **934 unit tests across
      34 files**, build clean, `audio:check` E30/E60/E90 all ✓. `npm run test:e2e`
      returned **rc=1 — 91 passed, 8 failed**, all 8 being the `@crossbrowser` tests under
      `firefox-smoke` / `webkit-smoke` against browsers that are not installed.
      **Ticked because the run happened; §16's first automated item is left unticked
      because the chain does not return 0.** See `DECISIONS.md`, T6.6.

---

## §16 Final acceptance checklist

### Automated

- [ ] ❌ **UNSATISFIABLE ON THIS MACHINE — not a product defect.**
      `npm ci && npm run typecheck && npm run lint && npm run test:cov && npm run build && npm run test:e2e && npm run audio:check`
      — **run in full at T6.6. Six of seven steps rc=0. `npm run test:e2e` returned
      rc=1: 91 passed, 8 failed.** All 8 are the `@crossbrowser` tests under
      `firefox-smoke` / `webkit-smoke`, and those browsers are not installed. `test:e2e`
      is `playwright test` with **no `--project` filter**, so it runs all three projects
      and its exit code depends on what is installed rather than on the software. The
      human chose to leave this red rather than install the browsers or split the script.
      **Left unticked deliberately.** See `DECISIONS.md`, T6.6.
- [x] Offline audio report within §8.4 ranges at E ≈ 0.3 / 0.6 / 0.9; pan test passes
      — E30/E60/E90 all ✓. Peak −4.6/−4.8/−5.0 dBFS, rms −16.1/−17.0/−17.6 dBFS, crest
      11.5/12.2/12.6 dB. Pan test passes on Chromium (5.7–6.4 dB, windowed).
- [x] Soak test: no heap/DOM growth beyond §12.1 — 601 s: heap slope **−0.070 MB/min**,
      spread 1.41 MB, DOM drift **0 %** (68 → 68).
- [x] DSP ≥ 10× real time; worker and worklet bundles < 40 KB gzip; first-load JS ≤ 450 KB gzip
      — **11.4×** · **8.1 KB** · **3.0 KB** · **384.4 KB** across 17 files.
- [x] No Tone.js / R3F / Zustand in `npm ls` — zero matches.
- [x] No usernames or IPs anywhere in `NormalizedEdit`, logs, or DOM — §14.2; there is
      no `user` field in `engine/types.ts`.
- [x] XSS test passes (titles rendered as text only) — `security-metadata.spec.ts`,
      passes on Chromium.
- [x] Stream-failure → replay fallback works; reconnect returns to live —
      `resilience.spec.ts`, passes on Chromium.
- [x] All docs present and complete — README, ARCHITECTURE, TUNING, DECISIONS, PROGRESS,
      HUMAN-CHECKLIST. Every internal link in the README resolves.

### HUMAN-CHECK

Tracked in `docs/HUMAN-CHECKLIST.md` — the agent cannot verify these.

---

## Status

**Phase 6** — **30 of 31 tasks**. 934 unit tests (34 files) · 91 Chromium e2e · build
clean · `audio:check` E30/E60/E90 all ✓.
**Human checklist: 22 of 51 closed, 29 open** — `docs/HUMAN-CHECKLIST.md`.

**Two tasks are unticked and both are deliberate.** `T6.4` is deferred — Firefox and
WebKit are not installed, and the human chose not to install them. `T6.6` is ticked
because the acceptance run *happened*; §16's **first automated item is left unticked**
because `npm run test:e2e` returns 1 while those two browsers are absent. Neither is a
product defect, and neither is hidden by a rename.

**D1–D4 are all closed**, re-judged on audio rendered after the `WORKLET_QUEUE_CAP`
fix that had been silently discarding 80–95 % of notes. The full graph renders offline
within §8.4 at all three energies, and the 10-minute soak was listened to in full and
liked (**D4**, drift spread 2.99 dB over 600 s).

### What the 36 open items need

| needs | items | unblockable here? |
|---|---|---|
| ears on the live piece | A1–A10, B1–B9 | **No** — this is the entire first impression |
| physical hardware | C1–C5, C7, C8 | No — devices, frame times, touch |
| eyes on the live piece | E3, E4, E5 | No — live traffic, the HUD, real titles |
| ears, actionable now | B11, B12 | No — follow-ups from this session |
| other browsers | F1–F5 | No — T6.4 deferred |

**Not one of the 36 is blocked on the agent.** No task remains that would close any of
them. That is the honest position at 30/31: the automated work is finished, and what is
left is entirely perceptual.

**This has already paid for itself.** C6 (the background rendered navy, not black),
C11 (the orb had no interior structure) and C11b (dust invisible at α = 0.35 against a
background that had since gone black) were each invisible to a fully green suite. Three
real defects, none found by a test — all three found by a person looking at the screen.

## T4.1 — visual skeleton ✅

Phase 4 opened with T4.1. `engine/visual/` went from 0 lines to the renderer's
full skeleton: WebGL2 bootstrap, resize/DPR, the rAF loop with its delta clamp,
context-loss handling, `dispose()`, the camera rig, the palette, the governor and
tier detection. The debug page now shows a live dark canvas.

One spec conflict had to be resolved rather than followed — §9.8's
`setPixelRatio(dpr * renderScale)` cannot be reconciled with §12.3's pixel-ratio
table. Logged in `DECISIONS.md` under _"§9.8's `setPixelRatio(dpr * renderScale)`
contradicts §12.3's table"_.

## T4.2 — orb core and screenshot harness ✅

**Shader budget measured before T4.2**, since T4.2 is what compiles real GLSL.
`npm run probe:shader` compiles a transcription of §9.4's orb under swiftshader:
worst case to first frame is **0.18 s against T5.1's 20 s budget**, and shader
compilation itself is ~0.1 ms. The 20 s budget is not at risk.

The probe first reported 50.7 ms/frame at the low tier and I concluded the orb needed
a resolution clamp. **That was wrong** — the probe used an orthographic projection
filling ~81 % of the frame where §9.1's camera puts the orb at ~13 %, and the orb is
fragment-bound. Corrected: the low tier costs **11.3 ms**, which `npm run shot`
independently measures at **10.5 ms** for the shipped engine. §12.3's step counts are
sufficient and no resolution clamp is needed. Full write-up in `DECISIONS.md`.

**T4.2** adds the core orb: §9.4's volumetric ray-march, the Ashima simplex/fbm/IGN
chunks, the 16-slot impact ring buffer, and `scripts/shot.ts` — the §13.4 screenshot
harness T4.2's acceptance depends on, which did not exist until now.

Acceptance passes (centre-region std-dev 20.3 > 5, mean |Δpixel| 4.6 > 1.0, no console
errors). **Looking at the captures found three defects that every automated check
passed**: a visible IGN screen-door weave in the orb's interior, a dark rather than
luminous core, and a faceted silhouette. Two are written up in `DECISIONS.md` with
candidate fixes (neither applied — they are visual judgements); the core-brightness
question is `HUMAN-CHECKLIST.md` C9, the weave is C10.

The probe was corrected in the same pass: it had been measuring an orthographic
projection filling ~81 % of the frame where §9.1's camera puts the orb at ~13 %, which
is what produced the wrong 50.7 ms figure. It now agrees with the shipped engine to
within 8 % (11.3 ms vs 10.5 ms).

## T4.3 — sparks and rings ✅

**T4.3** adds sparks and rings: §9.5's stateless GPU particles (24 576 / 12 288 / 6 144
instanced quads, state a pure function of `uTime − spawnTime`, ring-buffer spawn with
`addUpdateRange`), §9.6's 24 shockwave rings, and `__sok.debugSpawn(n)`.

46 new unit tests — ring-buffer wraparound maths exhaustively, spawn counts per tier.

**T4.3's stated acceptance criterion could not fail and was replaced.** It asks for
"bright pixels > 0.2 %"; the orb's own core reads 9.87 % with an empty pool, 9.97 % with
800 particles. `shot.ts --spawn` now differences a baseline frame taken immediately
before spawning, and asserts on `mean |Δpixel| = 1.18 > 1.0` — which fails when the pool
is empty and when the particles are off screen. The original threshold is still printed,
labelled informational.

Three defects surfaced only by looking at the captures: both shaders redeclared
`position`/`uv`, which three.js already supplies (a silent link failure), `half` is a
reserved GLSL word, and §9.1 puts the camera at radius 5.5 **inside** the 7–13 spawn
shell — so the first debug pattern put ~19 of 24 sparks outside the frustum and produced
a screenshot with none visible. All three are in `DECISIONS.md`.

Next: **T4.4**, dust and post-processing.

## T4.4 — dust and post-processing ✅

`engine/visual/dust.ts` (§9.7) and `engine/visual/post.ts` (§9.8) are built and wired:
the composer is the only thing that draws to screen, §9.2's draw order is pinned via
`renderOrder`, §9.11's bloom low-pass and ±35 % clamp are implemented, and AgX turned
out to be available so §9.8's ACES fallback is only a guard.

**One deliberate deviation from §9.7, chosen by eye.** §9.7 specifies 30 000 points and
a twinkle spanning [0.25, 1.0] but never says what the twinkle multiplies. At 1.0 the
motes render at full strength and the scene reads as a starfield — a second subject
competing with the orb. A six-candidate contact sheet (`shot.ts --dust-sweep`) settled it:
**base alpha 0.35**, at which the motes read as tiny dust particles around the orb.

Density turned out to be the wrong lever: 10 500 motes at alpha 1.0 score a corner
std-dev *identical* to having no dust at all. Cutting the count deletes the depth cue
rather than thinning it.

**Acceptance now passes** — corner-patch std-dev **1.85** in (0, 6), centre std-dev 66.75
> 5, no console errors. Both fixes found along the way were mine: invented
`ToneMappingEffect` parameters that lifted the near-black clear colour to navy
(7.04 → 5.02), and a four-row A/B that came back mislabelled because `ensureServer` reuses
whatever is listening. `--sweep` fixed the second class permanently. Full analysis in
`DECISIONS.md`.

Still open and *not* fixed: with the dust entirely off the background is still navy
rather than near-black — AgX lifting the clear colour. Folded into **C6**, since it is a
background question rather than a dust one.
