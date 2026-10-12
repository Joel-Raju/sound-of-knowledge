# Architecture — Sound of Knowledge v2

> **Status: stub.** Finalised in task **T6.5**. Sections marked _TODO_ are written
> when the corresponding subsystem exists.

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

_TODO (T1.5 / T5.1):_ annotate with the concrete module names actually built.

## 2. Clocks

Three clocks, deliberately kept separate (spec §5.2).

| Clock  | Source                                   | Used for                          |
| ------ | ---------------------------------------- | --------------------------------- |
| Audio  | `AudioContext.currentTime`               | **all** musical time; note `when` |
| Visual | `uTime` uniform from `performance.now()` | animation phase only              |
| Wall   | Wikimedia `timestamp`                    | stats and replay timing only      |

Bridging: a `NoteEvent` carries its audio time `when`; the renderer fires it when
`ctx.currentTime >= when + outputLatency` (spec §10.1).

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

_TODO (T4.5):_ document the implemented `VisualQueue` gating.

## 3. Data flow

_TODO (T1.5):_ SSE → normalize → filter → dedupe → sampler → encode → transfer →
decode → router → queue → scheduler → audio + visual.

## 4. Module map

_Full tree lands at T6.5._ The visual engine's T4.1 skeleton:

| File                            | Spec    | Role                                                                                                                                           |
| ------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `visual/renderer.ts`            | §9.1–2  | `VisualEngine` — context, scene, rAF loop, governor's effect on resolution, context loss, `dispose()`. Knows nothing about Wikipedia or audio. |
| `visual/camera-rig.ts`          | §9.1    | Auto-orbit, drag inertia, entrance ease, trauma shake. Pure helpers are unit-tested; the class writes into preallocated `position`/`forward`.  |
| `visual/palette.ts`             | §9.3    | Per-mode OKLCH palette, key hue shift, τ = 2 s ease, event colours.                                                                            |
| `visual/governor.ts`            | §9.10   | Pure state machine, injected clock. `scale` (pixel ratio) and `level ∈ [0..6]`.                                                                |
| `visual/tier.ts`                | §12.2–3 | `detectTier(env)` (pure), `readEnvironment()`, `pixelRatioCeiling(dpr, tier)`.                                                                 |
| `util/perf.ts`                  | §12.1   | `FrameStats` — frame-time EMA, p95, median, mean, 1 s fps. Fixed `NumericRing`, so a long session cannot grow the heap.                        |
| `components/visual-harness.tsx` | T4.1    | Debug-only React mount; publishes `window.__sok.visual`. Dynamically imported so three.js stays out of the production bundle.                  |

Two invariants the next tasks should preserve:

- **The renderer owns no allocation on the frame path.** `position`, `forward`,
  `listenerPose`, the clear colour and `Palette.colorFor`'s result are all reused
  triples. §12.1's "no per-frame allocations" is a budget, not a preference.
- **Every clock is injected.** `Governor.update(dtMs, now)` and `Scheduler`'s
  clock both take the time as an argument, for the same reason `AudioEngine` grew
  a `now` hook in T3.5 — a frame loop's own clock makes the state untestable.

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
