Here is the advanced technical specification focused strictly on achieving that high-end, magical visual fidelity.

---

## 1. The Rendering Pipeline & Post-Processing (The "Glow" Engine)

The signature _Ori_ look is defined by intense, high-contrast light blooming in dark, atmospheric environments. You cannot achieve this with basic materials; it requires a robust post-processing stack.

- **Color Space & Tone Mapping:** * The renderer must be set to `renderer.outputColorSpace = THREE.SRGBColorSpace`.
- Use `THREE.ACESFilmicToneMapping` with an artificially elevated exposure (e.g., `1.5` to `2.0`). This allows core whites to blowout naturally while retaining rich colors in the falloff.

- **The Post-Processing Stack (`EffectComposer`):**
- **UnrealBloomPass:** This is non-negotiable. Standard additive blending looks flat without it. You need a multi-layered bloom. Set a low threshold (so most of the orb glows), a high strength (for the magical aura), and a wide radius.
- **SMAAPass:** Because post-processing breaks native MSAA, use Subpixel Morphological Antialiasing to keep the edges of your orb and particle trails buttery smooth.
- **Vignette & Chromatic Aberration (Subtle):** Add a custom pass to slightly darken the edges of the screen and slightly split the RGB channels at the periphery. This gives the camera a cinematic, physical lens feel.

---

## 2. Core Knowledge Orb (Volumetric & Ethereal Shader)

Your current shader relies heavily on surface displacement (`snoise` on an Icosahedron). To look magical, the orb shouldn't look like a solid physical object; it should look like a contained sphere of swirling energy.

- **Base Geometry:** Use a dense `SphereGeometry` (e.g., 128x128 for desktop, 64x64 for mobile).
- **The Fragment Shader (Volumetric Illusion):**
- **Raymarching:** Instead of just coloring the surface, use a simple raymarching loop inside the fragment shader. Shoot a ray through the sphere and sample 3D Simplex noise along the ray. This creates the illusion of deep, internal, swirling mist.
- **Iridescence (Thin-Film Interference):** Add a subtle iridescence function to the surface based on the viewing angle to give it a soap-bubble-like magical sheen.
- **Advanced Fresnel:** Calculate `pow(1.0 - dot(Normal, ViewDir), 4.0)`. Map this to your brightest cyan/white color. This creates the sharp edge-light typical of spirit energy.

- **Depth Fading (Soft Intersections):** * Pass the depth texture (`gl_FragCoord.z`) into your shader. When the orb intersects with other geometry (or itself), fade the alpha so you never see hard geometric clipping lines.

---

## 3. The Particle System (GPGPU & Curl Noise)

Updating 4,000 particles on the CPU inside `useFrame` will cause thermal throttling on mobile and limit your visual complexity. To push 10,000–50,000 particles effortlessly at 60fps, we must use GPGPU (General-Purpose computing on Graphics Processing Units).

- **FBO Simulation (Framebuffer Objects):**
- Store particle positions, velocities, and lifetimes in DataTextures (floating-point textures).
- Create a **Compute Shader** (a fragment shader that renders to these textures) to calculate physics.

- **Fluid Dynamics via Curl Noise:**
- In the compute shader, apply **Curl Noise** to the velocity texture. Unlike standard Perlin noise which pushes particles randomly, Curl Noise is divergence-free. It forces particles to swirl, eddy, and flow like a liquid or smoke, creating those beautiful, organic, tendril-like wisps seen in _Ori_.

- **Instanced Rendering:**
- Render the particles using `THREE.InstancedMesh` or a custom `Points` material.
- The vertex shader of the particles will read their current position from the FBO DataTexture using `texture2D`.

- **Velocity Alignment (Trails):**
- Instead of rendering perfect circles, stretch the particles along their velocity vector within the vertex shader. This fakes the look of motion blur and high-speed light streaks without the overhead of actual trail rendering.

---

## 4. Adaptive Performance Scaling

To hit 60fps consistently on both desktop and mobile, the visual complexity must scale dynamically based on the user's hardware.

- **Pixel Ratio Clamping:** Never run `window.devicePixelRatio` blindly. Clamp it for mobile devices: `renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))`. Pushing 3x retina resolutions on mobile GPUs will tank frame rates.
- **Tiered Visuals:**
- **Desktop (High Tier):** Raymarched volumetric core, 50,000 GPGPU particles, full SMAA, and wide-radius bloom.
- **Mobile (Low Tier):** Fallback to the layered Fresnel/rim-lighting shader (no raymarching) for the core, cap GPGPU particles at 10,000, and disable SMAA (relying on device pixel density instead).

- **Frustum Culling & Despawning:** Ensure off-screen particles are aggressively culled or immediately recycled in the compute shader to save fill rate.
