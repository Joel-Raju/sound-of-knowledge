# Sound of Knowledge - Basic Twitter Thread

**Main Post (1/4)**

Ever wondered what human collaboration sounds like? 🌌

I built "Sound of Knowledge"—a real-time, generative audiovisual experience driven by live Wikipedia edits.

Tech: Next.js + @reactthreefiber + Tone.js
sound-of-knowledge.vercel.app

_[Attach: 15s-30s screen recording]_

#webgl #threejs #generativeart

---

**Thread (2/4) — The Visuals 🎨**

The central orb is a custom procedural shader that breathes with the data stream.

🔹 Multi-scale noise displacement reacts to edit sizes
🔹 Particles spawn from the SSE stream via BufferGeometry
🔹 Volumetric fBm glow

#shaders #webgl #reactthreefiber

---

**Thread (3/4) — The Soundscape 🎵**

100% generative audio via Tone.js & Modal Harmony.

Massive rewrites trigger deep sub-basses and Shepard tones. Tiny typo fixes create high-frequency generative chimes. An ever-evolving ambient composition.

#webaudio #tonejs #sounddesign #generativemusic

---

**Thread (4/4) — How it works 🛠️**

Mapping a high-throughput SSE stream to a 3D scene without dropping frames was a challenge.

I'm writing a deep-dive engineering blog post covering the Next.js API, shader math, and generative Tone.js architecture:

Follow me on X for more updates!

#nextjs #typescript #webdev

The "Sound of Knowledge" deep dive is live! 🚀

From handling high-velocity SSE streams to building real-time generative audio with Tone.js—here’s how I mapped the pulse of Wikipedia into a 3D audiovisual experience.

Read the full breakdown: [blog post](https://www.joelraju.com/blog/sound-of-knowledge/)

#webgl #creativecoding #nextjs
