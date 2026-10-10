# Legacy (v1) Code Notes

Audit of the code being replaced by the v2 rewrite. Baseline: tag `v1-final`
(commit `8bb5a1d`). Roughly 2,200 LOC across `app/`, `components/`, `lib/`.

Everything below is _deleted_ as part of T0.1. This file exists so that hard-won
knowledge is not lost — the "preserve" column is the specification input for the
rewrite.

---

## 1. File inventory

### `app/`

| Path                           | LOC | Purpose                                                                       | Stack                                                      | Preserve?                                            |
| ------------------------------ | --- | ----------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| `app/page.tsx`                 | 31  | Root composition: Scene + Overlay + IntroMessage + AboutModal + credit footer | Next 16 App Router, `next/dynamic` `{ssr:false}`           | **Yes** — SSR-disable pattern; footer link pattern   |
| `app/layout.tsx`               | 47  | Metadata, viewport, fonts, Analytics                                          | `next/font`, `@vercel/analytics`, `@vercel/speed-insights` | **Yes** — analytics + `overflow-hidden` + `bg-black` |
| `app/globals.css`              | 40  | Tailwind v4 import, CSS vars, mobile hardening                                | Tailwind v4                                                | **Yes** — mobile hardening block (see §4)            |
| `app/api/wiki-stream/route.ts` | 103 | SSE proxy: Wikimedia → throttled SSE                                          | `ReadableStream` + `fetch`                                 | **Conditional** — only if CORS blocked (T1.1)        |

### `components/`

| Path                 | LOC | Purpose                                                    | Stack                         | Preserve?                                                   |
| -------------------- | --- | ---------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------- |
| `AboutModal.tsx`     | 31  | Backdrop-blur modal, click-outside close                   | React + zustand               | Partially — needs `role="dialog"`, Escape, focus trap in v2 |
| `IntroContent.tsx`   | 28  | Pure copy block, `compact` variant                         | React (server-safe)           | Partially — as copy only                                    |
| `IntroMessage.tsx`   | 41  | Auto-fading intro (4 s fade, 5.5 s unmount)                | React + zustand               | Partially — timers need skip-on-interaction                 |
| `KnowledgeOrb.tsx`   | 89  | Noise-displaced shader orb; lerps audio uniforms           | R3F + raw `ShaderMaterial`    | **Yes** — blending fix + smoothing factors                  |
| `Overlay.tsx`        | 159 | HUD: buttons, connection dot, counters, FPS, edit feed     | React + zustand               | Partially — `useFPS` hook, `aria-label`s, dedupe keys       |
| `ParticleSystem.tsx` | 485 | GPU point-sprite pool, curl-noise, raycasting              | R3F + GLSL + `Float32Array`   | **Yes** — richest source of fixes (see §3)                  |
| `PostFX.tsx`         | 65  | Bloom / Vignette / CA / SMAA chain                         | `@react-three/postprocessing` | Partially — MSAA finding                                    |
| `Scene.tsx`          | 396 | Orchestrator: SSE lifecycle, audio gesture, Canvas, camera | R3F, EventSource, zustand     | **Yes** — SSE reconnect, tiering, raycast threshold         |

### `lib/`

| Path          | LOC | Purpose                                                | Stack           | Preserve?                                                          |
| ------------- | --- | ------------------------------------------------------ | --------------- | ------------------------------------------------------------------ |
| `audio.ts`    | 251 | Generative audio engine + analyser taps                | **Tone.js v15** | Design intent only — Tone.js is banned by spec §3.3                |
| `classify.ts` | 48  | Magnitude buckets + event normalisation                | Pure TS         | **Yes** — link-construction correctness                            |
| `shaders.ts`  | 316 | All GLSL (orb vert/frag, fallback, particle vert/frag) | Raw GLSL        | **Yes** — 18-step raymarch is prior art for §9.4                   |
| `store.ts`    | 76  | zustand store: queue, history, counters, audio metrics | zustand v5      | Partially — bounded-queue discipline; the per-frame write is a bug |
| `types.ts`    | 13  | `EditMagnitude`, `WikiEditEvent`                       | TS              | **Yes** — shape is close to §5.6 `NormalizedEdit`                  |

---

## 2. Wikimedia stream handling (the correctness-critical bit)

Endpoint used by v1:

```ts
const WIKIMEDIA_SSE = "https://stream.wikimedia.org/v2/stream/recentchange";
```

Field mapping actually exercised in the wild (`lib/classify.ts`):

- `id` ← `meta.id ?? raw.id` (v1 stringified it; v2 §6.2 requires `typeof id === 'number'`)
- `sizeDelta` ← `length.new - length.old`
- `isBot` ← `raw.bot`
- `isRevert` ← `raw.reverted || /revert|undo/i.test(comment)` — heuristic only, same caveat as spec §6.2.6
- `timestamp` ← `raw.timestamp * 1000` (seconds → ms), confirming §6.2.11
- `server_url` → `https://en.wikipedia.org` (v1 used `server_url`; spec §6.1/§6.2.7
  specifies `server_name`. **Both fields exist upstream; the v2 normaliser must
  accept `server_name` first and fall back to `server_url`.** Logged as a
  DECISIONS.md entry at T1.2.)

Diff-link construction (kept verbatim as a correctness reference):

```
pageUrl = `${serverUrl}/wiki/${encodeURIComponent(title.replace(/ /g,'_'))}`
editUrl = `${serverUrl}/w/index.php?title=<enc>&diff=${revision.new}` (+`&oldid=${revision.old}`)
```

Both link sites used `edit.editUrl ?? info.pageUrl`.

---

## 3. Hard-won fixes discovered in comments (must not be lost)

These are the highest-value artifacts in the legacy tree — each is a bug that was
found and fixed by hand:

1. **Dead-particle raycast parking** (`ParticleSystem.tsx:380-394`) — dead particles
   are moved to `z = -10000`. _"`size 0` makes them invisible but the raycaster
   ignores size and checks world position within threshold"_ — invisible particles
   were intercepting clicks aimed at live ones.
2. **Orb blending** (`KnowledgeOrb.tsx:83-85`) — _"`NormalBlending` keeps the orb body
   readable; bloom adds the glow. `AdditiveBlending` was washing the orb flat."_
   (v2 §9.2 specifies additive; this trade-off must be re-checked visually.)
3. **SMAA replaces MSAA** (`PostFX.tsx:61`) — _"`SMAA` replaces MSAA (broken under
   post-processing)"_; correspondingly `multisampling={0}` on the composer.
   (v2 §9.8 sets `multisampling: 0` for the same reason.)
4. **`es.close()` on `onerror`** (`Scene.tsx:307-339`) — native `EventSource`
   auto-reconnects, so a custom backoff loop must close it explicitly or you
   double-connect. Spec §6.6 mandates a watchdog instead; keep this lesson.
5. **Anti-strobe tuning** (`ParticleSystem.tsx:429,443`) — _"Slow, gentle breathing —
   no high-frequency strobing (which blooms into flashes)"_. Reinforces spec §9.11.
6. **Scratch vectors in the hot loop** (`ParticleSystem.tsx:354`) — pre-allocated
   curl/swirl vectors. Reinforces spec §1.2.
7. **Threshold-gated React state** (`Scene.tsx:184-208`) — only re-render when
   amplitude/low/high/displace move > 0.02/0.05. Reinforces spec §1.2's ≤ 4 Hz rule.
8. **Analysers tap pre-limiter** (`audio.ts:26`) — _"so visuals track the true mix"_.
   v2 §8.3 keeps this exact topology (analyser tap before `masterGain`).
9. **Raycast threshold** `Points.threshold = 0.35` (`Scene.tsx:364`) — generous
   hover radius for point sprites.
10. **Spawn radius floor** `1.85 + rand*1.4` (`ParticleSystem.tsx:270`) — _"always
    visible and pickable — never buried inside"_.
11. **FNV-1a deterministic seeding** (`ParticleSystem.tsx`) — v1 already used
    `hashString()` FNV-1a keyed on `${id}-${title}-${timestamp}`. v2 §7.9 reuses
    FNV-1a for the spatial mapper; the choice is validated.

---

## 4. Mobile hardening (`app/globals.css`)

Keep these — they came from the "make it mobile friendly" work:

```css
body {
  touch-action: pan-y;
  overscroll-behavior: none;
}
* {
  -webkit-tap-highlight-color: transparent;
}
@media (max-width: 640px) {
  * {
    -webkit-touch-callout: none;
  }
}
```

v2 replaces the body `touch-action` with `touch-action: none` on the canvas only
(spec §11.7) so the HUD remains scrollable.

---

## 5. Known v1 performance defects (explicitly designed out in v2)

| Defect                                                                                | v2 remedy (spec ref)                                       |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `store.setAudio()` every frame → 60 Hz zustand writes + React re-renders              | React shell updated ≤ 4 Hz from engine events (§1.2, §5.5) |
| UA sniffing (`isMobileDevice`, `detectLowTierDevice`) called inside render/`useFrame` | `detectTier()` is pure, called once (§12.2)                |
| `particles.findIndex(...)` linear free-scan over 3 000 particles per spawn            | Fixed ring buffers + `head` index (§9.5)                   |
| `buf.slice(...)` per frame in the analyser hot path                                   | Preallocated typed arrays, in-place writes (§8.10)         |
| `useFPS()` rAF loop runs even when the overlay is hidden                              | Debug overlay gated on `?debug=1`, 4 Hz (§11.9)            |
| `window.open` on particle click (popup-blocked)                                       | `<a target="_blank" rel="noopener noreferrer">` (§9.9)     |
| No `prefers-reduced-motion` handling                                                  | `reduceMotion` setting + §9.11 limits                      |

---

## 6. README accuracy (v1 README is unreliable)

The v1 README describes code that does not exist. Do **not** use it as a source of
truth when writing the v2 README:

- "Project Structure" lists files that never existed (`components/scene.tsx`,
  `orb.tsx`, `audio-engine.tsx`, `lib/wiki-stream.ts`, `utils.ts`, …).
- Claims "Shepard tone pads" (none in code), "bot edits → percussive thuds"
  (code uses `Tone.PluckSynth`), "reverts → long metallic gongs" (code uses a soft
  triangle `MonoSynth` through a closing lowpass).
- Claims "Lydian/Mixolydian centers every 16 bars"; the code uses **root + fifth
  (no thirds)** rotating every **32 ticks ≈ 32 s** at 60 BPM on 4n.
- Claims `vercel.json` "enables streaming support"; it does not — the real
  enablers are the `X-Accel-Buffering: no` and `no-transform` response headers.

---

## 7. Deployment facts to preserve

- `@vercel/analytics` + `@vercel/speed-insights` are used **only** in
  `app/layout.tsx` (added in commit `029601d`). Spec §3.1 says keep them.
- `next.config.ts` sets `compiler.removeConsole` (strips console in production
  except `error`/`warn`). Keep — it protects the §1.2 "no console.log" rule.
- `vercel.json` v2: a `builds` block, a no-op self-referencing route for
  `/api/wiki-stream`, and `NODE_ENV=production`. v2 drops the route unless the
  proxy is enabled (spec §5.4/§6.6, task T5.4).
- `public/preview.png` is 1.1 MB and is referenced by the stale README; v2
  replaces it with `public/og.png` (T5.4).
