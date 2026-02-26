# Sound of Knowledge

A real-time, generative audiovisual experience that transforms live Wikipedia edits into an immersive 3D soundscape. Every edit becomes a note; every article update shapes the visuals.

**Live Demo:** [sound-of-knowledge.vercel.app](https://sound-of-knowledge.vercel.app)

![Sound of Knowledge Preview](/public/preview.png)

## Overview

Sound of Knowledge listens to the [Wikimedia Recent Changes stream](https://stream.wikimedia.org/v2/stream/recentchange) — a high-throughput SSE feed broadcasting every edit across all Wikimedia projects in real-time. These edits drive both a WebGL visualization engine and a generative audio synthesis system, creating a living, breathing representation of human knowledge being built.

## Features

### Visual Experience
- **Procedural Shader Orb** — A custom vertex shader with multi-scale noise displacement that reacts to edit magnitudes in real-time
- **High-Performance Particle System** — Instanced `BufferGeometry` with object pooling; particles spawn dynamically from live SSE events
- **Volumetric Glow** — Raymarched inner glow using Fractional Brownian Motion (fBm) for organic, ethereal effects
- **Cinematic Camera** — Drift and shake that responds to massive edits and reverts
- **Audio-Reactive Visuals** — Real-time FFT analysis drives particle turbulence and glow intensity

### Audio Experience
- **100% Generative** — No pre-recorded samples; all audio synthesized in real-time using Tone.js
- **Modal Harmony** — Shifts between Lydian/Mixolydian centers every 16 bars to maintain consonance
- **Edit-to-Sound Mapping:**
  - Large edits → Deep sub-basses and Shepard tone pads
  - Small edits → High-frequency FM bell chimes
  - Bot edits → Short percussive thuds
  - Reverts → Long metallic gongs
- **Zero-Latency Feedback Loop** — Tone.js analyzers feed amplitude/frequency data back into shader uniforms

### Performance
- Dynamic quality scaling based on device capability
- Automatic fallback to simplified shaders on low-tier devices
- Object pooling to minimize garbage collection in the hot path
- Typed arrays (`Float32Array`) for particle state management

## Tech Stack

| Category | Technology |
|----------|------------|
| Framework | [Next.js](https://nextjs.org) 16 (App Router) |
| UI | [React](https://react.dev) 19, [TailwindCSS](https://tailwindcss.com) 4 |
| 3D | [Three.js](https://threejs.org), [React Three Fiber](https://docs.pmnd.rs/react-three-fiber) |
| Audio | [Tone.js](https://tonejs.github.io) (Web Audio API) |
| State | [Zustand](https://github.com/pmndrs/zustand) |
| Deployment | [Vercel](https://vercel.com) |

## Project Structure

```
app/
├── api/wiki-stream/route.ts    # SSE proxy for Wikimedia stream
├── page.tsx                     # Main page with AudioEngine + Scene
├── layout.tsx                   # Root layout with Analytics
components/
├── scene.tsx                    # R3F canvas + postprocessing
├── orb.tsx                      # Central shader orb with volumetric glow
├── particles.tsx                # High-performance particle system
├── audio-engine.tsx             # Tone.js synthesis + analysis
└── ui.tsx                       # Start overlay and controls
lib/
├── wiki-stream.ts               # SSE client logic
├── particle-pool.ts             # Object pool for particles
└── utils.ts                     # Utility functions
public/
└── preview.png                  # Social preview image
```

## Getting Started

### Prerequisites

- Node.js 20+ (see `.tool-versions`)
- npm or your preferred package manager

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Build

```bash
npm run build
```

## Architecture

### Data Flow

```
Wikimedia SSE → Next.js API Route → Client SSE → Particle Pool + Audio Engine
                                                    ↓
                                              Shader Uniforms ← FFT Analysis
```

1. **Backend Proxy** — The `/api/wiki-stream` route consumes Wikimedia's SSE stream, filters for `edit` events, and normalizes metadata (size delta, bot/human, revert status)
2. **Client Dequeue** — Events are dequeued on the client and routed to both the particle system and audio engine
3. **Visual Synthesis** — Particles spawn at pseudorandom spherical coordinates; the orb shader receives displacement uniforms
4. **Audio Synthesis** — Tone.js synths trigger based on event type and magnitude
5. **Feedback Loop** — `Tone.Analyser` nodes extract frequency data that modulates shader uniforms every frame

## Customization

### Shader Parameters

Edit the shader material in `components/orb.tsx`:

```glsl
// Adjust turbulence intensity
float n = fbm(swirlP + fbm(swirlP.yzx * 0.75 + 9.2));

// Modify glow density
float sampleDensity = smoothstep(0.28, 0.95, turbulence) * radial;
```

### Audio Modes

Modify modal centers in `components/audio-engine.tsx`:

```typescript
const modalCenters = [
  ["C3", "G3", "E4", "B4"],  // Lydian-ish
  ["F3", "C4", "A4", "E5"],  // Mixolydian-ish
  // Add your own...
];
```

## Deployment

The app is optimized for [Vercel](https://vercel.com) deployment:

```bash
vercel
```

The `vercel.json` config enables streaming support for the SSE endpoint.

## Resources

- [Blog Post](https://www.joelraju.com/blog/sound-of-knowledge/) — Deep dive into the technical implementation
- [Wikimedia Event Streams](https://stream.wikimedia.org/v2/stream/recentchange) — Data source documentation
- [React Three Fiber Docs](https://docs.pmnd.rs/react-three-fiber) — 3D rendering in React
- [Tone.js Docs](https://tonejs.github.io/docs/) — Web Audio API abstraction

## License

Open source. Feel free to explore, fork, and build upon this project.

---

*Every byte added to Wikipedia becomes a note in an ever-evolving ambient composition.*

