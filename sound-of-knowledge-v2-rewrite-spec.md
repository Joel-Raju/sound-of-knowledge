# Sound of Knowledge v2 — Complete Rewrite Specification & Execution Plan

> **Audience:** an autonomous coding agent (LLM) that will execute this rewrite end-to-end.
> **Repository:** `github.com/Joel-Raju/sound-of-knowledge` (Next.js app, deployed on Vercel).
> **Nature of work:** a _complete rewrite_. The concept is unchanged; the audio, visuals, data pipeline, architecture and performance are all redone.
> **How to read this file:** §1–§14 are the specification (the "what" and "how"). §15 is the ordered task list (the "do this next"). §16 is the final acceptance checklist. Every task in §15 references spec sections; read the referenced sections before starting the task.

---

## Table of contents

1. Agent operating rules
2. Concept and experience principles
3. Scope, constraints, non-goals
4. Tech stack and dependency policy
5. System architecture
6. Data layer specification
7. Music system specification
8. Audio engine specification
9. Visual engine specification
10. Audio–visual synchronisation
11. UI/UX specification
12. Performance budgets and quality tiers
13. Testing and verification strategy
14. Resilience, privacy, security
15. Execution plan (sequential tasks)
16. Final acceptance checklist
17. Appendix: stretch goals

---

## 1. Agent operating rules

Read this section fully before doing anything. These rules apply to every task.

### 1.1 Working rules

1. **Execute tasks in the order given in §15.** Do not start task N+1 until every acceptance criterion of task N passes.
2. **Quality gates** must be green after every task: `npm run typecheck`, `npm run lint`, `npm run test`. From task T0.2 onward they exist; before that, run what exists. After task T5.1, also `npm run build`. After task T6.1, also `npm run test:e2e`.
3. **Commit after every task** on branch `v2-rewrite` using Conventional Commits (e.g. `feat(ingest): add normalizer and filters`). One task = one commit minimum; more is fine.
4. **Progress log:** maintain `docs/PROGRESS.md` as a checklist of all task IDs. Tick a task only when its acceptance criteria pass. Add a one-to-three line note per task (what was done, any deviation).
5. **Decisions log:** maintain `docs/DECISIONS.md`. Whenever you deviate from this spec (library API differs, number needs retuning, ambiguity resolved), add an entry: _date, task ID, what the spec said, what you did, why_. **Never deviate silently.** Prefer the option that best satisfies the goals in §2 and the budgets in §12.
6. **Verify library APIs against the installed package** (read its `.d.ts` files and docs in `node_modules`) instead of relying on memory. This matters especially for `three`, `postprocessing`, and Web Audio feature support. If this spec names an API that does not exist in the installed version, use the closest equivalent and log it.
7. **Do not ask the human questions** unless you are blocked by something you cannot work around (missing credentials, no network for a required install). Otherwise decide, log the decision, continue.
8. **No new dependencies** beyond §4 without a `DECISIONS.md` entry justifying it.
9. **Everything numeric in this spec lives in code as a named constant** in `engine/config.ts` (or a clearly-named sibling) with a comment `// spec §x.y`. No magic numbers scattered in feature code.
10. **Files stay small and single-purpose.** Target < 400 lines per file. Prefer pure functions in their own modules so they are unit-testable.
11. **TypeScript:** `strict: true`, `noUncheckedIndexedAccess: true`, no `any` (use `unknown` + narrowing; if truly unavoidable, add `// eslint-disable-next-line` with a reason). No default exports except where Next.js requires them.
12. You cannot hear audio or see the screen. Therefore **every audio/visual quality target has a measurable proxy** defined in this spec (offline render report, screenshot variance, frame-time metrics, etc.). Build the harnesses described in §13 and use them. Items that genuinely need human eyes/ears are tagged **`HUMAN-CHECK`**; collect them into `docs/HUMAN-CHECKLIST.md` for the human to review at the end. Do not block on them.

### 1.2 Hot-path rules (performance-critical code)

"Hot path" = the render loop (`requestAnimationFrame` callback and everything it calls), the scheduler tick, the ingest worker's per-event/per-batch code, and the AudioWorklet `process()` function.

In hot paths you MUST NOT:

- allocate objects, arrays, closures, or strings per frame/per sample (use preallocated scratch objects, module-level `THREE.Vector3`/`Color` temporaries, typed-array pools, ring buffers);
- use `Array.prototype.map/filter/reduce/forEach/slice/concat/spread` on per-frame data;
- call `console.log` (use the debug overlay or a ring-buffer logger);
- touch the DOM except via the explicit label/HUD update functions that batch DOM writes (≤ 1 write per element per frame, transforms only);
- trigger React state updates (React is only for the UI shell, updated at ≤ 4 Hz from engine events).

Per-event allocation of one `NormalizedEdit` object on the main thread (≤ ~100/s) is allowed. In `process()` in the AudioWorklet, nothing may allocate at all, and `Math.*` calls should be limited to what the DSP needs.

### 1.3 Task format (used in §15)

Each task has: **ID**, **Title**, **Depends on**, **Spec refs**, **Do** (ordered steps), **Files**, **Acceptance** (verifiable, mostly commands), **Commit**.

### 1.4 Global Definition of Done (applies to the whole rewrite)

- All tasks ticked; §16 checklist all ticked (except items tagged `HUMAN-CHECK`, which are listed in `docs/HUMAN-CHECKLIST.md`).
- `npm run typecheck && npm run lint && npm run test && npm run build && npm run test:e2e` all pass from a clean `npm ci`.
- No Tone.js, no React Three Fiber, no Zustand in the final dependency tree.
- README rewritten; `docs/ARCHITECTURE.md`, `docs/TUNING.md`, `docs/DECISIONS.md`, `docs/PROGRESS.md`, `docs/HUMAN-CHECKLIST.md` present.

---

## 2. Concept and experience principles

### 2.1 One-line concept

**Listen to humanity writing its encyclopedia, live.** Every real Wikipedia edit, as it happens anywhere in the world, becomes a sound and a flash of light in a shared 3D space you can sit inside.

### 2.2 What the experience should feel like (a 60-second walkthrough)

1. The page opens on near-black with a quiet title and a single **Enter** button ("Best with headphones").
2. On Enter, a low drone swells in over ~2.5 s. A dim, softly breathing luminous core fades up in the centre of a vast dark space filled with faint drifting dust. The camera slowly dollies in.
3. Within seconds, the first real edits arrive. Each one is a comet of light that streaks from somewhere around you toward the core and dissolves into it, rippling its surface. At the same instant (audio-clock-synchronised), a note is heard from **the direction the comet came from**: warm plucks for added text, cool glass bells for removed text, deep swells for very large edits.
4. A gentle pulse underneath is built from bot activity: soft thuds and ticks on a loose, slowly evolving rhythm. Because bots really are mechanical, the groove is real data.
5. Occasionally, a **revert** lands: a deep metallic gong, an expanding shockwave ring, a tiny chromatic-aberration kick. A **new page** appears: a rising little arpeggio and a radial burst of stars.
6. Every ~30 seconds the harmony drifts: chords change every ~14 s, the mode and colour palette shift with global activity (calm → Aeolian/violet, busy → Lydian/gold), the key slowly walks around the circle of fifths. It never sounds random; it always sounds like one piece.
7. Occasionally an article title fades in near a notable edit, clickable to open the article. A tiny ticker shows the latest notable edit.

### 2.3 Design principles (resolve conflicts using this order)

1. **The engine composes; the data conducts.** Incoming edits never produce arbitrary sounds. They _select, gate, and shape_ musical events inside a consistent harmonic and rhythmic framework. Result: always musical, never cacophonous.
2. **One clock.** The Web Audio clock (`AudioContext.currentTime`) is the single source of musical and visual timing. Notes are quantised to a grid; visuals fire at the moment the note is _heard_.
3. **Same event, same instant.** Each sound and its visual come from the same scheduled event object and share a timestamp.
4. **Honest data.** Every note/visual (except the ambient bed and dust) corresponds to a real edit. Nothing is faked. When throttling is necessary (too many edits), sampling is importance-weighted and the HUD reports true rates.
5. **Restraint.** Ambient, spacious, low-fatiguing. Silence between events is a feature. Max loudness is bounded by a limiter. No full-screen strobing (see §11.6).
6. **Be inside it.** Audio is full 360° spatial around the listener; the camera sits inside the cloud of edits, looking at the core.
7. **Performance is a feature.** 60 fps on a mid-range laptop, 30+ fps on a mid-range phone, no audio glitches, no memory growth (§12).
8. **Privacy by design.** Never display or retain editor usernames or IP addresses (§14).

---

## 3. Scope, constraints, non-goals

### 3.1 In scope

- Full rewrite of ingestion, music, audio, visuals, UI shell, tooling, tests, docs.
- Keep deployment on Vercel with the existing project; keep Vercel Analytics if it exists in `app/layout.tsx`.
- Keep the Wikimedia Recent Changes stream as the data source.

### 3.2 Constraints

- 100% synthesised audio at runtime (no audio samples, no audio files). The reverb impulse response is procedurally generated (§8.7).
- Browser support: current Chrome/Edge/Firefox, Safari ≥ 16.4. Required APIs: WebGL2, Web Audio with `AudioWorklet`, `EventSource` in Workers, `Worker` modules not required (bundle with esbuild into classic scripts).
- Mobile must work (touch drag to look around; automatic quality tier).
- No backend required in the default configuration (browser connects directly to Wikimedia).

### 3.3 Non-goals (do NOT build)

- User accounts, persistence beyond `localStorage` settings, server database.
- Pre-recorded samples, MIDI export, DAW features.
- Tone.js, React Three Fiber, `@react-three/*`, Zustand in the engine.
- Gyroscope control, WebXR (see stretch goals §17).

---

## 4. Tech stack and dependency policy

| Concern         | Choice                                                                                                        | Notes                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| App shell       | Next.js (App Router), React 19, TypeScript strict, Tailwind CSS 4                                             | Shell only (overlay, HUD, settings). Keep versions already in repo unless a bump is needed. |
| 3D              | `three` (WebGL2) — **imperative**, no R3F                                                                     | Latest stable at implementation time.                                                       |
| Post-processing | `postprocessing` (pmndrs)                                                                                     | Pick the version whose `peerDependencies` match the installed `three`.                      |
| Audio           | **Raw Web Audio API + one `AudioWorklet`**                                                                    | No Tone.js.                                                                                 |
| Workers         | Dedicated Worker (ingest + heartbeat) and AudioWorklet, both bundled by **esbuild** into `public/engine/*.js` | Avoids bundler worker/worklet quirks.                                                       |
| Tests           | `vitest` (unit, node env), `@playwright/test` (e2e, Chromium; Firefox/WebKit smoke)                           |                                                                                             |
| Scripts         | `tsx` to run TypeScript scripts, `esbuild`, `npm-run-all2`                                                    |                                                                                             |
| Lint/format     | Existing ESLint flat config; add `prettier`                                                                   |                                                                                             |

**Dependency policy**

1. Run `npm view <pkg> version` for each package, **pin exact versions** (no `^`, no `~`) in `package.json`, record them in `docs/DECISIONS.md`.
2. Remove from `package.json` everything no longer used: at minimum `tone`, `@react-three/fiber`, `@react-three/drei`, `@react-three/postprocessing`, `zustand` (if present). Audit the rest with `npx depcheck` or manual review.
3. Keep `.tool-versions` Node version (≥ 20). Add `"engines": {"node": ">=20"}`.
4. Package manager: **npm** (a `package-lock.json` exists). Do not switch.

---

## 5. System architecture

### 5.1 Threads and responsibilities

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
│                                           │   orb, sparks, rings, dust, post   │ │
│                                           │   ▲ AudioFeatures (FFT bands)      │ │
│                                           │ React shell (overlay/HUD/settings) │ │
│                                           └────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────┘
```

| Thread        | Owns                                                                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Ingest Worker | Network, parsing, normalization, filtering, sampling, replay/synthetic sources, a 25 ms heartbeat timer (unthrottled in background tabs) |
| Main thread   | Music scheduling, audio graph control, rendering, UI. Only light work; no parsing                                                        |
| AudioWorklet  | Polyphonic event-voice DSP (bell, pluck, sub, gong, thud, tick)                                                                          |

### 5.2 Three clocks (critical)

1. **Audio clock** — `ctx.currentTime` (seconds). Authority for musical time. All note times are expressed on this clock.
2. **Visual clock** — `uTime` shader uniform, seconds since engine start from `performance.now()`. Used only for animation phase.
3. **Wall clock** — event timestamps from Wikimedia; used only for stats and replay timing.

Bridging: a visual event carries the audio time `when` at which its note starts. The renderer fires it when `ctx.currentTime >= when + outputLatency` (§10).

### 5.3 Repository layout (create exactly this; delete old code)

```
sound-of-knowledge/
├─ app/
│  ├─ layout.tsx                # keep Analytics; metadata; fonts
│  ├─ page.tsx                  # renders <Experience/>
│  ├─ globals.css
│  └─ api/wiki-stream/route.ts  # OPTIONAL fallback proxy (§6.6), disabled by default
├─ components/                  # React shell ONLY
│  ├─ experience.tsx            # owns Engine lifecycle (client component)
│  ├─ start-overlay.tsx
│  ├─ hud.tsx
│  ├─ settings-panel.tsx
│  └─ error-banner.tsx
├─ engine/                      # framework-agnostic, no React imports
│  ├─ index.ts                  # Engine class (public API §5.5)
│  ├─ config.ts                 # ALL constants (§1.1.9)
│  ├─ types.ts                  # shared types (§5.6)
│  ├─ bus.ts                    # tiny typed event emitter
│  ├─ ingest/
│  │  ├─ ingest.worker.ts       # worker entry (bundled by esbuild)
│  │  ├─ sse-client.ts          # EventSource + watchdog + backoff
│  │  ├─ normalize.ts           # raw recentchange → NormalizedEdit
│  │  ├─ filters.ts             # source/language/namespace filters
│  │  ├─ sampler.ts             # importance-weighted token-bucket sampler
│  │  ├─ encode.ts              # batch encode/decode (shared with main)
│  │  ├─ synthetic.ts           # deterministic synthetic stream
│  │  ├─ replay.ts              # NDJSON replay source
│  │  ├─ protocol.ts            # worker message types
│  │  └─ ingest-client.ts       # main-thread wrapper around the worker
│  ├─ music/
│  │  ├─ modes.ts               # mode + chord tables
│  │  ├─ harmony.ts             # chord/mode/key state machine
│  │  ├─ pitch.ts               # edit → pitch selection helpers
│  │  ├─ density.ts             # energy tracker + note budget
│  │  ├─ euclid.ts              # Bjorklund algorithm
│  │  ├─ router.ts              # edit → voice type routing
│  │  ├─ scheduler.ts           # step clock, queues, quantisation
│  │  └─ spatial-mapper.ts      # edit → direction/radius (shared A/V)
│  ├─ audio/
│  │  ├─ audio-engine.ts        # graph, FX, panners, listener, trigger()
│  │  ├─ allocator.ts           # PURE voice-slot allocator (§8.5)
│  │  ├─ voice-pool.worklet.ts  # AudioWorkletProcessor entry (bundled)
│  │  ├─ dsp/                   # PURE DSP classes (no Web Audio globals)
│  │  │  ├─ bell.ts  pluck.ts  sub.ts  gong.ts  thud.ts  tick.ts
│  │  │  └─ voice.ts            # Voice interface + shared helpers
│  │  ├─ pad-layer.ts           # chord pad, drone, air noise
│  │  ├─ fx-chain.ts            # reverb, delay, ducking, master limiter
│  │  ├─ reverb-ir.ts           # procedural impulse response
│  │  └─ analyzer.ts            # FFT → AudioFeatures
│  ├─ visual/
│  │  ├─ renderer.ts            # renderer, loop, resize, DPR
│  │  ├─ camera-rig.ts          # orbit/drift/trauma/drag
│  │  ├─ palette.ts             # mode+key → OKLCH palette → linear RGB
│  │  ├─ orb.ts                 # core orb mesh + impacts
│  │  ├─ sparks.ts              # GPU-stateless particle system
│  │  ├─ rings.ts               # shockwave rings
│  │  ├─ dust.ts                # ambient dust field
│  │  ├─ post.ts                # postprocessing stack
│  │  ├─ labels.ts              # DOM label pool + ticker feed
│  │  ├─ governor.ts            # dynamic resolution + tier degradation
│  │  ├─ visual-queue.ts        # time-ordered queue → fires at heard-time
│  │  └─ shaders/*.ts           # GLSL as template strings
│  └─ util/
│     ├─ hash.ts  math.ts  random.ts  oklch.ts  ring-buffer.ts  perf.ts
├─ scripts/
│  ├─ build-workers.mjs         # esbuild → public/engine/*.js (+ --watch)
│  ├─ gen-synthetic.ts          # writes a synthetic NDJSON for tests/replay
│  ├─ record-stream.ts          # records N seconds of live stream (needs network)
│  └─ render-audio.ts           # Playwright-driven offline render + report (§13.3)
├─ tests/
│  ├─ unit/                     # vitest
│  ├─ e2e/                      # playwright
│  └─ fixtures/                 # recentchange JSON samples, replay ndjson
├─ public/
│  ├─ engine/                   # BUILT worker/worklet bundles (gitignored)
│  ├─ replay/sample.ndjson      # bundled replay recording (small, ≤ 300 KB)
│  └─ og.png
├─ docs/  (PROGRESS.md DECISIONS.md ARCHITECTURE.md TUNING.md HUMAN-CHECKLIST.md)
├─ .github/workflows/ci.yml
└─ (config files: next.config.ts, vercel.json, tsconfig.json, eslint.config.mjs, vitest.config.ts, playwright.config.ts)
```

### 5.4 Build pipeline for worker and worklet

- `scripts/build-workers.mjs` uses esbuild to bundle `engine/ingest/ingest.worker.ts` → `public/engine/ingest.worker.js` and `engine/audio/voice-pool.worklet.ts` → `public/engine/voice-pool.worklet.js` (format `iife`, target `es2020`, minified in production, sourcemaps in dev).
- `package.json` scripts: `predev` and `prebuild` run the build once; `dev` runs `build-workers.mjs --watch` in parallel with `next dev` (via `npm-run-all2`).
- Load at runtime: `new Worker('/engine/ingest.worker.js')` and `ctx.audioWorklet.addModule('/engine/voice-pool.worklet.js')`.
- `public/engine/` is in `.gitignore` (built artefact). Vercel runs `npm run build`, which runs `prebuild`.

### 5.5 Engine public API (`engine/index.ts`)

```ts
export interface EngineOptions {
  container: HTMLElement; // canvas + label layer mount point
  settings: Settings; // initial settings (§11.3)
  debug?: boolean; // from ?debug=1
}

export class Engine {
  /** Creates renderer + warms shaders. Does NOT create AudioContext (needs a user gesture). */
  static create(opts: EngineOptions): Promise<Engine>;
  /** MUST be called from a user-gesture handler. Creates AudioContext, loads worklet, starts ingest + scheduler. */
  start(): Promise<void>;
  setSettings(patch: Partial<Settings>): void;
  on<K extends keyof EngineEvents>(ev: K, fn: (p: EngineEvents[K]) => void): () => void; // returns unsubscribe
  screenshot(): Promise<Blob>;
  resumeAudio(): Promise<void>; // calls ctx.resume(); used by the "Resume audio" HUD button (§8.2)
  injectEdits(edits: NormalizedEdit[]): void; // DEBUG ONLY (?debug=1): feeds the EventHub as if from the stream (tests, §13.4)
  getMetrics(): Readonly<Metrics>; // also exposed as window.__sok when debug
  dispose(): void; // stops worker, closes AudioContext, frees GL resources, removes listeners
}

export interface Metrics {
  // all numbers; updated in place, read by tests and the debug overlay
  fps: number;
  frameMsEma: number;
  frameMsP95: number;
  renderScale: number;
  tier: Tier;
  level: number;
  acceptedTotal: number;
  droppedTotal: number;
  notesScheduled: number;
  droppedNotes: number;
  attemptedNotes: number;
  activeVoices: number;
  visualQueueLen: number;
  audioState: AudioContextState | "none";
  mode: ModeId;
  keyName: string;
  energy: number;
  muted: boolean;
  streamState: string;
}

export interface EngineEvents {
  status: { stream: "connecting" | "live" | "reconnecting" | "replay" | "error"; detail?: string };
  stats: {
    eps: number;
    accepted: number;
    dropped: number;
    botRatio: number;
    revertRatio: number;
    energy: number;
    mode: ModeId;
    keyName: string;
    fps: number;
    tier: Tier;
  }; // emitted at 4 Hz
  notable: { edit: NormalizedEdit }; // for ticker (throttled)
  error: { code: "webgl" | "audio" | "worklet" | "stream" | "unknown"; message: string };
}
```

### 5.6 Core shared types (`engine/types.ts`)

```ts
export type Vec3 = { x: number; y: number; z: number };
export type EditKind = "edit" | "new" | "revert";
export type Actor = "bot" | "anon" | "registered";
export type ProjectId =
  | "wikipedia"
  | "wiktionary"
  | "wikisource"
  | "wikibooks"
  | "wikiquote"
  | "wikinews"
  | "wikiversity"
  | "wikivoyage"
  | "wikidata"
  | "commons"
  | "meta"
  | "other";
export type ModeId = "lydian" | "mixolydian" | "dorian" | "aeolian";
export type Tier = "low" | "medium" | "high";
export type VoiceType = "bell" | "pluck" | "sub" | "gong" | "thud" | "tick";

export interface NormalizedEdit {
  id: number; // recentchange id
  ts: number; // event time, unix ms
  wiki: string; // 'enwiki'
  host: string; // 'en.wikipedia.org'
  lang: string; // 'en' | 'wikidata' | 'commons' | 'meta' | ...
  project: ProjectId;
  ns: number; // MediaWiki namespace id (0 = article)
  title: string; // display title: underscores → spaces, truncated to 80 chars
  actor: Actor;
  kind: EditKind;
  minor: boolean;
  delta: number; // signed byte delta
  absDelta: number;
  magnitude: number; // 0..1  (§6.2)
  importance: number; // 0..1  (§6.2)
  revNew: number; // 0 if unknown
}
// NOTE: usernames/IPs are NEVER part of NormalizedEdit (§14.2).

export interface NoteEvent {
  when: number; // AudioContext time (s) the note starts
  voice: VoiceType;
  midi: number; // 0 for unpitched voices
  freq: number; // Hz (0 for unpitched)
  vel: number; // 0..1
  dir: Vec3; // unit direction from core (shared with visuals)
  radius: number; // distance from core
  edit: NormalizedEdit;
  flavor: "add" | "remove" | "large" | "revert" | "new" | "bot-thud" | "bot-tick";
  visual: boolean; // false for arpeggio notes after the first
}

export interface AudioFeatures {
  // smoothed 0..1, written in place each frame
  rms: number;
  sub: number;
  bass: number;
  mid: number;
  high: number;
  air: number;
  flux: number;
}
```

---

## 6. Data layer specification

### 6.1 Source

- Endpoint: `https://stream.wikimedia.org/v2/stream/recentchange` (Server-Sent Events, one JSON object per `data:` line).
- Relevant raw fields (shape; **verify against live data in task T1.1**):

```json
{
  "id": 1234567890,
  "type": "edit", // 'edit' | 'new' | 'log' | 'categorize' | 'external'
  "namespace": 0,
  "title": "Albert Einstein",
  "comment": "/* Early life */ fix typo",
  "timestamp": 1790000000, // unix seconds
  "user": "ExampleUser", // NEVER stored/shown beyond actor classification
  "bot": false,
  "minor": true,
  "length": { "old": 10234, "new": 10301 }, // for 'new', 'old' may be absent
  "revision": { "old": 111, "new": 112 },
  "server_name": "en.wikipedia.org",
  "wiki": "enwiki",
  "parsedcomment": "..."
}
```

- **CORS:** Wikimedia EventStreams normally sends permissive CORS headers, so the browser connects directly. Task T1.1 must verify with `curl -sI -H "Origin: https://example.com" https://stream.wikimedia.org/v2/stream/recentchange` and confirm `access-control-allow-origin`. If it is absent, enable the proxy fallback (§6.6).
- Typical raw throughput can reach hundreds of events/s when Wikidata is included; Wikipedias-only is far lower. The pipeline must be correct from 0 to 500 events/s.

### 6.2 Normalization (`normalize.ts`) — pure functions, fully unit-tested

Input: parsed raw object (`unknown`). Output: `NormalizedEdit | null`. Never throw; malformed → `null` and increment a `parseErrors` counter.

Rules, in order:

1. Accept only `type === 'edit'` or `'new'`. Others → `null`.
2. Require `typeof id === 'number'`, non-empty `title`, `server_name`, `wiki`, and `length.new` numeric. For `edit`, require `length.old` numeric. For `new`, treat missing `length.old` as 0.
3. `delta = length.new - (length.old ?? 0)`; `absDelta = Math.abs(delta)`.
4. **Actor:**
   - `bot === true` → `'bot'`.
   - else `'anon'` if `user` matches IPv4 `^\d{1,3}(\.\d{1,3}){3}$`, or IPv6-like (`/^[0-9a-f:]+$/i` with ≥ 2 colons), or starts with `~` (MediaWiki _temporary accounts_, which replaced raw IPs for logged-out editors).
   - else `'registered'`.
   - Then discard `user`.
5. **Kind:** `'new'` if `type === 'new'`; else `'revert'` if `isRevert(comment)`; else `'edit'`.
6. `isRevert(comment)` is a **heuristic** (recentchange carries no revert flag). Case-insensitive regex list, configurable in `config.ts`:
   `^Reverted\b`, `^Revert(ed)?\b`, `^Undid revision`, `^Undo\b`, `\bmw-rollback\b`, `^Rollback`, plus a few localized prefixes (es `^Revertidos?`, de `rückgängig`, fr `^Révocation|^Annulation`, it `^Annullata|^Ripristino`, pt `^Revertido|^Desfeita`, ru `^Откат|^Отмена`). Document in `DECISIONS.md` that detection is best-effort.
7. **Host parsing:** `server_name` against `^([a-z0-9-]+)\.(wikipedia|wiktionary|wikisource|wikibooks|wikiquote|wikinews|wikiversity|wikivoyage)\.org$` → `lang = $1`, `project = $2`. `www.wikidata.org` → lang `'wikidata'`, project `'wikidata'`. `commons.wikimedia.org` → `'commons'`. `meta.wikimedia.org` → `'meta'`. Anything else → lang `'other'`, project `'other'`.
8. **Title:** replace `_` with space; truncate to 80 chars with `…`.
9. **Magnitude:** `magnitude = clamp(log2(1 + absDelta) / 14, 0, 1)` (≈ 16 KB change → 1.0; 1 byte ≈ 0.07; 100 bytes ≈ 0.48).
10. **Importance:**
    `importance = clamp(0.15 + 0.60*magnitude + (kind==='new' ? 0.35 : 0) + (kind==='revert' ? 0.30 : 0) + (ns===0 ? 0.10 : 0) - (actor==='bot' ? 0.15 : 0), 0, 1)`.
11. Event timestamp: `ts = timestamp * 1000` (fallback `Date.now()`).

### 6.3 Filters (`filters.ts`)

User-controlled via `Settings` (§11.3), pushed to the worker with a `config` message. A pure function `passes(edit, cfg): boolean`:

- `source`:
  - `'wikipedias'` (**default**): `project === 'wikipedia'`.
  - `'no-wikidata'`: everything except `lang === 'wikidata'`.
  - `'all'`: everything.
- `langs`: if non-empty, `edit.lang` must be in the list (only meaningful for Wikipedia-family projects).
- `namespaces`: `'main'` (**default**: `ns === 0`) or `'all'`.
- Dedupe: ring-buffer `Set` of the last 2 000 event ids; duplicates dropped (reconnect with `Last-Event-ID` may redeliver).

### 6.4 Sampler and batcher (`sampler.ts`)

Goal: cap the number of _musical/visual_ events/s regardless of input rate while keeping texture. **Statistics always count all accepted (post-filter) events**, so energy and rates are truthful.

- Window = `BATCH_INTERVAL_MS` (50 ms). At each window flush, candidate events collected during the window are considered.
- **Token bucket:** `tokens += maxPerSec * dtSec`, capped at `maxPerSec * 0.5`. `maxPerSec` comes from the quality tier (§12): 40 / 28 / 16. Budget this window = `floor(tokens)`; spend what is used.
- Selection when candidates > budget:
  1. Reserve 25 % of the budget (min 1 if budget ≥ 1) for **uniformly random** picks from the candidates (keeps small-edit texture).
  2. Fill the rest by **descending importance**, ties broken randomly.
  3. Unselected events are counted as `dropped`.
- Carry-over: unselected candidates are discarded, not queued (stale events sound wrong).

### 6.5 Transport encoding (`encode.ts`)

Worker → main batch message:

```ts
type BatchMsg = {
  t: "batch";
  n: number; // events in batch
  num: Float64Array; // n * STRIDE, transferred (not copied)
  titles: string[]; // length n
  hosts: string[]; // length n  (server_name)
};
export const STRIDE = 11;
// field offsets in `num`:
// 0 id | 1 tsMs | 2 ns | 3 kind (0 edit,1 new,2 revert) | 4 actor (0 registered,1 anon,2 bot)
// 5 minor (0/1) | 6 delta | 7 magnitude | 8 importance | 9 projectCode | 10 revNew
```

`projectCode` is an index into a shared `PROJECTS` array in `config.ts`. `lang` and `wiki` are re-derived on the main side from `host` with the same function used in the worker (`parseHost`), exported from `normalize.ts`. `decodeBatch()` creates `NormalizedEdit` objects (allowed: ≤ ~100/s).

Other messages:

```ts
type WorkerIn =
  { t: "start"; cfg: IngestConfig } | { t: "config"; cfg: Partial<IngestConfig> } | { t: "stop" };
type WorkerOut =
  | BatchMsg
  | {
      t: "stats";
      seen: number;
      accepted: number;
      dropped: number;
      parseErrors: number;
      botAccepted: number;
      revertAccepted: number;
      windowMs: number;
    } // every 500 ms
  | {
      t: "status";
      state: "connecting" | "live" | "reconnecting" | "replay" | "error";
      detail?: string;
    }
  | { t: "tick" }; // heartbeat every 25 ms (see §7.7)
interface IngestConfig {
  mode: "live" | "replay" | "synthetic";
  streamUrl: string;
  replayUrl: string;
  seed: number;
  source: "wikipedias" | "no-wikidata" | "all";
  langs: string[];
  namespaces: "main" | "all";
  maxPerSec: number;
  batchIntervalMs: number;
}
```

### 6.6 Connection management (`sse-client.ts`)

- Use `EventSource` **inside the worker**.
- **Watchdog:** if no message (including SSE comments/keepalives surfaced as events, or `open`) for `STREAM_WATCHDOG_MS = 20000`, close and reconnect.
- **Backoff:** on error/close, reconnect after `1s, 2s, 4s, 8s, 15s, 30s` (cap 30 s), each with ±20 % jitter; reset to 1 s after 30 s of healthy streaming.
- **Fallback to replay:** after 3 consecutive failed connection attempts within 60 s, switch the worker's source to `replay` (status `replay`, `detail: 'Stream unavailable — replaying a recording'`) and keep retrying live every 30 s in the background; when live succeeds, stop replay and switch back.
- Status messages are sent on each state change.
- **Optional proxy fallback (only if CORS check fails in T1.1):** implement `app/api/wiki-stream/route.ts` as a streaming pass-through (`Response` with the upstream body, `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`), enabled by `NEXT_PUBLIC_STREAM_MODE=proxy` (default `direct`). `streamUrl` is chosen accordingly. Keep `vercel.json` streaming config only if the proxy is enabled.

### 6.7 Replay and synthetic sources

Both produce `NormalizedEdit`s, then follow the same filter → sampler → batch path (so tests exercise the real pipeline).

**Replay (`replay.ts`):** reads `public/replay/sample.ndjson`; each line `{"dt": <ms since previous>, "e": <NormalizedEdit-without-id-dedupe fields>}`. Loops forever; assigns fresh monotonically increasing ids each loop so dedupe doesn't drop them. `scripts/record-stream.ts` records ~3 minutes of live Wikipedias-only data (needs network) into that format. If recording is impossible, generate the sample with the synthetic generator (and log it in `DECISIONS.md`).

**Synthetic (`synthetic.ts`)** — deterministic given a seed (mulberry32 PRNG). Model:

- Arrival rate `r(t) = base * (1 + 0.6*sin(2π t / 90))`, `base = 14` events/s, plus bursts: each second, 2 % chance of a burst of 20–60 extra events spread over 3 s.
- Language distribution: Zipf (s = 1.1) over 30 languages `['en','de','fr','es','ru','ja','it','zh','pt','ar','pl','nl','sv','uk','vi','ko','fa','id','tr','cs','he','hu','fi','ca','no','th','ro','el','bg','da']`.
- Actor: 20 % bot, 22 % anon, 58 % registered. Kind: 3 % revert, 3 % new, rest edit.
- `delta`: sign positive 62 %; `absDelta` log-normal with μ = ln(80), σ = 1.6 (clamp 1…60 000). Reverts negative-biased (70 % negative).
- Titles: from a built-in list of ~200 plausible article titles (deterministic pick by PRNG).

### 6.8 Main-thread wrapper (`ingest-client.ts`)

- Creates the worker, forwards `config`, decodes `batch` messages, emits to listeners: `onBatch(edits: NormalizedEdit[])`, `onStats`, `onStatus`, `onTick`.
- On `document.visibilitychange`, nothing special for ingest (keep running).
- `dispose()` sends `stop`, then `terminate()`.

---

## 7. Music system specification

### 7.1 Global musical constants (`config.ts`)

| Constant           | Value                                                       |
| ------------------ | ----------------------------------------------------------- |
| `BPM`              | 68                                                          |
| Meter              | 4/4, grid = 16 steps per bar                                |
| `STEP_SEC`         | `60 / BPM / 4` ≈ 0.2206 s                                   |
| `LOOKAHEAD_SEC`    | 0.15 (foreground), 1.25 (when `document.hidden`)            |
| `TICK_SEC`         | 0.025 (worker heartbeat)                                    |
| `HUMANIZE_SEC`     | ±0.006 uniform random on melodic notes (never on bass/gong) |
| Chord length       | 4 bars (≈ 14.1 s)                                           |
| Phrase length      | 8 bars (mode may change at phrase boundaries)               |
| Key change cadence | every 32 bars (≈ 113 s)                                     |
| `EPS_REF`          | 60 (calibrated in T1.1; see §7.3)                           |
| `BOT_REF`          | 8 bot edits/s                                               |

### 7.2 Modes and chords (`modes.ts`) — use these tables verbatim

Offsets are semitones above the key root (stacked, may exceed 12). First element is the chord's bass note. Every chord pitch class must be inside the mode's scale (unit-tested).

```ts
export const MODES: Record<ModeId, ModeDef> = {
  lydian: {
    scale: [0, 2, 4, 6, 7, 9, 11],
    chords: [
      { name: "Imaj9#11", offsets: [0, 7, 11, 14, 18], tonic: true },
      { name: "II", offsets: [2, 9, 14, 18, 21], tonic: false },
      { name: "iii7", offsets: [4, 11, 14, 19], tonic: false },
      { name: "Vmaj7", offsets: [7, 14, 19, 23], tonic: false },
      { name: "vi7", offsets: [9, 16, 19, 24], tonic: false },
    ],
  },
  mixolydian: {
    scale: [0, 2, 4, 5, 7, 9, 10],
    chords: [
      { name: "I9sus4", offsets: [0, 7, 10, 14, 17], tonic: true },
      { name: "ii7", offsets: [2, 9, 12, 17], tonic: false },
      { name: "IVmaj9", offsets: [5, 9, 12, 16, 19], tonic: false },
      { name: "v7", offsets: [7, 14, 17, 22], tonic: false },
      { name: "bVIImaj7", offsets: [10, 14, 17, 21], tonic: false },
    ],
  },
  dorian: {
    scale: [0, 2, 3, 5, 7, 9, 10],
    chords: [
      { name: "i9", offsets: [0, 3, 7, 10, 14], tonic: true },
      { name: "ii", offsets: [2, 5, 9, 12], tonic: false },
      { name: "IV7", offsets: [5, 9, 12, 15], tonic: false },
      { name: "v7", offsets: [7, 10, 14, 17], tonic: false },
      { name: "bVIImaj7", offsets: [10, 14, 17, 21], tonic: false },
    ],
  },
  aeolian: {
    scale: [0, 2, 3, 5, 7, 8, 10],
    chords: [
      { name: "i7add9", offsets: [0, 3, 7, 10, 14], tonic: true },
      { name: "bIIImaj7", offsets: [3, 7, 10, 14], tonic: false },
      { name: "bVImaj7", offsets: [8, 12, 15, 19], tonic: false },
      { name: "iv7", offsets: [5, 8, 12, 15], tonic: false },
      { name: "bVIIadd9", offsets: [10, 14, 17, 24], tonic: false },
    ],
  },
};
```

### 7.3 Energy (`density.ts`)

- `eps` = exponential moving average of `accepted/sec` from worker stats, time constant 6 s.
- `E = clamp(log10(1 + eps) / log10(1 + EPS_REF), 0, 1)` — the **global energy** in [0,1].
- In T1.1 measure real post-filter throughput for 60 s (Wikipedias-only) and set `EPS_REF ≈ 1.5 × p95(eps)`; record in `DECISIONS.md`. Until measured, use 60.
- `botNorm = clamp(emaBotPerSec / BOT_REF, 0, 1)` (same EMA).
- **Melodic note budget:** `targetNotesPerSec = lerp(1.2, 6.0, E) * densityMul`, `densityMul` = 0.6 / 1.0 / 1.5 for `sparse/normal/dense`.

### 7.4 Harmony state machine (`harmony.ts`)

State: `{ rootPc: 0..11, mode: ModeId, chordIdx, barCounter }`. Initial: `rootPc = 0 (C)`, `mode = 'dorian'`, `chordIdx = 0`.

- **Absolute root MIDI:** `rootMidi = 48 + rootPc` (C3 = 48).
- **Chord change** every 4 bars at `stepInBar === 0`: from the current mode's chord list, choose next chord:
  - if current is tonic → uniform among non-tonic chords;
  - else → 45 % tonic, 55 % uniform among the remaining non-tonic chords other than the current one.
  - Never the same chord twice in a row.
- **Mode change** evaluated only at phrase boundaries (`barCounter % 8 === 0`): `modeForEnergy(E, current)`:
  - boundaries: `E < 0.22` aeolian; `< 0.45` dorian; `< 0.70` mixolydian; else lydian.
  - hysteresis: keep the current mode if `E` is within ±0.04 of the boundary separating it from the candidate mode.
  - On mode change, `chordIdx` resets to the tonic of the new mode.
- **Key change** at `barCounter % 32 === 0` (not at bar 0 of the session): `rootPc += choose({+7:0.40, +5:0.40, +2:0.10, -3:0.10}) mod 12`.
- Each state change emits `HarmonyEvent { kind:'chord'|'mode'|'key', at: audioTime, state }` consumed by pad layer (§8.8) and palette (§9.3).
- **Voicing helpers (`pitch.ts`):**
  - `chordMidi(state): number[]` = `offsets.map(o => rootMidi + o)`.
  - `chordTonesInRange(state, lo, hi): number[]` = all pitches whose pitch class is in the chord, within `[lo, hi]` MIDI, ascending, deduped.
  - `padVoicing(state): number[]` = chord pitches folded by octaves into `[52, 79]`, deduped, max 5.

### 7.5 Routing (`router.ts`)

`route(edit): RoutedKind` in this priority order:

1. `edit.kind === 'new'` → `'birth'` (4-note arpeggio, §7.6).
2. `edit.kind === 'revert'` → `'gong'`.
3. `edit.actor === 'bot'` → `'bot'` (fuel for the percussion gate, §7.8).
4. `edit.magnitude >= 0.60` → `'sub'` (deep swell; additionally 35 % chance to also play a bell/pluck with the normal mapping).
5. `edit.delta > 0` → `'pluck'` (additions: warm).
6. otherwise → `'bell'` (removals: cool glass).

Velocity: `vel = clamp(0.30 + 0.50*magnitude + (edit.minor ? -0.10 : 0) + (actor==='anon' ? 0.05 : 0), 0.15, 0.90)`.

### 7.6 Pitch selection

- **Bell (removal):** candidates = `chordTonesInRange(state, 76, 100)`; **pitch index** `i = clamp(round((1 - magnitude) * (N-1) + gaussian(0, 0.8)), 0, N-1)` — small edits are higher.
- **Pluck (addition):** candidates = `chordTonesInRange(state, 64, 88)`; same index formula.
- **Sub (large edit):** pitch = chord **bass** pitch class placed in MIDI `[28, 40]` (choose the pitch in range).
- **Gong (revert):** pitch = **key root** pitch class in MIDI `[36, 48]`.
- **Birth arpeggio:** 4 notes at successive 1/16 steps: chord tones in `[64, 88]`, ascending, starting from index `floor(N*0.2)`, taking every second tone (wrap/clamp). First note has `visual: true`; the other three `visual: false`. Each pluck velocity `vel*(1, .9, .8, .7)`.
- **Thud/tick:** unpitched (`midi = 0`).
- `freq = 440 * 2^((midi - 69) / 12)`.

### 7.7 Scheduler (`scheduler.ts`)

Driven by the worker's 25 ms `tick` messages (not `setInterval` on the main thread, which is throttled in background tabs).

**State:** `nextStepTime` (audio time of the next step), `stepIndex`, queues, cooldown timestamps, current patterns.

**Queues** (bounded; oldest dropped; items older than 4 s dropped): `melodicQ` (pluck/bell), `subQ`, `gongQ`, `birthQ`, `botQ`.

**Algorithm (pseudo-code; implement exactly this structure):**

```ts
onTick() {
  const now = ctx.currentTime;
  const lookahead = document.hidden ? 1.25 : 0.15;
  if (nextStepTime < now) nextStepTime = now + 0.05;        // recover after a stall
  while (nextStepTime < now + lookahead) {
    scheduleStep(stepIndex, nextStepTime);
    nextStepTime += STEP_SEC; stepIndex++;
  }
}

scheduleStep(k, T) {
  const stepInBar = k % 16, bar = (k / 16) | 0;
  if (stepInBar === 0) harmony.onBar(bar, E, T);             // may emit chord/mode/key events
  if (stepInBar === 0 && bar % 8 === 0) rebuildPercPatterns(); // §7.8

  // 1. Melodic gate (every step)
  let budget = (E < 0.3 ? 1 : 2);
  const p = clamp(targetNotesPerSec * STEP_SEC, 0, 1);
  while (budget > 0 && melodicQ.length && rng() < p) {
    const e = pickBest(melodicQ, /*lookAt*/ 8);              // max(importance + 0.1*ageSec)
    emitMelodic(e, T + humanize()); budget--;
  }
  // 2. Beat-aligned voices
  if (stepInBar % 4 === 0) {
    if (subQ.length && subThisBar < 2 && activeSubs() < 3) emitSub(subQ.pop(), T);
    if (gongQ.length && now >= gongCooldownUntil && activeGongs() < 2) { emitGong(gongQ.pop(), T); gongCooldownUntil = T + 1.2; }
  }
  // 3. Birth (on even steps)
  if (stepInBar % 2 === 0 && birthQ.length && T >= birthCooldownUntil) { emitBirth(birthQ.pop(), T); birthCooldownUntil = T + 1.5; }
  // 4. Percussion gate with data fuel (§7.8)
  if (thudPattern[stepInBar] && botQ.length) emitThud(botQ.shift(), T);
  else if (tickPattern[stepInBar] && botQ.length) emitTick(botQ.shift(), T);
}
```

`emitX` builds a `NoteEvent` (§5.6) including the spatial position from `spatial-mapper`, calls `audio.trigger(note)` (allocates a voice slot and posts a message to the worklet, §8.5) and `visualQueue.push(note)` (if `visual`). If allocation fails for a low-importance note, drop it silently (count `droppedNotes` in metrics).

**Event intake:** `onBatch(edits)` routes each edit with `router.route` and pushes into the proper queue. Records stats for energy tracking.

### 7.8 Percussion gate ("Euclidean gate + data fuel")

- Patterns are 16-step boolean arrays regenerated every phrase and whenever `botNorm` changes by > 0.15.
- `kThud = round(lerp(2, 6, botNorm))`, `kTick = round(lerp(3, 11, botNorm))`.
- `thudPattern = rotate(euclid(kThud, 16), (phraseIndex * 3) % 16)`.
- `tickPattern = rotate(euclid(kTick, 16), (phraseIndex * 5 + 2) % 16)` with steps already used by the thud pattern cleared.
- Euclid: standard Bjorklund; implement `euclid(k, n): boolean[]` with unit tests for `(3,8)`, `(5,8)`, `(4,16)`, `(7,16)`.
- A pattern step only sounds if there is a bot edit available in `botQ` ("fuel"). No fuel → silence for that step. Each bot edit sounds at most once; bot edits older than 4 s are discarded.
- Velocity: thud `0.45 + 0.35*botNorm`; tick `0.20 + 0.20*botNorm`.

### 7.9 Spatial mapper (`spatial-mapper.ts`)

Deterministic, shared by audio and visuals so a sound comes from where its comet starts.

- **Language homes:** precompute 64 unit vectors using a Fibonacci sphere (`golden angle = π(3 − √5)`). `homeIndex = fnv1a(edit.wiki) % 64`.
- **Jitter:** from `fnv1a(edit.title + ':' + edit.id)` derive three uniform numbers; gaussian-ish via sum of 3 uniforms; perturb the home direction by an angle with σ ≈ 0.30 rad in a random tangent direction; renormalise.
- **Radius:** `7 + 6 * u` (u from the hash), i.e. 7…13 units.
- Output `{ dir: Vec3, radius: number }` (no allocation: write into a caller-provided `Vec3`).

---

## 8. Audio engine specification

### 8.1 Design summary

- Event voices (bell, pluck, sub, gong, thud, tick) run in **one AudioWorklet** with a fixed pool of voices. No Web Audio node is created per note (zero GC pressure, sample-accurate start).
- Each voice slot has its **own mono output**, routed to its own `PannerNode` (HRTF) so every sound is positioned in 3D where its visual comet starts.
- Continuous layers (chord pad, drone, air noise) use native nodes with long-lived oscillators and smooth cross-fades.
- Master chain: bus compressor → soft clipper → master gain. A tap before the master gain feeds the analyser (so muting does not blank the visuals).
- The audio engine takes a `BaseAudioContext`, so the identical graph runs in an `OfflineAudioContext` for automated verification (§13.3).

### 8.2 AudioContext

- `new AudioContext({ latencyHint: 'playback' })` (stability over minimum latency). Create it only inside `Engine.start()` (user gesture). Call `await ctx.resume()`.
- Listen to `ctx.onstatechange`. If state becomes `'suspended'` or `'interrupted'` after start (tab/phone interruptions), emit `error{code:'audio', message:'Audio paused — tap to resume'}`; the HUD shows a **Resume audio** button which calls `engine.resumeAudio()` (add this method to the `Engine` API: it calls `ctx.resume()`).
- `outputLatency` for A/V sync: `const lat = (ctx as any).outputLatency ?? ctx.baseLatency ?? 0` (feature-detect; type it properly).

### 8.3 Signal graph

```
Worklet 'sok-voice-pool' (N mono outputs, N = voice budget §8.12)
   out[i] ──► Panner[i] (HRTF | equalpower) ──► voiceBus (Gain 1.0)
voiceBus ──► mixBus                                   (dry)
voiceBus ──► reverbSend (Gain 0.30) ──► Convolver ──► reverbReturn (Gain 1.0) ──► mixBus
voiceBus ──► delaySend  (Gain 0.12) ──► PingPongDelay ───────────────────────────► mixBus

PadLayer.out ──► padDuck (Gain, ducked by sub/gong) ──► padBus (Gain 1.0)
padBus ──► mixBus
padBus ──► padReverbSend (Gain 0.45) ──► Convolver
Drone ──► mixBus      Air ──► mixBus  and  Air ──► padReverbSend

mixBus ──► Compressor ──► SoftClip(WaveShaper) ──► limitedBus ──► analyserTap (AnalyserNode, no output use)
                                                       └──► masterGain ──► ctx.destination
```

### 8.4 Mixing targets (verified by the offline report, §13.3)

Starting gains are given in each section; **tune them** with the offline render loop until all of these hold for a 120 s synthetic render at steady `E ≈ 0.6`:

- Peak ≤ **−1.0 dBFS**; zero samples with `|x| ≥ 0.999`; no `NaN/Infinity`.
- Integrated RMS (both channels) between **−24 and −16 dBFS**.
- Crest factor (peak − RMS) between **10 and 22 dB**.
- Spectral power share (FFT of the mix): 20–80 Hz **8–30 %**; 80–250 Hz **10–30 %**; 250 Hz–2 kHz **25–50 %**; 2–8 kHz **5–25 %**; > 8 kHz **≤ 8 %**.
- Stress at `E ≈ 0.9` (synthetic rate ×3): `droppedNotes / attemptedNotes ≤ 0.35`; max concurrent voices ≤ budget; no clipping.

### 8.5 Voice pool, messages, allocator

**Worklet creation:**

```ts
new AudioWorkletNode(ctx, "sok-voice-pool", {
  numberOfInputs: 0,
  numberOfOutputs: voices, // 16 / 12 / 8 by tier
  outputChannelCount: Array(voices).fill(1),
  processorOptions: { voices },
});
```

**Messages (main → worklet), all times in AudioContext seconds:**

```ts
type VoiceKind = 0 | 1 | 2 | 3 | 4 | 5; // 0 bell,1 pluck,2 sub,3 gong,4 thud,5 tick
type ToWorklet =
  | {
      t: "on";
      slot: number;
      kind: VoiceKind;
      when: number;
      freq: number;
      vel: number;
      dur: number;
      p: number[];
    }
  | { t: "kill"; slot: number; when: number } // fade out over 30 ms ending at `when`
  | { t: "sync" }; // worklet replies { t:'synced' } (used by offline harness)
```

Worklet → main: `{ t:'synced' }`, and in debug mode `{ t:'stats', active:number }` every 250 ms.

**Processor requirements (`voice-pool.worklet.ts`):**

- Per slot: one preallocated instance of each voice class (6 × N objects) and a small preallocated pending queue (capacity 8) of note specs ordered by start time. Messages are handled in `port.onmessage` (allocation allowed there, not in `process`).
- `startFrame = max(currentFrame, round(when * sampleRate))` (a note that arrives late starts immediately instead of being dropped).
- In `process(inputs, outputs)`: for each slot, activate the head of its pending queue when `startFrame < currentFrame + 128`; for each of the 128 frames, if the slot's active voice has started, `outputs[slot][0][i] = voice.sample(t)`; finished voices free their slot. Return `true` always. No allocations, no `Array` methods, no closures inside `process`.
- `kill`: sets the active voice's `dur` so that a 30 ms linear fade ends at the requested frame.

**Allocator (main thread, `audio-engine.ts`):**

```ts
interface Slot { endTime: number; kind: VoiceKind; priority: number }   // endTime = when + dur
allocate(kind, when, dur, importance): number /* slot or -1 */ {
  // 1. caps: gong ≤ 2 concurrently, sub ≤ 3 concurrently (count slots with same kind and endTime > when) → else -1
  // 2. first slot with endTime <= when  → use it
  // 3. else steal: candidate = slot with lowest priority; if candidate.priority < newPriority → send {t:'kill'} and reuse; else -1
}
priority = importance + { gong: 0.6, sub: 0.4, bell: 0.1, pluck: 0.1, thud: 0, tick: 0 }[kind]
```

Because voice durations are deterministic (below), the main thread knows `endTime` without feedback from the worklet.

### 8.6 DSP voices (`engine/audio/dsp/*.ts`) — pure classes, no Web Audio globals

Common base (`voice.ts`):

```ts
abstract class Voice {
  active = false;
  startFrame = 0;
  dur = 0;
  vel = 0;
  freq = 0;
  /** one-time per trigger */ abstract onStart(
    freq: number,
    vel: number,
    dur: number,
    p: Float64Array,
    seed: number,
  ): void;
  /** raw voice sample at time t seconds since start; dt = 1/sampleRate */ protected abstract next(
    t: number,
    dt: number,
  ): number;
  /** applies 3 ms fade-in, 30 ms fade-out before `dur`, vel, and ends the voice */
  sample(t: number, dt: number): number {
    if (t >= this.dur) {
      this.active = false;
      return 0;
    }
    const fin = Math.min(1, t / 0.003),
      fout = Math.min(1, (this.dur - t) / 0.03);
    return this.next(t, dt) * fin * fout * this.vel;
  }
}
```

Per-voice phase accumulators advance in `next` (`ph += TWO_PI * f * dt`; wrap with `if (ph > TWO_PI) ph -= TWO_PI`). Noise uses a per-voice xorshift32 seeded from `seed`. `VOICE_GAIN` constants live in `config.ts`.

**Bell (FM)** — `p = [ratio, I0, tauA, tauI]`, gain `0.30`

```
y = exp(-t/tauA) * sin(phC + I0 * exp(-t/tauI) * sin(phM)),  phM advances at freq*ratio
ratio = [3.5, 3.99, 2.76][edit.id % 3]
pitchNorm = clamp((midi - 76) / 24, 0, 1)
tauA = lerp(1.2, 0.5, pitchNorm);  tauI = 0.35 * tauA;  I0 = lerp(1.2, 4.0, 1 - magnitude)
dur = 5 * tauA
```

**Pluck (additive, kalimba/harp-like)** — `p = [tau1]`, gain `0.35`

```
partials k = 1,2,3 : freq_k = f * k * sqrt(1 + 0.0004 * k²), amp = [1.0, 0.45, 0.20], tau_k = tau1 / k
y = Σ amp_k * exp(-t/tau_k) * sin(ph_k)
tau1 = lerp(0.9, 0.35, clamp((midi - 64) / 24, 0, 1));  dur = 5 * tau1
```

**Sub (swell)** — `p = []`, gain `0.55`

```
env = t < 0.06 ? sin²(π/2 * t/0.06) : exp(-(t - 0.06)/1.1)
f(t) = f * (1 + 0.012 * exp(-t/0.4))
y = env * tanh(1.4 * (sin(ph) + 0.15 * sin(2*ph))) / tanh(1.4)
dur = 4.0
```

**Gong (inharmonic additive)** — `p = [tau0, shimmerHz]` = `[4.5, 0.7]`, gain `0.12`

```
ratios = [1.0, 2.0, 2.76, 4.07, 5.40, 6.99, 8.93]
amps   = [1.0, 0.60, 0.55, 0.35, 0.30, 0.20, 0.12]
tau_k  = tau0 / (1 + 0.55 * k)                         (k = 0..6)
each partial = 0.5 * (sin(ph_k) + sin(ph_k')),  ph_k' at f*ratio_k + shimmerHz*(1 + 0.13*k)
y = Σ amps_k * exp(-t/tau_k) * partial_k  +  0.15 * noise * exp(-t/0.012)      // strike transient
dur = 9.0
```

**Thud (bot)** — `p = []`, gain `0.80`

```
f(t) = 48 + 90 * exp(-t/0.03)       (phase integrates f(t))
y = sin(ph) * exp(-t/0.11) + 0.25 * lp(noise) * exp(-t/0.004)     lp = one-pole, a = 0.2
dur = 0.45
```

**Tick (bot)** — `p = []`, gain `0.25`

```
hp(noise): lp += 0.5 * (x - lp); y = (x - lp) * exp(-t/0.022)
dur = 0.12
```

All voice math must be finite for any valid input; unit tests (§13.2) render each voice offline in Node and assert finiteness, bounded peak (≤ 1.0 × gain × vel × 1.1), approximate decay (RMS in the last 10 % ≤ 5 % of the first 10 %), and expected fundamental via zero-crossing/FFT for bell, pluck and sub.

### 8.7 Effects (`fx-chain.ts`, `reverb-ir.ts`)

**Procedural reverb IR** (generated once at start; length by tier: 3.5 / 2.5 / 1.5 s; stereo):

```
for ch in {0,1}: y = 0
  for i in 0..N-1:  t = i/sr
    if t < 0.025: ir[i] = 0; continue                                  // pre-delay
    env = exp(-6.9078 * t / RT60)                                      // -60 dB at RT60
    a   = lerp(0.15, 0.92, min(1, t / RT60))                           // low-pass gets heavier over time
    x   = rand(-1, 1) (independent per channel, seeded PRNG)
    y   = a*y + (1-a)*x
    ir[i] = y * env
  add 6 early reflections per channel at random times in [0.030, 0.090] s with amplitude 0.5…0.15 decaying
```

`ConvolverNode.normalize = true`. Generate with a seeded PRNG so offline tests are deterministic.

**Ping-pong delay:** two `DelayNode`s (L, R) with `delayTime = 3/16 note = STEP_SEC * 3` and `STEP_SEC * 4` respectively, feedback `0.35` through a low-pass at 3.5 kHz, stereo merged.

**Ducking:** when a `sub` or `gong` is scheduled at time `T`: `padDuck.gain.cancelScheduledValues(T); setTargetAtTime(0.65, T, 0.02); setTargetAtTime(1.0, T + 0.12, 0.45)`.

**Master:** `DynamicsCompressorNode` (threshold −10 dB, knee 6, ratio 8, attack 0.004, release 0.20) → `WaveShaperNode` (curve `tanh(1.2x)/tanh(1.2)`, 2048 points, `oversample='2x'`) → `masterGain`. Master gain = `0.9 * volume²` (perceptual taper). Fade-in on start: `linearRampToValueAtTime` from 0 to target over 2.5 s. Mute: `setTargetAtTime(0, now, 0.05)`.

### 8.8 Pad, drone, air (`pad-layer.ts`)

- **Pad banks:** two banks (A/B) alternate. A bank = `{ gain, lowpass(Q 0.4), notes: for each of ≤5 pitches from padVoicing(): 2 oscillators (sawtooth detune −7 ct gain 0.030, triangle detune +7 ct gain 0.040) }` (low tier: triangle only).
- **Cross-fade on a chord event at time `T`:** create the new bank (oscillators `start(T - 0.01)`), `gain` 0 → 1 via `setTargetAtTime(1, T, 1.4)`; old bank `setTargetAtTime(0, T, 1.2)`, then `stop(T + 9)` and disconnect on `onended`. On a mode or key event the same procedure applies (new voicing).
- **Cutoff:** once per second set `lowpass.frequency.setTargetAtTime(500 + 2800*E + 120*sin(0.2*t), now, 1.5)` on the current bank.
- **Drone:** sine at `rootMidi − 12` (gain 0.10) + sine at `rootMidi` (gain 0.04). On key change, `frequency.setTargetAtTime(newFreq, T, 1.0)`.
- **Air:** 4 s looped pink-noise buffer (Paul Kellet filter, generated at start) → highpass 400 Hz → bandpass 2.5 kHz (Q 0.7) → gain `lerp(0.004, 0.020, E)` (smoothed once per second).
- Total continuous oscillators ≤ 22. The pad is **not spatialised** (stereo-centred).

### 8.9 Spatialisation (`audio-engine.ts`)

- Per-slot `PannerNode`: `panningModel = settings.spatialAudio && tier !== 'low' ? 'HRTF' : 'equalpower'`, `distanceModel='inverse'`, `refDistance=5`, `rolloffFactor=0.45`, `maxDistance=10000`, `coneInnerAngle=360`. (The inverse model clamps distance below `refDistance`, so gain never exceeds 1.)
- On trigger: `panner.positionX/Y/Z.setValueAtTime(dir*radius, when)`.
- **Listener = camera.** Once per frame, from `camera-rig`: set `listener.positionX/Y/Z` to the camera position, `forwardX/Y/Z` to the camera forward vector, `upX/Y/Z` to `(0,1,0)`. Feature-detect the `AudioParam` properties; otherwise fall back to `listener.setPosition()/setOrientation()`.
- World units match the visual world (core radius ≈ 1.2, camera orbit radius ≈ 5.5, edit shell 7–13).

### 8.10 Audio analysis (`analyzer.ts`)

- `AnalyserNode`: `fftSize = 2048`, `smoothingTimeConstant = 0` (we smooth ourselves).
- Preallocate `Float32Array`s once: `freqDb` (1024), `prevDb`, `timeBuf` (2048). Precompute bin ranges for bands at the real `sampleRate`: **sub 20–80 Hz, bass 80–250, mid 250–2000, high 2000–8000, air 8000–16000**.
- Per frame: `getFloatFrequencyData(freqDb)`; for each band `level = clamp((meanDb(band) + 80) / 60, 0, 1)` (mean of dB values clamped at ≥ −100).
- `flux` = Σ over mid/high bins of `max(0, db[i] − prevDb[i])`, normalised by a constant to ≈ 0..1, then decays with τ = 0.12 s.
- `rms` from `getFloatTimeDomainData(timeBuf)`: `rms01 = clamp((20*log10(rms) + 50)/40, 0, 1)`.
- Smooth each feature with attack τ 0.05 s / release τ 0.35 s using `a = 1 − exp(−dt/τ)`. Write results into one shared `AudioFeatures` object (no allocation).

### 8.11 `AudioEngine.trigger(note: NoteEvent)` steps

1. Build `kind`, `dur`, `p` for the voice from §8.6 (depends on `note.voice`, `note.midi`, `note.edit`).
2. `slot = allocate(kind, note.when, dur, note.edit.importance)`; if `-1` → count dropped, return `false`.
3. Set panner position at `note.when`.
4. Post `{t:'on', …}` to the worklet.
5. If `kind` is sub or gong → apply ducking (§8.7).
6. Return `true`. The scheduler pushes the visual only if `trigger` returned `true`.

### 8.12 Audio quality tiers

|                                | high  | medium | low        |
| ------------------------------ | ----- | ------ | ---------- |
| Voice budget (worklet outputs) | 16    | 12     | 8          |
| Panning                        | HRTF  | HRTF   | equalpower |
| Reverb IR length               | 3.5 s | 2.5 s  | 1.5 s      |
| Pad oscillators per note       | 2     | 2      | 1          |
| Analyser                       | on    | on     | on         |

Audio tier is chosen at `start()` from the same detection as the visual tier (§12.2) and is **not** changed dynamically (changing the worklet output count requires re-creating the node). The `spatialAudio` setting can switch `panningModel` live.

### 8.13 Lifecycle

- `start()`: create context → `addModule` → build graph → generate IR/noise → start pad/drone/air → fade master in over 2.5 s.
- `dispose()`: ramp master to 0 over 0.3 s, then `ctx.close()`; disconnect everything; clear timers.
- On `document.hidden`: **keep audio running**; only the renderer pauses (rAF stops automatically) and the scheduler lookahead widens (§7.1).

---

## 9. Visual engine specification

### 9.1 World, coordinates, camera

- World units: **core radius = 1.2**. Edits spawn on a shell of radius **7–13** around the origin (via `spatial-mapper`, §7.9). The camera orbits at radius **≈ 5.5**, i.e. **inside** the cloud of edits, looking at the origin. FOV 58°, near 0.1, far 200.
- Renderer: `WebGLRenderer({ antialias:false, alpha:false, powerPreference:'high-performance', stencil:false, depth:true })`. `toneMapping = NoToneMapping` (tone mapping is done in post). Clear colour = palette `deep`.
- **Camera rig (`camera-rig.ts`):**
  - Auto-orbit yaw rate `0.03 rad/s`; pitch `0.18 + 0.12*sin(0.05 t)`.
  - Distance `5.5 − 0.5*E` (smoothed, τ = 3 s); smooth-noise positional drift ±0.15 (2 octaves).
  - **User drag** (pointer events; mouse and touch): `yawOffset += dx*0.005`, `pitchOffset += dy*0.005` (pitch clamped ±1.2 rad), inertia damping `exp(-dt*3)`. Auto-orbit continues underneath. `touch-action: none` on the canvas.
  - **Trauma shake:** `trauma ∈ [0,1]` decays at 1.2/s; rotation shake amplitude `trauma² * 0.03 rad` using noise sampled at 25 Hz. Added on large edits (`+0.15`) and reverts (`+0.30`). Disabled when `reduceMotion`.
  - **Entrance:** on start, distance eases from 9 → target over 2.5 s (`easeOutCubic`).
  - Exposes `position`, `forward` (for the audio listener, §8.9) with no per-frame allocation.

### 9.2 Render order and blending

`dust (0)` → `orb (1)` → `sparks (2)` → `rings (3)`; all additive-blended, `depthWrite=false`, `depthTest=true`, `frustumCulled=false` for the instanced/point systems. All HDR output (values may exceed 1.0 to drive bloom).

### 9.3 Palette (`palette.ts`, `oklch.ts`)

Colours are specified in OKLCH `(L, C, h°)` and converted to **linear sRGB** (for shader uniforms) with Björn Ottosson's OKLab matrices:

```
a = C·cos(h), b = C·sin(h)
l_ = L + 0.3963377774a + 0.2158037573b ; m_ = L − 0.1055613458a − 0.0638541728b ; s_ = L − 0.0894841775a − 1.2914855480b
l = l_³ , m = m_³ , s = s_³
R = +4.0767416621l − 3.3077115913m + 0.2309699292s
G = −1.2684380046l + 2.6097574011m − 0.3413193965s
B = −0.0041960863l − 0.7034186147m + 1.7076147010s        (clamp to 0..1; if out of gamut reduce C by 5% steps until in gamut, max 8 iterations)
```

Per-mode base palette:

| Mode                    | core (L,C,h)    | accent          | dust            | deep             |
| ----------------------- | --------------- | --------------- | --------------- | ---------------- |
| lydian (gold/cyan)      | 0.86, 0.12, 85  | 0.82, 0.14, 200 | 0.75, 0.06, 60  | 0.12, 0.02, 260  |
| mixolydian (teal/amber) | 0.84, 0.13, 165 | 0.82, 0.15, 60  | 0.72, 0.05, 180 | 0.12, 0.025, 230 |
| dorian (blue/magenta)   | 0.80, 0.13, 250 | 0.78, 0.16, 330 | 0.70, 0.05, 260 | 0.11, 0.025, 270 |
| aeolian (violet/ember)  | 0.74, 0.14, 295 | 0.78, 0.15, 25  | 0.65, 0.05, 300 | 0.10, 0.03, 290  |

- **Key shift:** `hue += fifths * 5°`, `fifths = ((rootPc*7) % 12 + 6) % 12 − 6` (so adjacent keys on the circle of fifths have adjacent hues).
- **Per-language shift:** each edit's colour hue offset `± 12°` from `fnv1a(lang)`.
- **Transitions:** on harmony events the _target_ palette changes; the _current_ palette uniforms ease toward it with `τ = 2 s` (exponential smoothing in linear RGB).
- **Event colours:** addition → `accent`; removal → `core`; large edit → `mix(core, accent, 0.5) * 1.3`; revert ring → `mix(core, accent, 0.5) * 1.5` mixed 40 % toward white; new-page burst → `accent * 1.8` + 30 % white; bot pulse → `dust * 1.6`. HDR brightness multipliers: spark head 1.5–3.5 scaled by `lerp(1.5, 3.5, magnitude)`.

### 9.4 Core orb (`orb.ts`, `shaders/orb.*.ts`)

- Mesh: `IcosahedronGeometry(1.2, detail)`, detail 5 / 4 / 3 by tier. `ShaderMaterial`, additive.
- Uniforms: `uTime, uFrame, uCoreColor, uAccentColor, uDeep, uRms, uBass, uMid, uHigh, uFlux, uSteps, uOctaves, uImpactA[16] (vec4: dir.xyz, strength), uImpactB[16] (vec4: startTime, kind(0 push|1 dent), 0, 0)`. Use arrays of **preallocated `THREE.Vector4`** mutated in place.
- Include a standard 3D simplex noise `snoise(vec3)` (Ashima/webgl-noise, MIT) in `shaders/noise.glsl.ts`, plus `fbm` (octaves = `uOctaves`, 3 high / 2 medium+low) and interleaved-gradient noise `ign(xy) = fract(52.9829189 * fract(dot(xy, vec2(0.06711056, 0.00583715))))`.

**Vertex shader (logic):**

```glsl
vec3 dir = normalize(position);
float n = snoise(dir * 1.6 + vec3(0.0, 0.0, uTime * 0.15));
float disp = (0.05 + 0.10 * uBass) * n;
float ripple = 0.0;
for (int i = 0; i < 16; i++) {
  float s = uImpactA[i].w; if (s <= 0.0) continue;
  float age = uTime - uImpactB[i].x; if (age < 0.0 || age > 2.5) continue;
  float ang = acos(clamp(dot(dir, uImpactA[i].xyz), -1.0, 1.0));
  float w = sin(ang * 18.0 - age * 9.0) * exp(-ang * 3.0) * exp(-age * 1.6) * s;
  ripple += (uImpactB[i].y > 0.5 ? -1.0 : 1.0) * w;
}
float r = 1.0 + disp + 0.06 * ripple + 0.03 * uRms;
vec3 p = dir * 1.2 * r;      // then modelViewMatrix / projectionMatrix; pass vWorldPos, vNormalW
```

**Fragment shader (logic):** analytic ray–sphere intersection (radius `R = 1.2*1.05`) from `cameraPosition` through the fragment, giving entry `t0` and exit `t1`; march `uSteps` samples (8 / 5 / 3) with start offset `ign(gl_FragCoord.xy + uFrame)` to hide banding:

```glsl
for (int i = 0; i < MAX_STEPS; i++) {
  if (i >= uSteps) break;
  float t = t0 + (float(i) + jitter) * stepLen;
  vec3 p = ro + rd * t;
  float rr = length(p) / R;                                  // 0 centre … 1 surface
  float d = fbm(p * 1.7 + flow(uTime)) * (1.0 - rr * rr);    // denser toward the core
  d = smoothstep(0.15, 0.85, d + 0.25 * uMid);
  vec3 emit = mix(uCoreColor, uAccentColor, smoothstep(0.2, 0.9, rr + 0.3 * snoise(p * 3.0 + uTime * 0.2)));
  float a = 1.0 - exp(-d * stepLen * 3.2);
  col += trans * a * emit * (1.2 + 2.0 * uRms + 1.5 * uFlux);
  trans *= (1.0 - a);
}
float fres = pow(1.0 - clamp(dot(normalize(vNormalW), -rd), 0.0, 1.0), 3.0);
col += fres * mix(uAccentColor, uCoreColor, 0.5) * (0.6 + 1.5 * uHigh);
// plus localized glow near recent impacts: Σ strength * exp(-ang*6) * exp(-age*2) * accent
```

`MAX_STEPS = 8` constant; `flow(t)` is a slow 3D offset `vec3(0.0, t*0.05, t*0.03)`. Output `vec4(col, 1.0)` (additive blending).

**Impact ring buffer (CPU):** 16 slots. `addImpact(dir, strength, kind, startTime)` overwrites the oldest. Each frame, slots older than 2.5 s get `strength = 0`. Strength = `lerp(0.25, 1.0, magnitude)`; revert impacts use `kind = 1` (dent).

### 9.5 Sparks — stateless GPU particles (`sparks.ts`)

**No per-frame simulation and no ping-pong buffers.** Particle state is a pure function of `(uTime − spawnTime)` evaluated in the vertex shader. The CPU only writes new particles into a ring buffer.

- `InstancedBufferGeometry` with a unit quad (positions ±0.5, `uv`). Capacity `CAP` = 24 576 / 12 288 / 6 144 by tier. `instanceCount = CAP`.
- Per-instance `InstancedBufferAttribute`s (all `DynamicDrawUsage`): `aOrigin vec3`, `aTarget vec3`, `aTimes vec4 (spawnTime, duration, delay, seed)`, `aStyle vec4 (kind, size, jIndex01, brightness)`, `aColor vec3`.
- `kind`: `0` streak (human edits), `1` bot pulse, `2` burst (new page).
- **Spawn:** `spawn(kind, origin, target, color, magnitude, K)` writes K consecutive instances at `head` (wrapping with up to two contiguous ranges), then `attribute.addUpdateRange(start, count)` (verify the exact API in the installed three version) and `needsUpdate = true` **only on frames that spawned**. `head = (head + K) % CAP`.
- **Counts per event** (`K`, scaled by tier factor 1.0 / 0.7 / 0.5 and governor level): streak `lerp(10, 26, magnitude)` (large/sub edits: 36); bot pulse 1; burst 48.
- **Streak construction:** all K particles share `origin`, `target`, `seed`, `duration`; particle `j` has `delay = j * 0.018 s` (forms a comet trail) and `jIndex01 = j/(K−1)`. `duration = lerp(1.1, 1.8, 1 − magnitude)`. `target = dirToCore * 1.25` (just outside the orb surface).

**Vertex shader (logic):**

```glsl
float age = uTime - aTimes.x - aTimes.z;
if (age < 0.0 || age > aTimes.y) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }   // dead → clipped
float u = age / aTimes.y;
vec3 pos; float size = aStyle.y; float alpha = 1.0; float bright = aStyle.w;
if (kind == 0.0) {                                   // streak
  float e = pow(u, 1.6);                             // accelerate toward the core
  vec3 dir = normalize(aTarget - aOrigin);
  vec3 perp = normalize(cross(dir, hashVec3(aTimes.w)));
  float curve = sin(u * PI) * (0.35 + 0.65 * hash11(aTimes.w)) * 0.9;
  pos = mix(aOrigin, aTarget, e) + perp * curve * (1.0 - u) + (hashVec3(aTimes.w + aStyle.z * 17.0) - 0.5) * 0.05;
  size *= (0.5 + 0.5 * sin(u * PI)) * (1.0 - 0.6 * aStyle.z);
  alpha = smoothstep(0.0, 0.1, u) * (1.0 - smoothstep(0.8, 1.0, u));
} else if (kind == 1.0) {                            // bot pulse: straight, fast, flashes on arrival
  pos = mix(aOrigin, aTarget, u);
  bright *= 1.0 + 3.0 * smoothstep(0.85, 1.0, u);
  alpha = 1.0 - smoothstep(0.9, 1.0, u);
} else {                                             // burst: radial, drag, twinkle
  vec3 v = (hashVec3(aTimes.w + aStyle.z * 31.0) - 0.5) * 2.0 * (0.6 + 1.4 * hash11(aTimes.w + aStyle.z));
  pos = aOrigin + v * (1.0 - exp(-3.2 * u)) / 3.2 * 0.9;
  size *= pow(1.0 - u, 1.5);
  bright *= 1.0 + 0.4 * sin(uTime * 20.0 + aTimes.w * 50.0);
  alpha = 1.0 - smoothstep(0.6, 1.0, u);
}
vec4 mv = viewMatrix * vec4(pos, 1.0);
mv.xy += position.xy * size;
gl_Position = projectionMatrix * mv;
vColor = aColor * bright; vAlpha = alpha; vUv = uv; vKind = kind;
```

**Fragment:** soft disc `a = pow(1 − clamp(2·|uv−0.5|, 0, 1), 2)` for kinds 0 and 2; diamond `a = clamp(1 − 2*(|x|+|y|), 0, 1)` for kind 1. Output `vec4(vColor * a * vAlpha, a * vAlpha)` (additive).

**Long-run precision:** `uTime = (performance.now() − t0)/1000`. When `uTime >= 21 600` (6 h), call `rebase()`: reset `t0`, clear all particles, impacts, rings (prevents float32 time precision loss).

### 9.6 Shockwave rings (`rings.ts`)

- Instanced billboards, `CAP = 24`, attributes: `aOrigin vec3`, `aTimes vec2 (start, dur=2.2)`, `aColor vec3`.
- Vertex: expanding quad of half-size `lerp(0.1, 3.5, easeOutCubic(u))`, billboarded in view space.
- Fragment: `d = length(uv − 0.5) * 2; r = easeOutCubic(u); th = mix(0.10, 0.02, u); ring = smoothstep(r − th, r, d) * (1 − smoothstep(r, r + th, d)); intensity = ring * (1 − u)² * 2.5`.
- Spawned on **revert** events at the edit's shell position. Also triggers an orb **dent** impact in that direction, a chromatic-aberration kick (§9.8) and trauma (§9.1).

### 9.7 Dust (`dust.ts`)

- `THREE.Points` with `ShaderMaterial`; count 30 000 / 15 000 / 6 000; positions static, uniformly distributed in a spherical shell radius 3–40 (generated once with a seeded PRNG); attribute `aSeed`.
- Vertex shader: drift `p += 0.4 * vec3(sin(t*0.05 + s*10.0), cos(t*0.043 + s*7.0), sin(t*0.037 + s*13.0))`; `gl_PointSize = baseSize * uPixelRatio * (1 + 0.5*uHigh) * (scale / −mv.z)` clamped to [1, 6] px.
- Fragment: soft round point; alpha `0.25 + 0.75 * pow(sin(t*(0.5 + s) + s*40.0), 2.0)` (twinkle); colour = palette `dust`.
- Governor level L4 halves the visible count via `geometry.setDrawRange(0, count/2)`.

### 9.8 Post-processing (`post.ts`) — use the `postprocessing` library

- `new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 })`; `RenderPass`; then effects merged into as few `EffectPass`es as the library allows (target ≤ 3 full-screen passes excluding the bloom mip chain).
- Effects and baseline parameters:
  - `BloomEffect({ mipmapBlur: true, intensity: 0.9, luminanceThreshold: 0.55, luminanceSmoothing: 0.25, radius: 0.75, levels: 5 /4 /3 by tier })`. Runtime: `intensity = 0.8 + 0.6 * rmsSmooth`, low-passed with τ ≥ 0.15 s.
  - `ChromaticAberrationEffect({ offset: (0.0004 + caKick, same), radialModulation: true, modulationOffset: 0.15 })`. `caKick` decays with τ = 0.35 s; +0.0025 on reverts. Off on tier low / governor L1.
  - `VignetteEffect({ darkness: 0.55, offset: 0.3 })`.
  - `NoiseEffect` as film grain / dither: opacity 0.06 (0.02 on tier low) — also prevents banding in dark gradients.
  - `ToneMappingEffect` last: AgX if available in the installed version, else ACES Filmic; exposure 1.0.
- The composer is the only thing that draws to screen; `renderer.setPixelRatio(dpr * renderScale)` and `composer.setSize(w, h)` on resize and governor scale changes.

### 9.9 Labels and ticker (`labels.ts`)

- **Label pool:** 6 pre-created `<a>` elements in a `pointer-events:none` layer (each anchor has `pointer-events:auto`). Spawn a label when a fired visual event has `importance ≥ 0.55`, `edit.ns === 0`, `settings.showTitles`, at most one per 1.2 s and ≤ 6 active.
- Anchor position = the event's shell origin + `(0, 0.25, 0)`. Each frame: `v.copy(worldPos).project(camera)`; hide if `v.z > 1` or `|x| > 1.1` or `|y| > 1.1`; otherwise `style.transform = translate3d(px, py, 0)` (compute px/py from NDC).
- Lifetime 3.2 s: fade-in 0.3 s, fade-out 0.9 s (opacity transitions via CSS or per-frame opacity writes).
- Content via **`textContent` only** (never `innerHTML`): `LANG  Title`. `href = https://${host}/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`, `target="_blank"`, `rel="noopener noreferrer"`, `tabindex="-1"`.
- **Ticker feed:** `notable` events emitted at most once per 2.5 s for `importance ≥ 0.6` (not bots), consumed by the HUD (§11.4).

### 9.10 Performance governor (`governor.ts`)

Inputs: frame deltas from rAF. Maintains: `scale ∈ [0.55, tierMaxScale]`, `level ∈ [0..6]`.

```ts
update(dtMs, now) {
  if (dtMs > 250 || document.hidden || framesSinceResizeOrVisibility < 3) return;   // ignore spikes
  ema += 0.05 * (dtMs - ema);
  if (now - startedAt < 3000) return;                                               // warm-up
  if (ema > 20)        { slowSince ||= now; fastSince = 0;
                         if (now - slowSince > 1000 && now - lastChange > 2000) { degrade(); slowSince = 0; lastChange = now; } }
  else if (ema < 14.5) { fastSince ||= now; slowSince = 0;
                         if (now - fastSince > 4000 && now - lastChange > 4000) { improve(); fastSince = 0; lastChange = now; } }
  else { slowSince = fastSince = 0; }
}
degrade(): if (scale > 0.55) scale = max(0.55, scale - 0.10); else if (level < 6) { level++; applyLevel(level); }
improve(): if (level > 0) { level--; applyLevel(level); } else if (scale < tierMaxScale) scale = min(tierMaxScale, scale + 0.05);
```

Degradation levels (cumulative): **L1** chromatic aberration off · **L2** bloom levels −1 (min 3) · **L3** orb steps −2 (min 3) and octaves 2 · **L4** dust draw range ×0.5 · **L5** `maxPerSec` ×0.7 (send `config` to the ingest worker) and particles-per-event ×0.7 · **L6** bloom effect disabled.
Emit `quality` info (`tier`, `level`, `scale`) in `stats`. Explicit `quality` setting other than `auto` fixes the tier and disables the governor's `improve()` beyond that tier's max (but still allows degrade for safety).

### 9.11 Reduced motion and photosensitivity

- `reduceMotion` (default from `prefers-reduced-motion`): no trauma shake, no CA kick, camera drift ×0.4, orb ripple amplitude ×0.5, bloom intensity cap 0.7, spark `duration ×1.3`.
- **Always** (WCAG 2.3.1 spirit): any global brightness modulation (bloom intensity, orb emission scale) is low-passed with τ ≥ 0.15 s and its amplitude limited to ±35 %; no full-screen flash more than 3 times per second; no strobing patterns.

---

## 10. Audio–visual synchronisation

### 10.1 Mechanism

`NoteEvent` objects with `visual: true` are pushed into `VisualQueue` at **scheduling time** (up to ~150 ms before they sound). Each rAF frame:

```ts
const heard = ctx.currentTime - outputLatency - settings.avSyncMs / 1000;
let fired = 0;
while (queue.length && queue.peek().when <= heard && fired < 8) {
  fire(queue.pop());
  fired++;
}
dropStale(heard - 2.0); // events older than 2 s (e.g. after a hidden tab) are discarded unfired
```

- `outputLatency` per §8.2 (fall back to `baseLatency`, else 0.02). `avSyncMs` is a debug/user setting in `[-100, +100]` ms (default 0).
- Queue: fixed-capacity (256) array kept sorted by `when` using insertion (events arrive nearly sorted); no allocation; overflow drops the oldest.
- On `visibilitychange → visible`: clear the queue.

### 10.2 What `fire(note)` does (by `note.flavor`)

| flavor                       | sparks                      | rings          | orb impact                                    | other                          |
| ---------------------------- | --------------------------- | -------------- | --------------------------------------------- | ------------------------------ |
| add (pluck)                  | streak, `accent`            | –              | push, at arrival time (`now + duration*0.85`) | –                              |
| remove (bell)                | streak, `core`              | –              | push, at arrival                              | –                              |
| large (sub)                  | streak ×1.8 size, K=36      | –              | strong push                                   | trauma +0.15; slow bloom swell |
| revert (gong)                | –                           | ring at origin | **dent** immediately                          | CA kick, trauma +0.30          |
| new (birth, first note only) | burst (48) at origin        | –              | –                                             | label priority                 |
| bot-thud                     | bot pulse                   | –              | small push at arrival                         | –                              |
| bot-tick                     | bot pulse (smaller, dimmer) | –              | –                                             | –                              |

Delayed impacts (“at arrival”) are stored in a small fixed array `pendingImpacts[32]` with an activation time and flushed each frame.

### 10.3 Continuous coupling

Each frame after `analyzer.update(dt)`, copy `AudioFeatures` into orb uniforms (`uRms, uBass, uMid, uHigh, uFlux`), bloom intensity, dust `uHigh`, and camera dolly (via `E`). Harmony events (from the scheduler) update the target palette.

---

## 11. UI/UX specification

### 11.1 Look and feel

- Dark, minimal, near-black UI; all HUD text small and low-contrast but WCAG AA against the dark background. Fonts via `next/font` (Inter for UI, JetBrains Mono for labels/ticker) with `display: swap` and system fallbacks.
- Tailwind for layout only. No UI element may overlap the centre of the screen during playback.

### 11.2 Start overlay (`start-overlay.tsx`)

- Content: title **Sound of Knowledge**; tagline **“Listen to humanity writing its encyclopedia, live.”**; primary button **Enter**; subtext **“Best with headphones.”**; small links: _How it works_ (expands a short paragraph mapping edits → sound/visual), _GitHub_.
- The button is **disabled showing “Preparing…”** until `Engine.create()` resolves (renderer ready, shaders compiled). Then enabled; Enter key also activates.
- Clicking calls `engine.start()` inside the click handler (user gesture). On success the overlay fades out over 1.2 s.
- If WebGL2 is unavailable: show a static explanatory message (no Enter button). If the AudioWorklet fails to load: show the error banner and still run visuals muted.

### 11.3 Settings (`Settings` type, persisted in `localStorage` key `sok.settings.v2`, validated on load)

```ts
interface Settings {
  volume: number; // 0..1, default 0.8
  muted: boolean; // default false
  source: "wikipedias" | "no-wikidata" | "all"; // default 'wikipedias'
  langs: string[]; // [] = all
  density: "sparse" | "normal" | "dense"; // default 'normal'
  quality: "auto" | "low" | "medium" | "high"; // default 'auto'
  spatialAudio: boolean; // default true
  showTitles: boolean; // default true
  reduceMotion: boolean; // default = matchMedia('(prefers-reduced-motion: reduce)')
  avSyncMs: number; // default 0, shown only with ?debug=1
}
```

URL overrides (not persisted): `?source=live|replay|synthetic` (data mode, default `live`), `?quality=`, `?density=`, `?seed=` (synthetic/PRNG), `?debug=1`.
Settings panel: slide-over, keyboard-accessible; language filter = chips for the 12 most common languages + “All”.

### 11.4 HUD

- **Bottom-left:** status dot (green live, amber reconnecting, blue replay, red error) + `Live · 18 edits/s · Dorian in C`; under it the **ticker** (`en · Albert Einstein  +1,240`, linked).
- **Bottom-right:** icon buttons: mute, settings, fullscreen, screenshot, hide UI. Each has `aria-label` and a tooltip.
- **Top-left:** small wordmark.
- Auto-fade: after 5 s without pointer/touch/keyboard activity, HUD fades to 25 % opacity (status line stays); any input restores it.
- HUD React state updates at ≤ 4 Hz from the `stats` event; the ticker updates only on `notable`.
- Footer line (small): “Data: Wikimedia EventStreams”, link to GitHub.

### 11.5 Keyboard shortcuts

`M` mute · `F` fullscreen · `H` hide UI · `S` settings · `Esc` close panel. Shortcuts ignored while typing in inputs.

### 11.6 Accessibility

- Visible focus rings, ≥ 44 px touch targets, `role="status" aria-live="polite"` summary updated at most every 10 s (“Live, about 18 edits per second”).
- `prefers-reduced-motion` honoured (§9.11); no flashing > 3 Hz.
- `<noscript>` message.

### 11.7 Mobile

- `viewport` meta with `viewport-fit=cover`; use `env(safe-area-inset-*)` padding for HUD; canvas `touch-action:none`; HUD condensed (icons only). Initial tier `low`→`medium` per §12.2.
- iOS: AudioContext must start in the Enter tap; handle `interrupted` state (§8.2). Fullscreen button hidden where `requestFullscreen` is unavailable.

### 11.8 Error and edge states

| Condition                          | Behaviour                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| WebGL2 unsupported                 | Static message, no experience                                                                                                        |
| Worklet load fails                 | Banner “Audio engine failed to load”, run visuals only                                                                               |
| AudioContext suspended/interrupted | HUD button **Resume audio**                                                                                                          |
| Stream down                        | Status amber → automatic replay fallback with banner text (§6.6)                                                                     |
| Tab hidden                         | Audio continues, rendering pauses, queue cleared on return                                                                           |
| Context lost (`webglcontextlost`)  | `preventDefault()`, show “Display reset — restoring…”, on `webglcontextrestored` re-init GL resources; if it fails, offer **Reload** |

### 11.9 Debug overlay (`?debug=1`)

Top-right monospace panel (updated at 4 Hz): fps, frame ms (EMA & p95), render scale, tier/level, draw calls, triangles, particles alive (approx), events/s (accepted/dropped), queue lengths, active voices, dropped notes, AudioContext state, base/output latency, current mode/chord/key, JS heap (if `performance.memory`). Expose `window.__sok = { engine, getMetrics, renderOffline }` (used by tests, §13).

---

## 12. Performance budgets and quality tiers

### 12.1 Budgets (targets the implementation must be designed for and measured against)

| Area                                      | Budget                                                                                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Frame rate                                | Desktop mid-range (2020-class integrated GPU): p95 frame time ≤ 18 ms (≈ 60 fps). Mid-range phone: p95 ≤ 36 ms (≥ 30 fps)         |
| Main-thread JS per frame (excl. GPU wait) | mean ≤ 4 ms, p99 ≤ 8 ms                                                                                                           |
| Scheduler tick                            | ≤ 1 ms                                                                                                                            |
| Ingest worker per batch                   | ≤ 2 ms                                                                                                                            |
| Audio                                     | No audible glitches/underruns; if `AudioContext.renderCapacity` exists, average load < 0.35 and peak < 0.7                        |
| DSP cost (Node bench)                     | 16 simultaneous voices render ≥ 10× faster than real time                                                                         |
| Memory                                    | JS heap growth < 10 MB over a 10-min soak (after 60 s warm-up); no growth in DOM node count (≤ 100 nodes in the experience layer) |
| GC                                        | No per-frame allocations in hot paths (§1.2)                                                                                      |
| Startup                                   | “Enter” enabled ≤ 2.5 s after load (desktop, broadband); first sound ≤ 400 ms after the click                                     |
| Bundle                                    | First-load JS ≤ 450 KB gzip (three + postprocessing included); worker ≤ 40 KB gzip; worklet ≤ 40 KB gzip                          |
| Network                                   | One SSE connection; no polling                                                                                                    |

### 12.2 Tier detection (`engine/visual/tier.ts`, pure & unit-tested with injected environment)

```ts
function detectTier(env): Tier {
  const coarse = env.coarsePointer || Math.min(env.width, env.height) < 600;
  const cores = env.cores ?? 4,
    mem = env.deviceMemory ?? 4,
    gpu = (env.gpuRenderer ?? "").toLowerCase();
  if (/swiftshader|llvmpipe|software/.test(gpu)) return "low";
  if (coarse) return cores >= 8 && mem >= 6 ? "medium" : "low";
  if (/intel|uhd|iris/.test(gpu) && !/arc/.test(gpu)) return "medium";
  return "high";
}
```

`gpuRenderer` comes from `WEBGL_debug_renderer_info` (when unavailable → `''`). Override with `?quality=` / settings. The governor (§9.10) adapts at runtime.

### 12.3 Visual tier parameters

| Parameter                             | high        | medium        | low   |
| ------------------------------------- | ----------- | ------------- | ----- |
| max render scale (× devicePixelRatio) | min(dpr, 2) | min(dpr, 1.5) | 1.0   |
| orb icosphere detail                  | 5           | 4             | 3     |
| orb ray-march steps                   | 8           | 5             | 3     |
| orb fbm octaves                       | 3           | 2             | 2     |
| spark capacity                        | 24 576      | 12 288        | 6 144 |
| particles-per-event factor            | 1.0         | 0.7           | 0.5   |
| dust points                           | 30 000      | 15 000        | 6 000 |
| bloom levels                          | 5           | 4             | 3     |
| chromatic aberration                  | on          | on            | off   |
| grain opacity                         | 0.06        | 0.06          | 0.02  |
| `maxPerSec` (visual/musical events)   | 40          | 28            | 16    |

Audio tier table is in §8.12.

### 12.4 How performance is verified (no GPU/ears in CI)

1. **Deterministic CPU budgets** (Node/headless): scheduler tick time, ingest core throughput, DSP real-time factor (`scripts/bench.ts`). Assert in tests with generous margins (×3) to avoid flakiness.
2. **Structural guarantees:** unit tests that spies on allocation-prone paths are impractical; instead lint with a custom ESLint override for hot-path files (`no-restricted-syntax` for `.map(`, `.filter(`, `.forEach(`, `.reduce(`, spread in call args, `new Array(`, object literals inside functions tagged `// @hot`). Tag hot functions with `// @hot` and review manually.
3. **Soak test** (§13.5) for memory growth.
4. **Real-hardware checks** are `HUMAN-CHECK` items (fps on a mid laptop and a mid phone, audio glitch-free for 30 min).

---

## 13. Testing and verification strategy

### 13.1 Layers

Unit (Vitest, node) → integration (Vitest with fakes) → e2e (Playwright) → offline audio render (Playwright + `OfflineAudioContext`) → soak. CI runs everything except the soak (nightly/local).

### 13.2 Unit test inventory (create all; names indicative)

| Module                 | Tests                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `util/hash`            | FNV-1a vectors: `fnv1a("") = 0x811c9dc5`, `fnv1a("a") = 0xe40c292c`; stability across calls                                                                                                                                                                                                                                                 |
| `util/random`          | mulberry32 determinism; distribution mean ≈ 0.5 over 100k draws                                                                                                                                                                                                                                                                             |
| `util/oklch`           | `(L=1,C=0)` → (1,1,1); `(0,0,0)` → 0; OKLCH(0.6280, 0.2577, 29.23°) ≈ linear sRGB (1,0,0) within 0.02; gamut clamp never returns NaN/negative                                                                                                                                                                                               |
| `normalize`            | fixtures; actor classification (IPv4, IPv6, `~2025-1`, bot flag, registered); host parsing table (en/de wikipedia, wiktionary, wikidata, commons, meta, unknown); `new` without `length.old`; magnitude at 0/1/100/16384 bytes; importance bounds [0,1]; revert regex positives & negatives; malformed inputs return `null` and never throw |
| `filters`              | each `source` mode; langs; namespaces; dedupe ring eviction                                                                                                                                                                                                                                                                                 |
| `sampler`              | never exceeds token budget; keeps highest-importance when over budget; reserves ≥ 25 % random picks; deterministic with seeded RNG; stats unaffected by sampling                                                                                                                                                                            |
| `encode`               | encode → decode round-trip equality for 1 000 random edits                                                                                                                                                                                                                                                                                  |
| `sse-client`           | fake `EventSource`: watchdog reconnect at 20 s, backoff sequence 1/2/4/8/15/30 s (±20 % jitter bounds), reset after 30 s healthy, fallback to replay after 3 failures in 60 s, return to live when it recovers                                                                                                                              |
| `synthetic` / `replay` | determinism by seed; ratios (bot 20 % ± 3 %, anon 22 % ± 3 %, revert 3 % ± 1 %, new 3 % ± 1 %) over 20 000 events; replay loop ids strictly increasing                                                                                                                                                                                      |
| `modes`                | every chord pitch class ∈ mode scale; offsets strictly ascending; exactly one tonic per mode                                                                                                                                                                                                                                                |
| `harmony`              | never repeats a chord; tonic-return probability ≈ 0.45 ± 0.03 over 10 000 trials; mode only changes at bars % 8 == 0; hysteresis near boundaries; key walk ∈ {+7,+5,+2,−3}; deterministic with seeded RNG                                                                                                                                   |
| `pitch`                | `chordTonesInRange` ascending/in-range/in-chord; `padVoicing` ∈ [52,79], ≤ 5 notes; pitch index monotonic in magnitude (smaller edit → higher pitch)                                                                                                                                                                                        |
| `euclid`               | exact: `(3,8) = x..x..x.`, `(5,8) = x.xx.xx.`, `(4,16) = x...x...x...x...`; `(7,16)`: 7 hits, gaps differ by ≤ 1; rotation helper                                                                                                                                                                                                           |
| `density`              | `E` monotonic in eps; E(0)=0; E(EPS_REF)=1; budget scaling by density setting                                                                                                                                                                                                                                                               |
| `router`               | priority order (new > revert > bot > sub > pluck > bell)                                                                                                                                                                                                                                                                                    |
| `spatial-mapper`       | deterministic; unit-length dir; radius ∈ [7,13]; same wiki edits cluster (median angular distance to home < 0.6 rad)                                                                                                                                                                                                                        |
| `scheduler`            | with fake clock/sinks: all melodic `when` on a 16th grid within ±6 ms; ≤ 2 melodic notes/step; sub/gong only on beats; gong cooldown 1.2 s; birth cooldown 1.5 s; items older than 4 s dropped; thud/tick only with fuel; chord event every 4 bars; recovers after a stall; lookahead widens when hidden                                    |
| `dsp/*`                | each voice: finite output; peak bound; decay shape; fundamental frequency (bell/pluck/sub) via FFT within 2 %; no output after `dur`; no click at start/end (first/last 1 ms abs < 0.05)                                                                                                                                                    |
| `allocator`            | caps (gong ≤ 2, sub ≤ 3); no slot overlap; steal only lower priority; returns −1 when nothing can be stolen                                                                                                                                                                                                                                 |
| `visual-queue`         | ordering; stale drop; capacity overflow drops oldest; heard-time gating                                                                                                                                                                                                                                                                     |
| `governor`             | sustained 25 ms → degrade steps in order with cooldowns; sustained 10 ms → improve; spikes (> 250 ms) ignored; warm-up respected                                                                                                                                                                                                            |
| `palette`              | key hue shift mapping; smooth transition monotonic; never NaN                                                                                                                                                                                                                                                                               |
| `tier`                 | detection table incl. swiftshader, coarse pointer, Intel iGPU, Apple                                                                                                                                                                                                                                                                        |
| `settings`             | validation clamps bad values; defaults; URL overrides                                                                                                                                                                                                                                                                                       |

Coverage target: ≥ 85 % lines for `engine/ingest`, `engine/music`, `engine/audio/dsp`, `engine/audio/allocator.ts`, `engine/util`.

### 13.3 Offline audio render harness (the “ears” for the agent)

Purpose: verify the **complete** audio graph (worklet, panners, reverb, pad, limiter) automatically and deterministically.

- `window.__sok.renderOffline({ seconds, seed, rateMul, sampleRate = 48000 })` (available with `?debug=1`):
  1. Create `OfflineAudioContext(2, sr*seconds, sr)`; build `AudioEngine` on it with tier `high`.
  2. Generate synthetic edits (seeded) with timestamps; drive the **scheduler with a virtual clock** from 0 → `seconds` in 25 ms steps (injected `clock.now()`, injected seeded RNG, `lookahead` large enough). All notes, harmony events, pad crossfades, ducking and panner positions are scheduled up-front at their absolute audio times.
  3. After scheduling, post `{t:'sync'}` to the worklet and await `{t:'synced'}` (guarantees all `on` messages were received before rendering starts; the worklet keeps per-slot pending queues, §8.5).
  4. `await ctx.startRendering()`; return `left`, `right` (as `Float32Array`) and a `report`.
- `report` fields: `peakDb`, `rmsDb`, `crestDb`, `clippedSamples`, `nonFinite`, `bandShare {sub,bass,mid,high,air}` (FFT 8192, Hann, averaged across the file), `voiceCounts` per type, `attemptedNotes`, `droppedNotes`, `maxConcurrentVoices`, `harmonyTimeline`.
- `scripts/render-audio.ts` (Playwright, Chromium, `--autoplay-policy=no-user-gesture-required`): starts the production server, opens `/?debug=1&source=synthetic`, runs `renderOffline` for **E ≈ 0.3, 0.6, 0.9** (`rateMul` chosen from `eps = (1 + EPS_REF)^E − 1`), 120 s each, writes `artifacts/audio/render-E30.wav`, `render-E60.wav`, `render-E90.wav` (32-bit float stereo WAV) and `artifacts/audio/report.json`, prints a summary table, and **exits non-zero if any threshold in §8.4 fails**.
- `npm run audio:check` runs this script. The WAV files are for the human to listen to.

### 13.4 E2E tests (Playwright, `tests/e2e/*.spec.ts`)

Chromium launched with `--use-angle=swiftshader --enable-unsafe-swiftshader --autoplay-policy=no-user-gesture-required --enable-precise-memory-info`. All tests use `?source=synthetic&debug=1&quality=low` unless stated.

1. **Smoke:** page loads; Enter becomes enabled ≤ 20 s; click Enter; overlay disappears; within 10 s `__sok.getMetrics().acceptedTotal > 20`; `AudioContext` state `running`; zero `console.error` and zero `pageerror`; no `THREE.WebGLProgram: Shader Error`.
2. **Canvas is alive:** screenshot the canvas at t = 6 s and t = 12 s; luminance std-dev > 3 (not blank/flat); mean absolute pixel difference between the two > 1.0 (animating).
3. **Settings persistence:** change volume & density; reload; values restored; `Esc` closes panel.
4. **Keyboard:** `M` toggles mute (visible in metrics), `H` hides UI, `F` requests fullscreen (mock), `S` opens settings.
5. **Stream failure → replay:** with `?source=live`, `page.route('**/stream.wikimedia.org/**', r => r.abort())`; within 25 s status becomes `replay` and edits keep flowing.
6. **XSS safety:** use the debug hook `engine.injectEdits([...])` with title `<img src=x onerror=window.__pwned=1>`; assert no `<img>` appears in the label/ticker DOM, the literal text is shown, `window.__pwned` is undefined.
7. **Hidden tab:** simulate `document.hidden = true` + `visibilitychange`; audio engine keeps scheduling (metrics `notesScheduled` increases); on return the visual queue is empty.
8. **Cross-browser smoke** (Firefox, WebKit projects, `continue-on-error` in CI): load, Enter, no page errors.
9. **Audio check job:** `npm run audio:check` (§13.3).

### 13.5 Soak / leak test (`npm run test:soak`)

Playwright, `?source=synthetic&seed=1&rateMul=3&quality=low&debug=1`, 10 minutes (3 minutes acceptable if the environment is time-limited; log it). Sample `performance.memory.usedJSHeapSize` and DOM node count every 10 s after 60 s warm-up. Assert: heap regression slope < 0.5 MB/min and (max − min) < 10 MB; DOM node count within ±5; no console errors.

### 13.6 Visual proxy checks

- `scripts/shot.ts` captures PNGs of the canvas at several times to `artifacts/shots/` and prints per-image luminance mean/std-dev and the fraction of pixels brighter than 0.9 (bloom sanity). **If you can view images, open them and note any obvious defects (banding, clipped white, empty frame, wrong colours) in `DECISIONS.md`.**
- Shader compile check: in debug mode set `renderer.debug.checkShaderErrors = true`; any shader error fails e2e (item 1).

### 13.7 CI (`.github/workflows/ci.yml`)

Jobs: `static` (typecheck, lint, unit with coverage) → `build` (`npm ci`, `npm run build`) → `e2e` (Playwright Chromium; Firefox/WebKit non-blocking) → `audio-check` (uploads `artifacts/audio/*` as an artefact). Node version from `.tool-versions`.

---

## 14. Resilience, privacy, security

### 14.1 Resilience

- Stream: watchdog, backoff, replay fallback (§6.6). Malformed events never throw. Duplicate events deduped.
- Worker crash: on `worker.onerror`, restart once with the current config; if it fails again, emit `error{code:'stream'}` and switch to a main-thread replay-less idle state (audio bed + visuals continue).
- GL context loss/restoration (§11.8). Audio context interruption (§8.2).
- Numerical safety: in debug builds assert `Number.isFinite` for every value written to uniforms/attributes and posted to the worklet; in production clamp and drop invalid events.
- Long sessions: time rebasing (§9.5), bounded queues, no unbounded arrays/maps (dedupe ring, label pool, impacts ring are all fixed-size).

### 14.2 Privacy

- Usernames and IPs are used **only** inside `normalize()` to classify `actor`, then discarded; they never leave the worker, are never logged, rendered, stored, or sent to analytics.
- Persistent storage: only `localStorage['sok.settings.v2']` (UI settings). No cookies. No third-party requests except the Wikimedia stream and the existing Vercel Analytics.

### 14.3 Security

- Render external text only via `textContent`. External links: `rel="noopener noreferrer"`, `target="_blank"`.
- Headers in `next.config.ts` `headers()`: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, `X-Frame-Options: DENY`.
- CSP: ship as **`Content-Security-Policy-Report-Only`** first with `default-src 'self'; connect-src 'self' https://stream.wikimedia.org https://vitals.vercel-insights.com; script-src 'self' 'unsafe-inline' https://va.vercel-scripts.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; font-src 'self'; frame-ancestors 'none'`. If e2e shows zero violations, switch to enforcing and note it in `DECISIONS.md` (if Next.js inline scripts/Analytics require adjustments, adapt and log).

### 14.4 Wikimedia etiquette

One SSE connection per tab, no polling, no scraping; visible attribution “Data: Wikimedia EventStreams”.

### 14.5 Content note

Article titles are public data and may occasionally be offensive; the _Show titles_ setting lets users hide them. No automatic profanity filtering is implemented.

---

## 15. Execution plan (sequential tasks)

> Execute in order. Each task ends with a commit. Tick it in `docs/PROGRESS.md`. If you deviate from the spec, log it in `docs/DECISIONS.md`.
> Add `engine/audio/allocator.ts` (pure slot allocator, §8.5) to the layout from §5.3 — it is referenced by the tasks below.

### Phase 0 — Preparation

#### T0.1 — Branch, audit, clean slate

- **Depends on:** – **Spec refs:** §1, §3, §4, §5.3
- **Do:**
  1. `git checkout -b v2-rewrite`; tag the current `master` as `v1-final` (`git tag v1-final master`).
  2. Read the existing code (`app/`, `components/`, `lib/`, `vercel.json`, `next.config.ts`, `package.json`, README). Write `docs/LEGACY-NOTES.md`: what exists, anything worth preserving (Vercel Analytics usage in `app/layout.tsx`, deployment settings), what is being thrown away.
  3. Delete `components/*`, `lib/*`, and `app/api/wiki-stream/` (the proxy returns only if T1.1 shows CORS is blocked). Keep `app/layout.tsx` (remove imports of deleted files). Replace `app/page.tsx` with a placeholder `<main>Sound of Knowledge v2</main>`.
  4. Create `docs/PROGRESS.md` (checklist of every task ID below), `docs/DECISIONS.md`, `docs/HUMAN-CHECKLIST.md`, `docs/ARCHITECTURE.md`, `docs/TUNING.md` (headers only for now).
  5. Remove unused dependencies (§4 policy item 2) with `npm uninstall`.
- **Files:** `docs/*`, `app/page.tsx`, `app/layout.tsx`, `package.json`.
- **Acceptance:** `npm run build` succeeds; `git tag` shows `v1-final`; `grep -R "tone\|@react-three\|zustand" package.json` returns nothing; docs files exist.
- **Commit:** `chore: start v2 rewrite, remove legacy code and deps`

#### T0.2 — Tooling

- **Depends on:** T0.1 **Spec refs:** §4, §5.4, §12.4, §13
- **Do:**
  1. Install pinned dev dependencies: `vitest`, `@vitest/coverage-v8`, `@playwright/test`, `esbuild`, `tsx`, `npm-run-all2`, `prettier`; runtime: `three`, `postprocessing`, `@types/three` (pinned; check `postprocessing` peer range vs `three`).
  2. `tsconfig.json`: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `exactOptionalPropertyTypes: false`, path alias `@/*` → `./*`.
  3. ESLint rules: `@typescript-eslint/no-explicit-any: error`, `no-console: warn` (off in `scripts/`), and a hot-path override for files tagged with a `// @hot-file` header (ban `.map/.filter/.forEach/.reduce/.slice/.concat` calls and spread-in-calls via `no-restricted-syntax`).
  4. `vitest.config.ts` (node env, include `tests/unit/**/*.test.ts`, alias `@`), `playwright.config.ts` (Chromium launch args from §13.4, `webServer` = `npm run build && npm start` or reuse), Prettier config.
  5. `package.json` scripts: `typecheck`, `lint`, `test`, `test:cov`, `test:e2e`, `test:soak`, `audio:check`, `build:workers`, `predev`, `prebuild`, `dev` (parallel `build:workers --watch` + `next dev`), `bench`.
  6. `scripts/build-workers.mjs` (esbuild; accepts `--watch`; outputs to `public/engine/`). Create stub entry files so it runs now.
  7. `.github/workflows/ci.yml` per §13.7. Update `.gitignore` (`public/engine/`, `artifacts/`, `test-results/`, `playwright-report/`, `coverage/`).
- **Acceptance:** `npm run typecheck && npm run lint && npm run test` pass with one trivial test; `npm run build:workers` emits both bundles; `npm run build` passes.
- **Commit:** `chore(tooling): add strict TS, vitest, playwright, esbuild worker pipeline, CI`

#### T0.3 — Foundation modules

- **Depends on:** T0.2 **Spec refs:** §1.1.9, §5.6, §7.1, §9.3, §13.2
- **Do:** create `engine/config.ts` (start with §7.1 constants, `STRIDE`, `PROJECTS`, tier tables from §8.12/§12.3, voice gains from §8.6; every constant commented with its spec section), `engine/types.ts` (§5.6), `engine/bus.ts` (typed emitter, no allocation on emit for ≤ 4 listeners), `util/hash.ts` (FNV-1a 32-bit), `util/math.ts` (`clamp, lerp, smoothstep, easeOutCubic, gaussian(rng)`), `util/random.ts` (`mulberry32`, `pick`, `weighted`), `util/ring-buffer.ts` (fixed capacity, no allocation on push/pop), `util/oklch.ts` (§9.3), `util/perf.ts` (EMA, percentile over fixed window).
- **Tests:** per §13.2 rows `util/hash`, `util/random`, `util/oklch`, plus ring buffer and math.
- **Acceptance:** `npm run test` green, coverage for `engine/util` ≥ 85 %.
- **Commit:** `feat(engine): config, types, util foundations`

### Phase 1 — Data layer

#### T1.1 — Stream reconnaissance and calibration

- **Depends on:** T0.3 **Spec refs:** §6.1, §7.3
- **Do:**
  1. CORS check: `curl -sI -H "Origin: https://example.com" https://stream.wikimedia.org/v2/stream/recentchange | grep -i access-control`. Record the result. If CORS is blocked or there is no network, record that; if blocked, plan the proxy (§6.6) in T1.5.
  2. Write `scripts/probe-stream.ts` (Node `fetch` streaming SSE parser): for 60 s record raw events/s, share by project (wikipedia vs wikidata vs other), kind mix, bot ratio, revert-heuristic hit rate; print a report and the 95th percentile of **Wikipedias-only** events/s.
  3. Save ≥ 12 redacted real events to `tests/fixtures/recentchange-samples.json` covering: normal edit, `new`, bot, IPv4 anon, IPv6 anon, `~…` temporary account, revert comment, non-Wikipedia project, wikidata, `log` (ignored), edit with missing `length`. Replace user names by `ExampleUser`/`192.0.2.x`/etc. **If there is no network**, hand-write these fixtures from the shape in §6.1 and say so in `DECISIONS.md`.
  4. Set `EPS_REF = round(1.5 × p95)` in `config.ts` (default 60 if not measured). Log results in `DECISIONS.md`.
- **Acceptance:** fixtures file exists with the listed cases; `DECISIONS.md` has CORS result, throughput numbers (or “no network”), and `EPS_REF`.
- **Commit:** `chore(ingest): probe stream, add fixtures, calibrate EPS_REF`

#### T1.2 — Normalizer, filters, dedupe, encoding

- **Depends on:** T1.1 **Spec refs:** §6.2, §6.3, §6.5
- **Do:** implement `ingest/normalize.ts` (`normalize`, `isRevert`, `parseHost`), `ingest/filters.ts` (`passes`, `DedupeRing`), `ingest/encode.ts` (`encodeBatch`, `decodeBatch`, `STRIDE`, field offsets). Pure functions; no DOM/Worker globals.
- **Tests:** §13.2 rows `normalize`, `filters`, `encode`, using the fixtures.
- **Acceptance:** tests green; coverage for these files ≥ 90 %.
- **Commit:** `feat(ingest): normalizer, filters, dedupe, batch encoding`

#### T1.3 — Synthetic and replay sources

- **Depends on:** T1.2 **Spec refs:** §6.7
- **Do:** `ingest/synthetic.ts` (class `SyntheticSource` with `next(dtMs): NormalizedEdit[]` driven by a virtual or real clock, seeded), `ingest/replay.ts` (NDJSON replay with looping and id rewriting), `scripts/gen-synthetic.ts` (writes `public/replay/sample.ndjson`, ~3 min, ≤ 300 KB), `scripts/record-stream.ts` (records live to the same format; run it if network is available, else keep the synthetic sample and log it).
- **Tests:** §13.2 row `synthetic / replay`.
- **Acceptance:** tests green; `public/replay/sample.ndjson` exists and is ≤ 300 KB; `npx tsx scripts/gen-synthetic.ts` is idempotent for a fixed seed.
- **Commit:** `feat(ingest): synthetic generator and replay source`

#### T1.4 — Sampler and SSE client

- **Depends on:** T1.3 **Spec refs:** §6.4, §6.6
- **Do:** `ingest/sampler.ts` (token bucket + importance/random selection, injected RNG and clock), `ingest/sse-client.ts` (EventSource wrapper with injected factory/timers: watchdog, backoff with jitter, fallback signalling, status callbacks).
- **Tests:** §13.2 rows `sampler`, `sse-client` (fake EventSource + fake timers).
- **Acceptance:** tests green.
- **Commit:** `feat(ingest): importance sampler and resilient SSE client`

#### T1.5 — Ingest core, worker, client wrapper

- **Depends on:** T1.4 **Spec refs:** §5.1, §5.4, §6.5, §6.8, §7.7 (heartbeat)
- **Do:**
  1. `ingest/ingest-core.ts`: class `IngestCore` with injected `Source` (live/replay/synthetic), `emit(msg)`, `now()`; handles `start/config/stop`, batching every `batchIntervalMs`, stats every 500 ms, and a 25 ms heartbeat (`tick`). No worker globals inside.
  2. `ingest/ingest.worker.ts`: thin shell wiring `self.onmessage`/`postMessage` (transfer `num.buffer`) to `IngestCore` and a real `EventSource` source.
  3. `ingest/ingest-client.ts`: main-thread wrapper (create worker from `/engine/ingest.worker.js`, config updates, decode batches, listener API, `dispose()`), with worker `onerror` restart-once logic (§14.1).
  4. If T1.1 found CORS blocked: implement `app/api/wiki-stream/route.ts` and `NEXT_PUBLIC_STREAM_MODE` (§6.6).
  5. Run `npm run build:workers`.
- **Tests:** `IngestCore` with `SyntheticSource` at 100 eps for 10 simulated seconds and `maxPerSec = 40`: emitted events ≤ 40×10 + 20; `accepted` stat ≈ 1000 ± 10 %; stats never affected by sampling; config change takes effect; heartbeat count ≈ 400 ± 5.
- **Acceptance:** tests green; `public/engine/ingest.worker.js` exists and is < 40 KB gzip (`gzip -c … | wc -c`).
- **Commit:** `feat(ingest): ingest core, worker, main-thread client`

### Phase 2 — Music engine (pure TypeScript, no audio)

#### T2.1 — Modes, harmony, pitch

- **Depends on:** T0.3 **Spec refs:** §7.2, §7.4, §7.6
- **Do:** `music/modes.ts` (tables **verbatim**), `music/harmony.ts` (state machine; injected RNG; emits harmony events with audio-time stamps), `music/pitch.ts` (`chordMidi`, `chordTonesInRange`, `padVoicing`, `pickPitch`, `midiToFreq`).
- **Tests:** §13.2 rows `modes`, `harmony`, `pitch`.
- **Acceptance:** tests green; coverage ≥ 90 % for `engine/music/{modes,harmony,pitch}.ts`.
- **Commit:** `feat(music): modes, harmony state machine, pitch selection`

#### T2.2 — Spatial mapper, router, density, Euclid

- **Depends on:** T2.1 **Spec refs:** §7.3, §7.5, §7.8, §7.9
- **Do:** `music/spatial-mapper.ts`, `music/router.ts`, `music/density.ts` (`EnergyTracker`: EMA of accepted/s and bot/s, `E`, `botNorm`, `targetNotesPerSec`), `music/euclid.ts` (+ `rotate`).
- **Tests:** §13.2 rows `spatial-mapper`, `router`, `density`, `euclid`.
- **Acceptance:** tests green.
- **Commit:** `feat(music): spatial mapper, router, energy tracker, euclid`

#### T2.3 — Scheduler and offline music simulation

- **Depends on:** T2.2 **Spec refs:** §7.1, §7.7, §7.8, §5.6
- **Do:**
  1. `music/scheduler.ts`: class `Scheduler` with injected `clock: { now(): number }`, `isHidden(): boolean`, `rng`, `sinks: { note(n: NoteEvent): boolean; harmony(e: HarmonyEvent): void }`. Implement the algorithm in §7.7 exactly, queues, cooldowns, per-bar caps, fuel gating, stale dropping, stall recovery. Expose `onBatch(edits)`, `onTick()`, `getState()` (for debug overlay).
  2. `scripts/sim-music.ts`: runs the scheduler over 5 minutes of synthetic edits with a fake clock and prints counts per voice type, harmony timeline, average melodic notes/s vs target, max notes per step.
- **Tests:** §13.2 row `scheduler`.
- **Acceptance:** tests green; `npx tsx scripts/sim-music.ts` prints a summary where: chord changes occur every 4 bars, mode changes only at multiples of 8 bars, average melodic notes/s within ±30 % of `targetNotesPerSec`, no step with > 2 melodic notes.
- **Commit:** `feat(music): scheduler with quantisation, gating, and simulation script`

### Phase 3 — Audio engine

#### T3.1 — DSP voices

- **Depends on:** T0.3 **Spec refs:** §8.6, §13.2 (`dsp/*`), §12.1 (DSP cost)
- **Do:** `audio/dsp/voice.ts`, `bell.ts`, `pluck.ts`, `sub.ts`, `gong.ts`, `thud.ts`, `tick.ts` exactly per §8.6 (pure classes; no globals except `Math`). `scripts/bench.ts`: render 16 simultaneous voices for 60 s of audio at 48 kHz in Node and report the real-time factor.
- **Tests:** §13.2 row `dsp/*`.
- **Acceptance:** tests green; `npm run bench` reports ≥ 10× real time.
- **Commit:** `feat(audio): pure DSP voices with unit tests and bench`

#### T3.2 — Worklet, allocator, audio engine core

- **Depends on:** T3.1 **Spec refs:** §8.1–§8.3, §8.5, §8.9, §8.11, §8.12
- **Do:**
  1. `audio/allocator.ts` (pure; caps, steal rules) + tests (§13.2 row `allocator`).
  2. `audio/voice-pool.worklet.ts`: processor `'sok-voice-pool'` per §8.5 (per-slot pending queues, kill, sync, optional debug stats). Mark `// @hot-file`. Build with `npm run build:workers`.
  3. `audio/audio-engine.ts`: constructor takes `BaseAudioContext` + options `{ tier, spatial }`; async `init()` (addModule, node creation, per-slot `PannerNode`s, `voiceBus`, `mixBus`, simple master gain for now), `trigger(note)` (§8.11), `setListener(pos, fwd)` (feature-detected), `dispose()`.
- **Acceptance:** tests green; bundle `public/engine/voice-pool.worklet.js` built and < 40 KB gzip; a Playwright script (`tests/e2e/audio-boot.spec.ts`) can create an `AudioContext`, load the worklet from the built URL, trigger one bell via `AudioEngine.trigger`, and see the context state `running` without errors (use `?debug=1` hook; implement a minimal hook if needed).
- **Commit:** `feat(audio): voice-pool worklet, slot allocator, audio engine core`

#### T3.3 — FX chain, pad, drone, air

- **Depends on:** T3.2 **Spec refs:** §8.3, §8.7, §8.8
- **Do:** `audio/reverb-ir.ts` (deterministic), `audio/fx-chain.ts` (reverb send/return, ping-pong delay, pad duck, compressor, soft clipper, master gain with fade/mute/volume taper), `audio/pad-layer.ts` (banks, crossfade, cutoff updates, drone, air noise with Paul Kellet pink noise buffer). Wire into `AudioEngine` (`onHarmony(e)` creates the next pad bank at the event's audio time; `setEnergy(E)` for cutoff/air updates).
- **Tests:** `reverb-ir` determinism and decay (energy in last 10 % ≪ first 10 %); pad voicing → frequencies; `padDuck` automation scheduling helper (pure function producing a list of `[time, value, tc]` automation points).
- **Acceptance:** tests green; typecheck/lint green.
- **Commit:** `feat(audio): fx chain, reverb IR, pad/drone/air layers`

#### T3.4 — Analyzer

- **Depends on:** T3.3 **Spec refs:** §8.10
- **Do:** `audio/analyzer.ts` — preallocated buffers, band bin ranges from the real `sampleRate`, smoothing, `update(dtSec)` writes into one shared `AudioFeatures`. Split the pure math (`bandLevels(freqDb, ranges, out)`, `smooth`) from the Web Audio node wrapper.
- **Tests:** feed synthetic dB arrays (e.g., a peak at 100 Hz → `bass` dominates; at 5 kHz → `high`), smoothing attack/release behaviour, flux decay.
- **Acceptance:** tests green.
- **Commit:** `feat(audio): analyser with band features and smoothing`

#### T3.5 — Scheduler↔audio wiring, offline render harness, mix tuning

- **Depends on:** T2.3, T3.4 **Spec refs:** §8.4, §13.3, §8.7
- **Do:**
  1. Wire `Scheduler` sinks to `AudioEngine.trigger` / `onHarmony`; implement ducking from `trigger` for sub/gong.
  2. Implement `renderOffline` (§13.3) in a debug-only module (`engine/debug/render-offline.ts`) exposed on `window.__sok` when `?debug=1`. Needs a minimal page: `app/page.tsx` can mount a debug stub that exposes `__sok.renderOffline` even before the full Experience exists.
  3. Implement `scripts/render-audio.ts` with report calculation and threshold checks (§8.4), WAV writer, artefact output.
  4. Run `npm run audio:check`. **Iterate on gains** (voice gains, pad gains, reverb/delay sends, compressor threshold) until every §8.4 threshold passes for E ≈ 0.3, 0.6, 0.9. Document final values and rationale in `docs/TUNING.md`.
- **Acceptance:** `npm run audio:check` exits 0; `artifacts/audio/report.json` shows all metrics inside the §8.4 ranges; three WAV files exist.
- **Commit:** `feat(audio): scheduler wiring, offline render harness, tuned mix`

### Phase 4 — Visual engine

#### T4.1 — Renderer bootstrap, camera rig, palette, governor, tiers

- **Depends on:** T0.3 **Spec refs:** §9.1–§9.3, §9.10, §12.2, §12.3
- **Do:** `visual/renderer.ts` (WebGL2 check, renderer config, resize/DPR, rAF loop with delta clamp, context-loss handlers, `dispose()`), `visual/camera-rig.ts`, `visual/palette.ts`, `visual/governor.ts` (pure logic; injected clock), `visual/tier.ts`, `util/perf.ts` integration (frame-time EMA/p95). Render an empty scene with the clear colour from the palette.
- **Tests:** §13.2 rows `governor`, `palette`, `tier`; camera rig pure helpers (yaw/pitch composition, trauma decay).
- **Acceptance:** tests green; the main page (debug) shows a dark canvas without console errors (Playwright smoke).
- **Commit:** `feat(visual): renderer, camera rig, palette, governor, tier detection`

#### T4.2 — Core orb

- **Depends on:** T4.1 **Spec refs:** §9.4
- **Do:** `visual/shaders/noise.glsl.ts`, `orb.vert.ts`, `orb.frag.ts`, `visual/orb.ts` (mesh, material, uniforms, impact ring buffer, `addImpact`, per-frame `update(time, features, palette)`).
- **Acceptance:** build passes; Playwright run of the debug page captures a screenshot with `scripts/shot.ts` where the centre region luminance std-dev > 5 and no shader errors; if you can view images, inspect and note findings in `DECISIONS.md`.
- **Commit:** `feat(visual): procedural volumetric orb with impact ripples`

#### T4.3 — Sparks and rings

- **Depends on:** T4.2 **Spec refs:** §9.5, §9.6
- **Do:** `visual/sparks.ts` + shaders (stateless GPU particles; ring-buffer spawn with update ranges; kinds 0/1/2), `visual/rings.ts` + shaders. Provide `spawnStreak`, `spawnBotPulse`, `spawnBurst`, `spawnRing` APIs that take scratch `Vec3`s (no allocation). Debug-only “spawn test pattern” command via `__sok.debugSpawn(n)`.
- **Tests:** ring-buffer wraparound maths (pure helper returning up-to-two ranges), spawn counts per tier.
- **Acceptance:** tests green; screenshot at t=6 s with `debugSpawn` shows bright pixels ratio > 0.2 % and no shader errors.
- **Commit:** `feat(visual): GPU stateless sparks and shockwave rings`

#### T4.4 — Dust and post-processing

- **Depends on:** T4.3 **Spec refs:** §9.7, §9.8, §9.11
- **Do:** `visual/dust.ts` + shaders; `visual/post.ts` (composer, effects per §9.8, runtime setters: `setBloomIntensity`, `setCaKick`, `setLevels`, `setEnabled(effect, bool)`); integrate into the renderer in the order of §9.2; implement the brightness low-pass limits (§9.11).
- **Acceptance:** build passes; screenshot shows soft glow and non-banded dark gradient (std-dev of the 32×32 corner patch > 0 but < 6); no console errors.
- **Commit:** `feat(visual): ambient dust and post-processing stack`

#### T4.5 — Visual queue, event firing, labels, audio coupling

- **Depends on:** T4.4, T3.4 **Spec refs:** §9.9, §10
- **Do:** `visual/visual-queue.ts` (sorted fixed-capacity queue; heard-time gating; stale drop), `fire(note)` per §10.2 (sparks/rings/impacts/trauma/CA kick/labels), `pendingImpacts`, `visual/labels.ts` (pool of 6 anchors, projection, lifetimes, `textContent` only), ticker feed with throttling. Connect `AudioFeatures` → uniforms each frame; palette target updates from harmony events.
- **Tests:** §13.2 row `visual-queue`; label spawn throttling logic (pure); URL/href construction (`https://host/wiki/Encoded_Title`).
- **Acceptance:** tests green; Playwright debug page with synthetic source and `quality=low` shows moving comets (frame-to-frame pixel difference > 1.0) and DOM contains ≤ 6 label anchors.
- **Commit:** `feat(visual): audio-synced visual queue, labels, audio-reactive coupling`

### Phase 5 — Product shell

#### T5.1 — Engine integration and React shell

- **Depends on:** T1.5, T3.5, T4.5 **Spec refs:** §5.5, §11.2, §10
- **Do:** implement `engine/index.ts` (`Engine.create/start/setSettings/on/screenshot/getMetrics/resumeAudio/injectEdits(debug)/dispose`), the metrics object (`acceptedTotal`, `notesScheduled`, `droppedNotes`, `fps`, tier, queue sizes, audio state, mode/key…), the `stats` event at 4 Hz, `window.__sok` in debug. Build `components/experience.tsx` (create engine in `useEffect`, dispose on unmount, StrictMode-safe: guard against double init) and `components/start-overlay.tsx` (§11.2). Shader warm-up before enabling Enter (`renderer.compileAsync` or a hidden warm-up frame).
- **Acceptance:** `npm run build` ok; e2e smoke test (§13.4 item 1) passes locally; `Enter` enables ≤ 20 s under swiftshader.
- **Commit:** `feat(app): engine facade, experience component, start overlay`

#### T5.2 — HUD, settings, ticker, shortcuts

- **Depends on:** T5.1 **Spec refs:** §11.3–§11.6
- **Do:** `components/hud.tsx`, `components/settings-panel.tsx`, `settings` module (types, defaults, validation, `localStorage`, URL overrides), keyboard shortcuts, fullscreen, screenshot (render a frame then `canvas.toBlob`, download as `sound-of-knowledge-<timestamp>.png`), auto-fade HUD, ticker rendering with `textContent`/React text (no `dangerouslySetInnerHTML`). Apply settings live (`engine.setSettings`).
- **Tests:** settings validation unit tests; e2e items 3, 4 (§13.4).
- **Acceptance:** tests green.
- **Commit:** `feat(app): HUD, settings panel, shortcuts, ticker`

#### T5.3 — Robustness, accessibility, mobile

- **Depends on:** T5.2 **Spec refs:** §8.2, §9.11, §11.6–§11.8, §14.1
- **Do:** error banner + all error states of §11.8, `Resume audio` flow, visibility handling (§10.1), context loss/restore, reduced-motion and photosensitivity limits, ARIA live status, focus management, mobile layout (safe-area, `touch-action`), `<noscript>`.
- **Tests:** e2e items 5, 6, 7 (§13.4).
- **Acceptance:** tests green.
- **Commit:** `feat(app): error states, accessibility, mobile and resilience`

#### T5.4 — Security, metadata, deploy config

- **Depends on:** T5.3 **Spec refs:** §14.3, §14.4
- **Do:** security headers and CSP report-only in `next.config.ts`; page metadata (title, description, Open Graph/Twitter tags) and `public/og.png` (generate a 1200×630 PNG from a screenshot taken with `scripts/shot.ts`, or a plain dark gradient with the title if screenshots are unavailable); clean `vercel.json` (drop SSE-specific config unless the proxy is enabled); remove stale files.
- **Acceptance:** `npm run build` passes; headers verified with `next start` + `curl -I`; e2e shows no CSP report-only violations in the console (adapt policy and log if needed).
- **Commit:** `chore(app): security headers, metadata, deploy config`

### Phase 6 — Quality, performance, documentation

#### T6.1 — Test completion and coverage

- **Depends on:** T5.4 **Spec refs:** §13.2, §13.4, §13.7
- **Do:** run `npm run test:cov`; add missing tests until the coverage targets of §13.2 are met; ensure every e2e item (1–9) exists and passes; fix flakiness (explicit waits on metrics, no fixed sleeps except sampling intervals).
- **Acceptance:** `npm run typecheck && npm run lint && npm run test:cov && npm run build && npm run test:e2e && npm run audio:check` all pass; coverage thresholds met.
- **Commit:** `test: complete unit/e2e coverage and stabilise suite`

#### T6.2 — Final audio verification

- **Depends on:** T6.1 **Spec refs:** §8.4, §13.3
- **Do:** re-run `audio:check` for E ≈ 0.3/0.6/0.9 and a 10-minute render at E ≈ 0.6; confirm no thresholds regress; verify spatial correctness numerically: render a test with a single bell at `dir = (1,0,0)` and listener forward `(0,0,−1)`: right-channel RMS must exceed left by ≥ 6 dB (HRTF) — add as a harness test (`renderOffline({ scenario: 'pan-right' })`). Add listening notes to `docs/HUMAN-CHECKLIST.md`.
- **Acceptance:** all checks pass; pan test passes; WAVs regenerated.
- **Commit:** `test(audio): final verification incl. spatial pan test`

#### T6.3 — Performance validation

- **Depends on:** T6.1 **Spec refs:** §12, §13.5
- **Do:** run `npm run bench`; run `npm run test:soak` (10 min, or 3 min if limited — log); measure bundle sizes (`next build` output, `gzip -c` for worker/worklet); fix regressions: hot-path allocations (review `// @hot` functions), unnecessary React re-renders (HUD ≤ 4 Hz), shader cost (reduce steps if p95 frame time in the debug overlay is high on available hardware). Record numbers in `docs/TUNING.md`.
- **Acceptance:** DSP ≥ 10× real time; soak thresholds met; bundle budgets met (or deviation logged with justification).
- **Commit:** `perf: validate budgets, soak test, bundle audit`

#### T6.4 — Cross-browser fallbacks

- **Depends on:** T6.1 **Spec refs:** §3.2, §8.2, §8.9, §11.7
- **Do:** run the e2e smoke on Firefox and WebKit; fix: missing `AudioListener` params, `outputLatency` absence, `EventSource` in worker differences, WebGL extension gaps (half-float targets), Safari autoplay/`interrupted` behaviour. Where an environment cannot run a browser, document that.
- **Acceptance:** Chromium e2e green; Firefox/WebKit smoke green or failures documented in `DECISIONS.md` with the cause.
- **Commit:** `fix: cross-browser compatibility`

#### T6.5 — Documentation and release prep

- **Depends on:** T6.2, T6.3, T6.4 **Spec refs:** §1.4
- **Do:** rewrite `README.md` (concept, how it works — edits→sound/visual mapping table, tech stack, architecture diagram, run/build/test commands, settings & URL params, performance notes, credits/data attribution); finalise `docs/ARCHITECTURE.md` (threads, clocks, data flow, module map), `docs/TUNING.md` (every tunable constant, where it lives, effect), `docs/HUMAN-CHECKLIST.md` (§16 `HUMAN-CHECK` items); final dependency audit (`npm ls --depth=0`, remove unused); ensure `npm ci && npm run build` works from clean.
- **Acceptance:** docs complete; clean install builds.
- **Commit:** `docs: README, architecture, tuning, human checklist`

#### T6.6 — Final acceptance run

- **Depends on:** T6.5 **Spec refs:** §16
- **Do:** from a clean clone: `npm ci && npm run typecheck && npm run lint && npm run test:cov && npm run build && npm run test:e2e && npm run audio:check`; tick every item in §16; merge-ready summary in `docs/PROGRESS.md` (what was built, known limitations, deviations from the spec).
- **Acceptance:** all green; §16 complete except `HUMAN-CHECK` items.
- **Commit:** `chore: final acceptance`

---

## 16. Final acceptance checklist

**Automated (must all pass):**

- [ ] `npm ci && npm run typecheck && npm run lint && npm run test:cov && npm run build && npm run test:e2e && npm run audio:check`
- [ ] Offline audio report within §8.4 ranges at E ≈ 0.3 / 0.6 / 0.9; pan test passes
- [ ] Soak test: no heap/DOM growth beyond §12.1
- [ ] DSP ≥ 10× real time; worker and worklet bundles < 40 KB gzip; first-load JS ≤ 450 KB gzip (or documented deviation)
- [ ] No Tone.js / R3F / Zustand in `npm ls`
- [ ] No usernames or IPs anywhere in `NormalizedEdit`, logs, or DOM
- [ ] XSS test passes (titles rendered as text only)
- [ ] Stream-failure → replay fallback works; reconnect returns to live
- [ ] All docs present and complete

**`HUMAN-CHECK` (listed in `docs/HUMAN-CHECKLIST.md`; the agent cannot verify these):**

- [ ] First 60 seconds match §2.2 in feel: calm, musical, never cacophonous, no harshness on headphones
- [ ] Loudness comfortable at 80 % volume; gongs not startling
- [ ] Sound direction matches comet origin on headphones (left/right/behind)
- [ ] Audio and visual feel simultaneous (adjust `avSyncMs` if Bluetooth)
- [ ] Mode/colour transitions feel smooth, not abrupt
- [ ] 60 fps on a mid-range laptop; ≥ 30 fps on a mid-range phone; no audio glitches over 30 minutes
- [ ] Reduced-motion mode feels calm; no flashing

---

## 17. Appendix: stretch goals (do NOT start unless every task above is complete)

1. **WebGPU renderer path** (Three.js WebGPU/TSL) with compute-based particles, behind a feature flag, falling back to WebGL2.
2. **Gyroscope look-around** on mobile (DeviceOrientation, permission flow on iOS).
3. **Share/record:** capture 15-second clip (canvas `captureStream` + `MediaRecorder` mixed with a `MediaStreamAudioDestinationNode`).
4. **Per-language region labels** on the shell (faint constellation names).
5. **Time-of-day mood:** bias mode/palette by local time.
6. **Per-slot reverb sends** (distance-dependent wet/dry) in the voice graph.
7. **Replay of a notable historical event** (curated recordings) in a “Moments” menu.
