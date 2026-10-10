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

_TODO (T6.5):_ full tree from `engine/`, `components/`, `scripts/`, `tests/`.

## 5. Build pipeline

_TODO (T0.2):_ esbuild → `public/engine/ingest.worker.js` and
`public/engine/voice-pool.worklet.js`.

## 6. Testing strategy

_TODO (T0.2):_ unit / integration / e2e / offline-audio / soak.
