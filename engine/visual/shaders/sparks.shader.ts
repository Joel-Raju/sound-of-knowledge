/**
 * Spark vertex shader. Spec §9.5.
 *
 * **Stateless**: a particle's entire position is a pure function of
 * `(uTime − spawnTime)` and its per-instance attributes. Nothing is simulated
 * frame to frame, there are no ping-pong buffers, and the CPU never reads a
 * particle back. That is what makes the capacity free to leave at `CAP`: an
 * idle instance costs a few ALU ops and one clipped vertex, not a slot in a
 * simulation.
 *
 * The cost of that choice is that every instance is evaluated every frame,
 * whether alive or not. Dead particles are pushed outside the frustum
 * (`gl_Position = vec4(2.0, ...)`) rather than branching the draw call, which
 * is why capacity can be 24 576.
 */
import { HASH_GLSL } from "./noise.glsl";

export const SPARKS_VERT = /* glsl */ `
precision highp float;

${HASH_GLSL}

uniform float uTime;

/** Per-instance, all DynamicDrawUsage (§9.5). */
in vec3 aOrigin;
in vec3 aTarget;
in vec4 aTimes;   // spawnTime, duration, delay, seed
in vec4 aStyle;   // kind (0 streak, 1 bot pulse, 2 burst), size, jIndex01, brightness
in vec3 aColor;

/**
 * The unit quad's position and uv attributes are **not** declared here — three.js's
 * vertex prefix supplies both (WebGLProgram.js:625), and under GLSL3 its
 * "attribute to in" define turns them into "in" declarations. Declaring them again
 * is a redefinition error and the shader silently fails to link.
 */

out vec3 vColor;
out float vAlpha;
out vec2 vUv;
out float vKind;

const float PI = 3.141592653589793;

void main() {
  float kind = aStyle.x;
  float age = uTime - aTimes.x - aTimes.z;

  // Dead: before its delay elapses, or past its duration. Clipped by putting the
  // vertex outside the clip volume rather than by discarding, which would not be
  // possible here anyway — a vertex shader has no discard.
  if (age < 0.0 || age > aTimes.y) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vColor = vec3(0.0);
    vAlpha = 0.0;
    vUv = uv;
    vKind = kind;
    return;
  }

  float u = age / aTimes.y;
  vec3 pos;
  float size = aStyle.y;
  float alpha = 1.0;
  float bright = aStyle.w;

  if (kind < 0.5) {
    // Streak — a human edit. Accelerates toward the core, follows a curved
    // path, and its size peaks mid-flight so it reads as a comet rather than a
    // line being drawn.
    float e = pow(u, 1.6);
    vec3 dir = normalize(aTarget - aOrigin);
    vec3 perp = normalize(cross(dir, hashVec3(aTimes.w)));
    float curve = sin(u * PI) * (0.35 + 0.65 * hash11(aTimes.w)) * 0.9;
    pos = mix(aOrigin, aTarget, e)
        + perp * curve * (1.0 - u)
        + (hashVec3(aTimes.w + aStyle.z * 17.0) - 0.5) * 0.05;
    size *= (0.5 + 0.5 * sin(u * PI)) * (1.0 - 0.6 * aStyle.z);
    alpha = smoothstep(0.0, 0.1, u) * (1.0 - smoothstep(0.8, 1.0, u));
  } else if (kind < 1.5) {
    // Bot pulse — straight and fast, flashing on arrival so routine bot edits
    // register without demanding attention.
    pos = mix(aOrigin, aTarget, u);
    bright *= 1.0 + 3.0 * smoothstep(0.85, 1.0, u);
    alpha = 1.0 - smoothstep(0.9, 1.0, u);
  } else {
    // Burst — a new page. Radial with drag, twinkling.
    vec3 v = (hashVec3(aTimes.w + aStyle.z * 31.0) - 0.5) * 2.0
           * (0.6 + 1.4 * hash11(aTimes.w + aStyle.z));
    pos = aOrigin + v * (1.0 - exp(-3.2 * u)) / 3.2 * 0.9;
    size *= pow(1.0 - u, 1.5);
    bright *= 1.0 + 0.4 * sin(uTime * 20.0 + aTimes.w * 50.0);
    alpha = 1.0 - smoothstep(0.6, 1.0, u);
  }

  // Billboard in view space: offset in the camera's plane, so the quad always
  // faces the viewer without a CPU-side orientation matrix per particle.
  vec4 mv = viewMatrix * vec4(pos, 1.0);
  mv.xy += position.xy * size;
  gl_Position = projectionMatrix * mv;

  vColor = aColor * bright;
  vAlpha = alpha;
  vUv = uv;
  vKind = kind;
}
`;

/**
 * Spark fragment shader. Spec §9.5.
 *
 * Two shapes: a soft disc for streaks and bursts, a diamond for bot pulses. The
 * diamond is not decoration — a dot-and-diamond distinction is what lets a
 * glance separate "an edit happened" from "a bot touched the page" at the size
 * these actually render.
 *
 * Output is premultiplied by `a`, which is what additive blending wants:
 * `vec4(vColor * a * vAlpha, a * vAlpha)` keeps colour and coverage consistent
 * at the soft edge, where a non-premultiplied form would ring.
 */
export const SPARKS_FRAG = /* glsl */ `
precision highp float;

in vec3 vColor;
in float vAlpha;
in vec2 vUv;
in float vKind;

out vec4 outColor;

void main() {
  vec2 c = vUv - 0.5;
  float a;
  if (vKind < 1.5) {
    // Soft disc: kinds 0 (streak) and 2 (burst).
    a = pow(1.0 - clamp(2.0 * length(c), 0.0, 1.0), 2.0);
  } else {
    // Diamond: kind 1 (bot pulse).
    a = clamp(1.0 - 2.0 * (abs(c.x) + abs(c.y)), 0.0, 1.0);
  }
  float alpha = a * vAlpha;
  if (alpha <= 0.0) discard;
  outColor = vec4(vColor * alpha, alpha);
}
`;