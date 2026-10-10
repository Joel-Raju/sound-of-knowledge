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
- [ ] **T1.4** Sampler and SSE client
- [ ] **T1.5** Ingest core, worker, client wrapper

## Phase 2 — Music engine

- [ ] **T2.1** Modes, harmony, pitch
- [ ] **T2.2** Spatial mapper, router, density, Euclid
- [ ] **T2.3** Scheduler and offline music simulation

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

**Phase 0 complete.** T0.1 ✓ T0.2 ✓ T0.3 ✓. Next: T1.1 (stream reconnaissance).
