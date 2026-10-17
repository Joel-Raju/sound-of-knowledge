# Sound of Knowledge

**Listen to humanity writing its encyclopedia, live.**

Every edit to Wikipedia becomes a note and a streak of light. The size of the change
sets the length of the note, the article it touched sets the pitch, and the language it
came from sets the direction it arrives from. Reverts land as a deep gong. New pages
burst. Nothing is sampled away silently, and the meter reports what was really played.

Built directly against the [Wikimedia Recent Changes SSE
stream](https://stream.wikimedia.org/v2/stream/recentchange) — no proxy, no scraping, one
connection per tab.

---

## How it works

### An edit becomes a sound

The routing is a fixed, readable cascade ([`engine/music/router.ts`](engine/music/router.ts)):

| the edit | voice | what you hear |
|---|---|---|
| a **revert** | `gong` | a deep metallic strike with an expanding shockwave |
| a **new page** | `birth` | a rising arpeggio and a radial starburst |
| a **bot** | `thud` / `tick` | a soft pulse, sized by the change |
| **large** (≥ 60 % of the byte range) | `sub` | a deep swell underneath everything |
| **text added** (`delta > 0`) | `pluck` | warm, rounded |
| **text removed** | `bell` | cool, glassy, slightly inharmonic |

### An edit becomes a visual

[`§10.2`](sound-of-knowledge-v2-rewrite-spec.md) is the fire table, and
[`engine/visual/fire.ts`](engine/visual/fire.ts) is its only implementation:

| flavor | sparks | rings | orb | other |
|---|---|---|---|---|
| add | streak, *accent* | – | push, at arrival | – |
| remove | streak, *core* | – | push, at arrival | – |
| large | streak ×1.8 size | – | strong push | trauma +0.15, bloom swell |
| revert | – | ring at the edit | **dent**, immediately | CA kick, trauma +0.30 |
| new | burst (48) | – | – | label priority |
| bot-thud | bot pulse | – | small push | – |
| bot-tick | bot pulse, smaller | – | – | – |

*At arrival* means 85 % of the note's length, so the orb is struck when the sound arrives
rather than when it was scheduled.

### Why it sounds like it is coming from where the comet came from

Each edit gets a **home direction** from its wiki, chosen from 64 points on a Fibonacci
sphere and jittered slightly per-edit, and a **radius** of 7–13 world units. The listener
sits at the centre, so a German edit and a Japanese edit arrive from genuinely different
places.

Measured: a single bell hard to the right is **5.7–6.4 dB** louder on the right channel
([`tests/e2e/spatial-pan.spec.ts`](tests/e2e/spatial-pan.spec.ts)).

---

## Running it

Requires **Node ≥ 20**.

```bash
npm ci
npm run dev          # http://localhost:3000
```

`npm run dev` bundles the two Web Platform workers first, so the audio engine and the
ingest worker are present before Next starts.

### The commands that matter

| command | what it does |
|---|---|
| `npm run dev` | workers in watch mode + Next dev |
| `npm run build` / `npm start` | production build and serve |
| **`npm run check`** | typecheck, lint, project check, docs check, unit tests — **run this before every commit** |
| `npm run test:cov` | unit tests with §13.2's per-module coverage thresholds |
| `npm run test:e2e` | the Chromium suite |
| `npm run audio:check` | offline audio renders at three energy levels, checked against §8.4 |
| `npm run test:soak` | the §13.5 ten-minute leak test |
| `npm run bench` | the DSP real-time benchmark |
| `npm run og:image` | regenerate `public/og.png` from a live capture |

---

## URL parameters

None are persisted — they exist so a data point can be reproduced from a URL alone.

| parameter | values | effect |
|---|---|---|
| `?debug=1` | — | the T4 visual harness, `window.__sok`, and `?avSyncMs` in settings |
| `?source=` | `live` · `replay` · `synthetic` | **data mode.** Default `live` |
| `?seed=` | integer | PRNG seed for synthetic/replay |
| `?project=` | `wikipedias` · `no-wikidata` · `all` | which projects the ingest core accepts |
| `?quality=` | `auto` · `low` · `medium` · `high` | pins the tier and disables `improve()` beyond it |
| `?density=` | `sparse` · `normal` · `dense` | musical density |
| `?deep=` | 0–1 | override the background lightness (see below) |
| `?dustAlpha=` · `?dustDensity=` · `?nodust=1` | 0–4 · `1` | the ambient dust, for measuring its contribution |

`?source` and `?project` are **different things** and both exist deliberately:
`?source` is the data mode, `?project` is `Settings.source`. Collapsing them would break
both.

---

## Settings

Persisted to `localStorage` under `sok.settings.v2`, validated field-by-field on load.
A corrupt or hand-edited value falls back to its default rather than throwing — a broken
preference must never be able to stop the piece from starting.

| setting | default | effect |
|---|---|---|
| `volume` | 0.8 | master gain |
| `muted` | false | |
| `source` | `wikipedias` | which projects to accept |
| `langs` | `[]` (all) | language filter, as chips |
| `density` | `normal` | how many edits become notes |
| `quality` | `auto` | tier ceiling |
| `spatialAudio` | true | HRTF vs equal-power panning |
| `showTitles` | true | the article titles floating beside the orb |
| `reduceMotion` | `matchMedia('(prefers-reduced-motion: reduce)')` | §9.11 |
| `avSyncMs` | 0 | A/V correction, `?debug=1` only |

### Keyboard

`M` mute · `F` fullscreen · `H` hide UI · `S` settings · `Esc` close.
Shortcuts are ignored while typing in a field.

---

## Architecture at a glance

```
Wikimedia SSE ──► Ingest Worker ──► IngestCore ──► Scheduler ──┬──► AudioEngine ──► AudioWorklet
   (EventSource)   (normalize,     (token bucket,    (25 ms)    │     (16 voice slots,
                    filter, dedupe)  importance-      tick      │      allocator, FX chain)
                                  weighted sampling)             │
                                                               └──► VisualQueue ──► fire.ts
                                                                    (heard-time gate)   │
                                                                            ┌────────────┴───────────┐
                                                                            sparks · rings · orb    labels
```

Four **clocks**, and mixing them up is the single most common bug in a piece like this:

| clock | used by | why |
|---|---|---|
| `performance.now()` | the render loop | frames advance it, nothing else |
| `ctx.currentTime` | the scheduler, the worklet | the only clock audio is scheduled on |
| `heard` = `currentTime − outputLatency − avSyncMs` | the visual queue | so a visual lands when its note is *heard* |
| a virtual clock in offline renders | `render-audio.ts` | every note is scheduled before `startRendering()` |

**The visual queue gate uses `heard`, not the render clock.** `note.when` is
`AudioContext` time; comparing it against a render-clock value puts every visual at an
arbitrary offset from its sound.

Full detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Performance

Measured numbers, with how each was taken, are in [`docs/TUNING.md`](docs/TUNING.md).

| budget | target | measured |
|---|---|---|
| DSP real-time factor | ≥ 10× | **11.4×** |
| first-load JS | ≤ 450 KB gzip | **384.4 KB** |
| ingest worker | < 40 KB gzip | **8.1 KB** |
| voice-pool worklet | < 40 KB gzip | **3.0 KB** |
| heap growth over a 10-minute soak | < 0.5 MB/min | see `npm run test:soak` output |

---

## Tech stack

Next.js 16 (App Router) · React 19 · TypeScript (strict) · Tailwind CSS 4 · three.js ·
Web Audio API · Playwright · Vitest · esbuild

three.js is **dynamically imported** behind the debug harness and the start overlay, so
it never costs a production visitor a byte in the initial load.

---

## Project structure

```
app/                  # two routes. page.tsx decides ?debug=1 on the server
components/           # React shell ONLY — overlay, HUD, settings panel, harness
engine/
  index.ts            # §5.5 the facade. The only thing the shell talks to
  config.ts           # every named constant (§1.1.9)
  settings.ts         # §11.3 defaults, validation, persistence, URL overrides
  ingest/             # worker, SSE client, normaliser, sampler, replay, synthetic
  music/              # scheduler, router, harmony, pitch, spatial mapper, density
  audio/              # worklet, allocator, FX chain, pad, analysis, WAV encode
  visual/             # renderer, orb, sparks, rings, dust, labels, fire table
  debug/              # the offline renderer the audio harness drives
scripts/              # bench, audio renders, captures, sweeps, worker bundling
tests/unit/           # Vitest — 934 tests
tests/e2e/            # Playwright — 90 tests
docs/                 # ARCHITECTURE, TUNING, DECISIONS, PROGRESS, HUMAN-CHECKLIST
```

---

## Known deviations from the spec

All of them are recorded with their reason and their measurement in
[`docs/DECISIONS.md`](docs/DECISIONS.md) — there are several hundred lines of it, and it
is the most useful document in this repository. The ones you are most likely to notice:

- **The background is black** (`deep` at L = 0.04). §9.3's authored value renders as
  navy through AgX; the human chose black and the harmony is carried by the orb and dust
  instead.
- **Orb absorption 1.2, not 3.2**; **emission 0.55, not 1.0.** At §9.4's values the core
  is a structureless wash — the detail is lost to alpha saturation, not colour scale.
- **Dust base alpha 0.75**, which §9.7 never specifies. 0.35 was correct against the
  navy background and invisible against a black one.
- **The CSP ships as `Content-Security-Policy-Report-Only`**, with the full suite
  measured passing under the enforcing variant.

---

## Credits and data

- **Data: [Wikimedia EventStreams](https://wikitech.wikimedia.org/wiki/EventStreams)** —
  © Wikimedia Foundation, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
  One SSE connection per tab; no polling, no scraping, no proxy.
- Built to the spec in [`sound-of-knowledge-v2-rewrite-spec.md`](sound-of-knowledge-v2-rewrite-spec.md).
- Article titles are public data and may occasionally be offensive. The **Show titles**
  setting hides them. No automatic filtering is implemented, by choice — a filter that
  silently drops titles would make the meter lie about what was played.
