# Sound of Knowledge — Technical Specification (Extended Visual Spec)

## 1. Overview

Sound of Knowledge is a real-time audiovisual web experience that converts live Wikipedia edits into generative sound and 3D visuals. Each edit becomes a sonic and visual gesture whose intensity reflects the magnitude of the change.

The project is built using Next.js and Three.js and relies exclusively on free, public data sources.

---

## 2. Goals

- Subscribe to all live Wikipedia edit events
- Classify edits by magnitude and type
- Translate edits into sound
- Render a continuously evolving 3D visualization
- Ensure smooth performance during edit spikes
- Require zero paid APIs

---

## 3. Tech Stack

### Frontend

- Next.js (App Router)
- React
- Three.js
- @react-three/fiber
- @react-three/drei
- Web Audio API or Tone.js
- Zustand (or equivalent)

### Backend

- Next.js API route or Edge Function
- Server-Sent Events (SSE)
- Optional WebSocket fan-out

### Data Source

- Wikimedia EventStreams (recentchange)

---

## 4. High-Level Architecture

Wikimedia SSE Stream  
→ Server Filter + Normalizer  
→ Client Event Queue  
→ Audio Engine + Visual Engine

---

## 5. Event Normalization

```ts
type WikiEditEvent = {
  id: string;
  title: string;
  sizeDelta: number;
  isBot: boolean;
  isRevert: boolean;
  timestamp: number;
};
```

---

## 6. Edit Classification

| Magnitude | Byte Delta      |
| --------- | --------------- |
| TINY      | 1–50            |
| SMALL     | 51–500          |
| MEDIUM    | 501–5000        |
| LARGE     | 5000+ or revert |

---

## 7. Visual Design Philosophy

The visualization represents Wikipedia as a living, breathing organism.

Key principles:

- Always in motion
- Never repeats exactly
- Reactive, not illustrative
- Abstract rather than literal

The scene should feel like an instrument being played by humanity in real time.

---

## 8. Scene Composition

### Canvas

- Fullscreen WebGL canvas
- Fixed camera with slow orbital movement
- Dark background (near-black or deep blue)

### Lighting

- Ambient light (low intensity)
- One primary point or directional light
- Subtle bloom postprocessing
- No harsh shadows

---

## 9. Core Knowledge Object

### Geometry

- Procedural sphere, icosahedron, or metaball-based mesh
- Subdivided enough to support smooth deformation
- Centered at origin

### Material

- Custom shader material
- Properties:
  - Base color
  - Emissive color
  - Noise-based vertex displacement
  - Audio-reactive uniforms

### Idle Animation

- Slow rotation on multiple axes
- Low-amplitude noise displacement over time
- Gentle pulsing even with no edits

---

## 10. Particle System (Edit Events)

### Purpose

Each Wikipedia edit spawns a transient particle or cluster representing that action.

### Implementation

- GPU-instanced particles
- Billboarded quads or points
- Additive blending

### Particle Lifecycle

1. Spawn at core surface or random orbit radius
2. Move outward or along curved paths
3. Fade opacity and scale
4. Despawn

---

## 11. Visual Mapping by Edit Magnitude

### TINY Edits

- Single small particle
- Minor shimmer on core surface
- Very short-lived ripple
- Slight emissive flicker

### SMALL Edits

- Small pulse wave through core
- Short particle streak
- Minor geometry displacement
- Subtle color shift

### MEDIUM Edits

- Noticeable mesh deformation
- Cluster of particles emitted
- Expanding ring or shock ripple
- Temporary bloom increase

### LARGE Edits / Reverts

- Strong displacement of core geometry
- Large particle burst
- Radial shockwave
- Camera micro-zoom or shake
- Color inversion or darker palette flash

---

## 12. Color System

### Base Palette

- Cool tones (blue, violet, cyan)
- Low saturation by default

### Dynamic Coloring

- Positive edits: brighter hues
- Negative edits: darker, muted tones
- Reverts: red/orange accents
- Bot edits: neutral or metallic colors

---

## 13. Shader Details

### Vertex Shader

- Perlin/Simplex noise displacement
- Noise amplitude controlled by:
  - Audio amplitude
  - Edit magnitude
- Time-based smooth animation

### Fragment Shader

- Emissive glow based on audio energy
- Soft Fresnel edge glow
- Smooth gradient color blending

---

## 14. Audio–Visual Coupling

- Master audio amplitude → emissive intensity
- Low frequencies → large-scale mesh movement
- High frequencies → particle velocity and sparkle
- Edit events trigger one-shot visual impulses

---

## 15. Performance Constraints

- Target 60 FPS desktop
- Cap max particles
- Use instancing wherever possible
- Avoid allocations in render loop
- Graceful degradation on mobile

---

## 16. UX

- No traditional UI elements
- Optional minimal overlay (toggleable):
  - Live edit count
  - Intensity meter
- Autoplay idle animation when no edits occur

---

## 17. Definition of Done

- Live Wikipedia edits clearly influence visuals
- Edit magnitude is visually distinguishable
- Scene feels alive even during low activity
- Stable performance under heavy edit volume
- Fully functional using free infrastructure only
