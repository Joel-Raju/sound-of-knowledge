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
- [ ] **T0.2** Tooling
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

- [ ] **T3.1** DSP voices
- [ ] **T3.2** Worklet, allocator, audio engine core
- [ ] **T3.3** FX chain, pad, drone, air
- [ ] **T3.4** Analyzer
- [ ] **T3.5** Scheduler↔audio wiring, offline render harness, mix tuning

## Phase 4 — Visual engine

- [ ] **T4.1** Renderer bootstrap, camera rig, palette, governor, tiers
- [ ] **T4.2** Core orb
- [ ] **T4.3** Sparks and rings
- [ ] **T4.4** Dust and post-processing
- [ ] **T4.5** Visual queue, event firing, labels, audio coupling

## Phase 5 — Product shell

- [ ] **T5.1** Engine integration and React shell
- [ ] **T5.2** HUD, settings, ticker, shortcuts
- [ ] **T5.3** Robustness, accessibility, mobile
- [ ] **T5.4** Security, metadata, deploy config

## Phase 6 — Quality, performance, documentation

- [ ] **T6.1** Test completion and coverage
- [ ] **T6.2** Final audio verification
- [ ] **T6.3** Performance validation
- [ ] **T6.4** Cross-browser fallbacks
- [ ] **T6.5** Documentation and release prep
- [ ] **T6.6** Final acceptance run

---

## §16 Final acceptance checklist

### Automated

- [ ] `npm ci && npm run typecheck && npm run lint && npm run test:cov && npm run build && npm run test:e2e && npm run audio:check`
- [ ] Offline audio report within §8.4 ranges at E ≈ 0.3 / 0.6 / 0.9; pan test passes
- [ ] Soak test: no heap/DOM growth beyond §12.1
- [ ] DSP ≥ 10× real time; worker and worklet bundles < 40 KB gzip; first-load JS ≤ 450 KB gzip
- [ ] No Tone.js / R3F / Zustand in `npm ls`
- [ ] No usernames or IPs anywhere in `NormalizedEdit`, logs, or DOM
- [ ] XSS test passes (titles rendered as text only)
- [ ] Stream-failure → replay fallback works; reconnect returns to live
- [ ] All docs present and complete

### HUMAN-CHECK

Tracked in `docs/HUMAN-CHECKLIST.md` — the agent cannot verify these.

---

## Status

**Phases 0–2 complete** (T0.1–T0.3, T1.1–T1.5, T2.1–T2.3). 308 unit tests, all gates
green, 97.4 % line coverage. Next: **T3.1** DSP voices.
