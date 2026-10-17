# Architecture — Sound of Knowledge v2

> **Status: finalised at T6.5.** Written against the code as built; where a
> subsystem does not exist, it is not described.

## 1. Threads

```
┌──────────────────────────── Browser ─────────────────────────────────────────────┐
│                                                                                  │
│  Ingest Worker (dedicated)                Main thread                            │
│  ┌──────────────────────────┐             ┌────────────────────────────────────┐ │
│  │ EventSource (SSE)        │  batches    │ EventHub (decode, stats)           │ │
│  │ parse → normalize        │ ──────────► │   │                                │ │
│  │ filter → dedupe          │ (Float64Array│   ▼                               │ │
│  │ sample (importance)      │  + strings)  │ MusicScheduler  (25 ms tick)      │ │
│  │ replay / synthetic       │             │   │ harmony, density, routing,     │ │
│  │ 25 ms heartbeat 'tick' ──┼───────────► │   │ quantisation, voice allocation │ │
│  └──────────────────────────┘             │   ├─► AudioEngine ──msg──► Worklet │ │
│                                           │   │     (graph, FX, panners)   (DSP)│ │
│                                           │   └─► VisualEventQueue             │ │
│                                           │          │ (fires at heard-time)   │ │
│                                           │          ▼                         │ │
│                                           │ Renderer (three.js, rAF)           │ │
│                                           │  orb, sparks, rings, dust, post   │ │
│                                           │  ▲ AudioFeatures (FFT bands)      │ │
│                                           │ React shell (overlay/HUD/settings) │ │
│                                           └────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────┘
```

The concrete modules, as built:

| Box above | Files |
| --- | --- |
| Ingest Worker | `engine/ingest/ingest.worker.ts` — owns the `EventSource`, `normalize.ts`, `filters.ts`, `sampler.ts`, `replay.ts`, `synthetic.ts`, `encode.ts` |
| EventHub (worker → main) | `engine/ingest/ingest-client.ts` over `protocol.ts`; `engine/ingest/ingest-core.ts` on the worker side |
| MusicScheduler | `engine/music/scheduler.ts`, with `router.ts`, `harmony.ts`, `pitch.ts`, `euclid.ts`, `density.ts`, `spatial-mapper.ts` |
| AudioEngine | `engine/audio/audio-engine.ts` → `voice-pool.worklet.ts`, `allocator.ts`, `fx-chain.ts`, `pad-layer.ts`, `reverb-ir.ts`, `voice-params.ts` |
| VisualEventQueue | `engine/visual/visual-queue.ts` → `fire.ts` |
| Renderer | `engine/visual/renderer.ts` + `orb.ts`, `sparks.ts`, `rings.ts`, `dust.ts`, `post.ts`, `camera-rig.ts`, `palette.ts`, `governor.ts`, `labels.ts` |
| AudioFeatures | `engine/audio/analyzer.ts` (FFT bands), read by the renderer's layer update |
| React shell | `components/experience.tsx`, `start-overlay.tsx`, `hud.tsx`, `settings-panel.tsx`, `error-banner.tsx` |

**The worker boundary is not cosmetic.** It exists so that JSON parsing, normalisation
and the importance-weighted sampler — all of which run on *every* edit in a feed that can
sustain thousands per second — never touch the frame loop. The only thing crossing the
boundary is a `Float64Array` of fixed-width fields plus a small array of strings, so
there is no structured-clone of an object graph per batch.

## 2. Clocks

**Four** clocks, deliberately kept separate. The fourth is the one that causes the most
expensive bug in a piece like this, and it was a bug for most of Phase 5.

| Clock | Source | Used for |
| --- | --- | --- |
| **Audio** | `AudioContext.currentTime` | **all** musical time; the `when` on every `NoteEvent` |
| **Heard** | `currentTime − outputLatency − avSyncMs/1000` | the visual queue's gate — so a visual lands when its note is *heard*, not when it was scheduled |
| **Visual** | `uTime`, from `performance.now()` | particle and label animation only |
| **Wall** | the Wikimedia `timestamp` | stats and replay timing only |

### §10.1's gate, as implemented

```ts
const heard = ctx.currentTime - outputLatency - avSyncMs / 1000;
while (queue.peek().when <= heard && fired < 8) fire(queue.pop());
```

**The queue gate uses `heard`, and everything downstream of `fire()` uses the render
clock.** That split is not a detail — it is the whole mechanism, and getting it wrong
puts every visual at an arbitrary offset from its sound, growing with the audio
hardware's drift and badly wrong after a tab has been hidden.

It was wrong for the whole of T5.1–T5.3: the queue was drained against the render clock
while `note.when` is `AudioContext` time. The two share a *rate* but not an *epoch*.

The `fired < 8` cap matters too: a frame that took 200 ms can have a dozen notes come due,
and firing them all puts that frame's work into the next frame.

### Why the offline harness needs a virtual clock

`AudioEngine` reads musical time from `AudioEngineOptions.now()`, which defaults
to `ctx.currentTime`. This is not indirection for its own sake — the offline
harness (§13.3) schedules every note up-front and only then calls
`startRendering()`, and during that pass `ctx.currentTime` is **0**.

Reading it directly was a live bug: `PadLayer.setEnergy` is rate-limited to 1 Hz,
so it fired exactly once, at t = 0, and the pad cutoff and air gain never
responded to energy at all. The render still produced sound and passed its band
targets, which is why it survived several tuning iterations.

**Rule:** anything the engine schedules "now" must go through `this.now()`.
A `ctx.currentTime` read inside `engine/` outside a comment explaining why is a
bug waiting to happen.

### A measurement trap worth recording

Whole-render RMS is the wrong statistic for any question about a short event in a long
render. Measuring §13.4's spatial pan that way reported **−0.36 dB** — which looks
exactly like a missing feature — because the master fades in over 2.5 s (§8.7) and the
test's note starts at t = 1 s, so most of it sits *inside* the fade. Windowing at 100 ms
and taking the peak reported **6.35 dB** on the same render.

`engine/debug/render-offline.ts` therefore reports both `panRightDb` (whole render) and
`panPeakWindowDb` (peak window), and a test asserts they disagree by more than 2 dB so
the diagnostic cannot silently stop discriminating.

### The audio clock is injectable

`AudioEngine` reads musical time from `AudioEngineOptions.now()`, which defaults
to `ctx.currentTime`. This is not indirection for its own sake — the offline
harness (§13.3) schedules every note up-front and only then calls
`startRendering()`, and during that pass `ctx.currentTime` is **0**.

Reading it directly was a live bug: `PadLayer.setEnergy` is rate-limited to 1 Hz,
so it fired exactly once, at t = 0, and the pad cutoff and air gain never
responded to energy at all. The render still produced sound and passed its band
targets, which is why it survived several tuning iterations.

**Rule:** anything the engine schedules "now" must go through `this.now()`.
A `ctx.currentTime` read inside `engine/` outside a comment explaining why is a
bug waiting to happen.

## 3. Data flow

End to end, for one edit:

1. **`sse-client.ts`** — one `EventSource` on the Wikimedia stream, with a watchdog, jittered
   exponential backoff and a replay fallback (§6.6).
2. **`normalize.ts`** — one event to a `NormalizedEdit`: host parsed, actor classified
   (IPv4, IPv6, `~year-month`, bot list, registered), magnitude and importance computed,
   reverts detected by pattern.
   **Nothing is retained.** §14.2 forbids a `user` field, and there is none anywhere in
   `engine/types.ts` — usernames and IPs are used to classify and discarded.
3. **`filters.ts`** — project and namespace filter, duplicate suppression (a fixed-size
   ring, so it cannot grow).
4. **`sampler.ts`** — a token bucket. **Keeps the highest-importance edits when over
   budget**, reserves ≥ 25 % of picks for random selection, and reports `dropped` so the
   HUD can tell the truth about what was not played (§1, line 99).
5. **`encode.ts`** — the batch becomes a `Float64Array` of fixed-width fields plus a
   string array, transferred with zero copy.
6. **`ingest-client.ts`** — the main thread decodes it and calls `Scheduler.onBatch`.
7. **`scheduler.ts`** — a bounded FIFO (edits older than 4 s are **discarded, not
   deferred**; playing a two-minute-old edit now sounds wrong). Each tick picks by
   euclidean patterns, routes the edit to a voice, and calls:
   ```ts
   note: (n) => audio.trigger(n) && visualQueue.push(n)
   ```
8. **`router.ts`** decides the voice; **`pitch.ts`** picks the pitch from the article
   title's hash, so the same article always sounds the same.
9. **`audio.trigger`** allocates a slot from `allocator.ts` (priority = importance +
   per-kind bonus; a failed allocation for a low-importance note is a silent drop,
   counted in `droppedNotes`) and posts to the worklet.
10. **`VisualQueue.push`** — at *scheduling* time, up to ~1.25 s before the sound.
11. **`VisualQueue.drain(heard)`** each frame, then `fire.ts` runs the §10.2 row.
12. **`renderer`** draws, and reads `AudioFeatures` from `analyzer.ts` so the visuals
    follow the mix rather than a parallel clock.

Two branches matter and are easy to miss:

- **Harmony** runs on the scheduler's bar clock, not its tick. It emits `mode` / `key`
  events that retune the palette (§9.3) and the pad.
- **Visibility.** §11.8: audio continues while hidden; rendering pauses. On
  `visibilitychange → visible` the queue is **cleared** — a hidden tab keeps scheduling,
  so on return it holds notes whose heard-time passed long ago, and firing them all at
  once is a wall of visuals that never matched a sound.

## 4. Module map

Every file, and what it owns. The visual engine is the layer where §9.x lives; note that
**the renderer knows nothing about Wikipedia or audio** — it draws what it is handed.

### Root

| File | Spec | Role |
| --- | --- | --- |
| `index.ts` | §5.5 | The `Engine` facade. `create/start/setSettings/on/screenshot/resumeAudio/injectEdits/getMetrics/dispose`. The only thing the React shell talks to. |
| `config.ts` | §1.1.9 | Every named constant. No magic numbers in feature code. |
| `settings.ts` | §11.3 | Defaults, field-by-field validation, `localStorage`, URL overrides. |
| `types.ts` | §5.6 | `NormalizedEdit`, `NoteEvent`, `AudioFeatures`, `Settings`. **No `user` field** — §14.2. |
| `bus.ts` | §5.5 | The engine's typed event emitter. |

### `ingest/` — the worker side

| File | Role |
| --- | --- |
| `ingest.worker.ts` | `@hot-file`. The dedicated worker: owns the `EventSource`, the 25 ms heartbeat. |
| `sse-client.ts` | Watchdog, jittered backoff, replay fallback (§6.6). |
| `normalize.ts` | One event → `NormalizedEdit`. Actor classification, magnitude, importance, revert patterns. |
| `filters.ts` | Project/namespace filter and a fixed-size dedupe ring. |
| `sampler.ts` | Token bucket, importance-weighted, ≥ 25 % random reserved. |
| `encode.ts` / `protocol.ts` | Fixed-width `Float64Array` batches, zero-copy transfer. |
| `ingest-core.ts` | The worker's state machine, independently testable. |
| `ingest-client.ts` | The main thread's handle onto the worker. |
| `replay.ts` / `synthetic.ts` | The `?source=` alternatives. |

### `music/`

| File | Role |
| --- | --- |
| `scheduler.ts` | The 25 ms tick. Routing, quantisation, euclidean patterns, harmony on the bar. |
| `router.ts` | Edit → voice. The cascade in the README. |
| `harmony.ts` / `modes.ts` | Mode and chord selection, §7.4. |
| `pitch.ts` | Article title → pitch, deterministically. |
| `spatial-mapper.ts` | Edit → direction and radius. 64 Fibonacci-sphere language homes, per-edit jitter. |
| `density.ts` / `euclid.ts` | `sparse`/`normal`/`dense`, and the per-voice patterns. |

### `audio/`

| File | Role |
| --- | --- |
| `voice-pool.worklet.ts` | `@hot-file`. The DSP: six synths, 16 slots, **no allocation per block**. |
| `audio-engine.ts` | The graph, the FX chain, the panners, the listener, the spatial model switch. |
| `allocator.ts` | Slot allocation by priority; §8.11's drop rules. |
| `fx-chain.ts` / `reverb-ir.ts` / `pad-layer.ts` | §8.3's order, and the continuous bed. |
| `analyzer.ts` | §8.10's `AudioFeatures`. |
| `mix-analysis.ts` | Band shares and levels, for §8.4 and the offline harness. |
| `wav.ts` | WAV encode for the offline renders. |

### `visual/`

| File | Role |
| --- | --- |
| `renderer.ts` | `VisualEngine` — context, scene, rAF loop, governor's effect on resolution, context loss. |
| `orb.ts` | §9.4's raymarched core, 16 impact slots. |
| `sparks.ts` / `rings.ts` | §9.5's instanced particles and the revert ring. |
| `dust.ts` | §9.7's ambient field. |
| `fire.ts` | **§10.2's table**, the only implementation of it. |
| `visual-queue.ts` | Heard-time gating, stale drop, fixed capacity. |
| `labels.ts` | §9.9's six anchors, `textContent` only, and the ticker feed. |
| `post.ts` | §9.8's composer: bloom, CA, vignette, grain, tone mapping. |
| `camera-rig.ts` / `palette.ts` / `governor.ts` / `tier.ts` | Auto-orbit and trauma · OKLCH modes · the level state machine · tier detection. |
| `util/perf.ts` | `FrameStats` over a fixed `NumericRing`, so a long session cannot grow the heap. |

### Invariants

Three invariants the rest of the codebase should preserve:

- **The renderer owns no allocation on the frame path.** `position`, `forward`,
  `listenerPose`, the clear colour and `Palette.colorFor`'s result are all reused
  triples. §12.1's "no per-frame allocations" is a budget, not a preference. The two
  `@hot-file` entries are lint-enforced: `.map`, `.filter`, `.forEach`, `.reduce`,
  `.slice`, `.concat`, spread in a call argument and `new Array(n)` are all errors
  there.
- **Every clock is injected.** `Governor.update(dtMs, now)` and `Scheduler`'s
  clock both take the time as an argument, for the same reason `AudioEngine` grew
  a `now` hook in T3.5 — a frame loop's own clock makes the state untestable.
- **External text only ever reaches the DOM as text.** `labels.ts` uses
  `textContent` and never `innerHTML`; the HUD renders the ticker as a React text node.
  Titles arrive from a live public API, so both surfaces are injection sinks. The e2e
  suite asserts this with a title of `<img src=x onerror=…>`.

## 5. Build pipeline

`scripts/build-workers.mjs` (esbuild, one-shot, always production) →
`public/engine/ingest.worker.js` and `public/engine/voice-pool.worklet.js`. The
visual engine is **not** bundled here — it is a dynamic `import()` behind
`?debug=1`, so three.js never reaches the production bundle (§12.4's 40 KB).

## 6. Testing strategy

Unit (vitest) for everything pure: modes, harmony, pitch, spatial mapping,
scheduler, DSP, the audio graph's topology, mix analysis, and the visual
governor / palette / tier / camera-rig helpers. Playwright for the two things
unit tests cannot reach — that an `AudioContext` boots and the worklet loads
(`audio-boot.spec.ts`), and that a real WebGL2 context renders, sizes and
disposes cleanly (`visual-boot.spec.ts`). Offline audio renders (`npm run
audio:check`) for §8.4's mix targets.

## 7. Running the tests

```bash
npx playwright install chromium firefox webkit   # once — matches what CI installs
npm run test:e2e
```

**All three browsers are required for `npm run test:e2e`.** `playwright.config.ts`
defines `firefox-smoke` and `webkit-smoke` alongside `chromium`, and those projects
`grep` for `@crossbrowser`. They are not optional extras: `ci.yml` installs all
three, so a machine with only Chromium will report eight failures that CI never
sees. `npm run check:projects` (run automatically by `test:e2e`) verifies that every
grepped project has at least one matching test — Playwright reports an empty
selection as success, so a project with no tests is indistinguishable from a passing
one without that check.

The cross-browser tests are **smoke**, not parity. Each asserts something that must
hold on any engine (a WebGL2 context exists, the orb rasterises, `AudioContext`
reaches `running`, reduced motion is honoured) and none assert something that
legitimately varies between them.
