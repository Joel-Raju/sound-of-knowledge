/**
 * Shockwave ring shaders. Spec §9.6.
 *
 * Rings are instanced billboards, capacity 24 — small, because they are a
 * punctuating event (a revert) rather than ambient motion. Each is a single
 * expanding quad; the ring itself is drawn in the fragment stage from the
 * quad's `uv`.
 *
 * Billboarded in **view space** rather than world space, so the ring always
 * faces the camera and reads as a shockwave rather than a disc lying in a
 * plane.
 */
import { HASH_GLSL } from "./noise.glsl";

/** §9.6 — every ring expands for the same 2.2 s. */
export const RING_DURATION = 2.2;

export const RINGS_VERT = /* glsl */ `
precision highp float;

${HASH_GLSL}

uniform float uTime;

in vec3 aOrigin;
in vec2 aTimes;   // start, duration
in vec3 aColor;

/**
 * position and uv come from three.js's own vertex prefix — see the note in
 * sparks.shader.ts. Redeclaring them fails to link.
 */

out vec2 vUv;
out float vU;
out vec3 vColor;

void main() {
  float age = uTime - aTimes.x;

  if (age < 0.0 || age > aTimes.y) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vUv = uv;
    vU = 1.0;
    vColor = vec3(0.0);
    return;
  }

  float u = age / aTimes.y;

  // easeOutCubic (§9.6) — fast out of the gate, easing as it grows, which is
  // what makes it read as an impact rather than an expansion.
  float e = 1.0 - pow(1.0 - u, 3.0);
  // Not named "half": that is a reserved word in GLSL, and using it is a hard
  // compile error rather than anything that degrades quietly.
  float halfSpan = mix(0.1, 3.5, e);

  vec4 mv = viewMatrix * vec4(aOrigin, 1.0);
  mv.xy += position.xy * halfSpan * 2.0;
  gl_Position = projectionMatrix * mv;

  vUv = uv;
  vU = u;
  vColor = aColor;
}
`;

export const RINGS_FRAG = /* glsl */ `
precision highp float;

in vec2 vUv;
in float vU;
in vec3 vColor;

out vec4 outColor;

void main() {
  // Distance from the quad's centre, 0 at the middle, 1 at a corner.
  float d = length(vUv - 0.5) * 2.0;

  // The ring's own radius follows the same ease as its quad, so the drawn band
  // stays a constant *fraction* of the expanding edge instead of drifting
  // inside it.
  float r = 1.0 - pow(1.0 - vU, 3.0);

  // Thins as it grows: a shockwave loses definition as it spreads.
  float th = mix(0.10, 0.02, vU);

  float ring = smoothstep(r - th, r, d) * (1.0 - smoothstep(r, r + th, d));
  float intensity = ring * pow(1.0 - vU, 2.0) * 2.5;

  float alpha = intensity;
  if (alpha <= 0.0) discard;
  outColor = vec4(vColor * alpha, alpha);
}
`;