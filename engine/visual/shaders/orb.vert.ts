/**
 * Core orb vertex shader. Spec §9.4.
 *
 * The orb's surface is displaced by three things: a slow noise field, the
 * audio features, and the **impact ripples** — the 16 slots that turn an edit
 * into a visible wave travelling across the surface. Impacts are the only part
 * with a loop, and it is bounded at 16 because that is the ring buffer's size;
 * §9.4 caps it deliberately, because an unbounded loop here is per-vertex.
 *
 * GLSL3 (`in`/`out`) — three.js supplies `position`, `normal`,
 * `modelViewMatrix`, `projectionMatrix` and `cameraPosition`, so none of them
 * are declared here.
 */
import { FBM_GLSL, FLOW_GLSL, IGN_GLSL, SNOISE_GLSL } from "./noise.glsl";

/** §9.4 — the impact ring buffer is 16 slots, mirrored as a constant for GLSL. */
export const IMPACT_SLOTS = 16;

/** §9.4 — `MAX_STEPS = 8`. The loop is bounded by this and broken on `uSteps`. */
export const MAX_STEPS = 8;

/** §9.4 — fbm octave ceiling. §12.3 tops out at 3, high tier. */
export const MAX_OCTAVES = 3;

export const ORB_VERT = /* glsl */ `
precision highp float;

${SNOISE_GLSL}
${FBM_GLSL}
${IGN_GLSL}
${FLOW_GLSL}

uniform float uTime;
uniform float uFrame;
uniform float uRms;
uniform float uBass;
uniform int uSteps;
uniform int uOctaves;
uniform vec4 uImpactA[${IMPACT_SLOTS}];   // xyz = direction, w = strength
uniform vec4 uImpactB[${IMPACT_SLOTS}];   // x = startTime, y = kind (0 push, 1 dent)

out vec3 vWorldPos;
out vec3 vNormalW;

void main() {
  vec3 dir = normalize(position);
  float n = snoise(dir * 1.6 + vec3(0.0, 0.0, uTime * 0.15));
  float disp = (0.05 + 0.10 * uBass) * n;

  // Impact ripples: a ring expanding from the impact point, decaying with both
  // angular distance and age. Accumulated, not overwritten, so overlapping
  // impacts reinforce rather than replace one another.
  float ripple = 0.0;
  for (int i = 0; i < ${IMPACT_SLOTS}; i++) {
    float s = uImpactA[i].w;
    if (s <= 0.0) continue;
    float age = uTime - uImpactB[i].x;
    if (age < 0.0 || age > 2.5) continue;
    float ang = acos(clamp(dot(dir, uImpactA[i].xyz), -1.0, 1.0));
    float w = sin(ang * 18.0 - age * 9.0) * exp(-ang * 3.0) * exp(-age * 1.6) * s;
    ripple += (uImpactB[i].y > 0.5 ? -1.0 : 1.0) * w;
  }

  float r = 1.0 + disp + 0.06 * ripple + 0.03 * uRms;
  vec3 p = dir * 1.2 * r;

  vWorldPos = p;
  // The undisplaced normal, passed down: the fragment stage uses it for the
  // fresnel rim, and displacing it here would make the rim track the ripple
  // noise rather than the sphere's silhouette.
  vNormalW = normalize(normal);

  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;
