# Sound of Knowledge - Twitter Thread

**Main Post (1/4)**

Ever wondered what human collaboration sounds like? 🌌

I built "Sound of Knowledge"—a real-time, generative audiovisual experience driven by live Wikipedia edits.

Every edit is a particle. Every byte is a note.

Tech: @Next.js + @reactthreefiber + WebGL + Web Audio API
Experience it here (sound on 🔊): sound-of-knowledge.vercel.app

_[Attach: 15s-30s screen recording of the app]_

---

**Thread (2/4) — The Visuals 🎨**

The visuals are powered by Three.js & R3F. The central orb isn't a static mesh—it's a custom procedural shader that breathes with the data stream.

🔹 Multi-scale noise displacement shaders react to edit sizes in real-time
🔹 Particles spawn dynamically from the live SSE stream using instanced BufferGeometry
🔹 Custom volumetric glow using AdditiveBlending and Fractional Brownian Motion (fBm)
🔹 Cinematic camera drift that reacts to massive edits

Runs buttery smooth, fully optimized for mobile WebGL with automatic quality scaling.

---

**Thread (3/4) — The Soundscape 🎵**

There are no samples. No loops.

The audio is 100% generative, synthesized in real-time using Tone.js and the native Web Audio API.

As edits stream in, their metadata (size, bot vs human, reverts) drives the synthesis engine. Massive article rewrites trigger deep, resonant sub-basses and Shepard tones, while tiny typo fixes create high-frequency generative chimes based on Modal Harmony. It creates an ever-evolving, zen-like ambient composition.

---

**Thread (4/4) — How it works 🛠️**

Mapping a high-throughput Server-Sent Events (SSE) stream to a 3D scene without dropping frames was a challenge.

I'm writing a deep-dive engineering blog post covering:
• Handling high-velocity SSE at scale in Next.js
• Shader math for procedural animation and volumetric effects
• Building responsive 3D/WebGL experiences for mobile
• Generative audio routing architecture using Tone.js

Drop a follow if you want to read it when it drops! 👇

#webgl #threejs #nextjs #creativecoding #generative #opensource
