/**
 * Core orb fragment shader. Spec §9.4.
 *
 * Not a surface shader: a **volumetric ray march** from the camera through the
 * sphere's bounding geometry, accumulating emission front to back. That is why
 * `vWorldPos` is a world position and not a screen coordinate — each fragment
 * re-derives its own ray from the camera through the point the vertex stage
 * produced, then samples the noise field along it.
 *
 * The expensive part is `uSteps` iterations, each running `fbm` (which is
 * `uOctaves` `snoise` calls). That product is the orb's entire per-frame cost,
 * and `probe:shader` measured it at 50.7 ms/frame on the *lowest* tier under
 * swiftshader — see DECISIONS.md, "The orb's shader compile is free; its frame
 * is not". A resolution clamp on the orb is still an open design decision.
 */
import { FBM_GLSL, FLOW_GLSL, IGN_GLSL, SNOISE_GLSL } from "./noise.glsl";
import { IMPACT_SLOTS, MAX_OCTAVES, MAX_STEPS } from "./orb.vert";

export const ORB_FRAG = /* glsl */ `
precision highp float;

${SNOISE_GLSL}
${FBM_GLSL}
${IGN_GLSL}
${FLOW_GLSL}

uniform float uTime;
uniform float uFrame;
uniform vec3 uCoreColor;
uniform vec3 uAccentColor;
uniform vec3 uDeep;
uniform float uRms;
uniform float uBass;
uniform float uMid;
uniform float uHigh;
uniform float uFlux;
uniform int uSteps;
uniform int uOctaves;
// March-jitter amplitude, as a fraction of one stepLen. Spec §9.4 is 1.0.
//
// §9.4's own words are that the offset exists "to hide banding". At full
// amplitude, with only 3–8 march steps, there is too little averaging per pixel
// to dissolve a one-step displacement, so the dither is itself plainly visible
// as a diagonal lattice — the banding is traded for noise rather than hidden.
// Measurement and rationale in DECISIONS.md.
uniform float uJitter;
/** C11 — scales the whole accumulated emission. 1.0 is §9.4 as written. */
uniform float uEmission;
/** C11 — per-step absorption. 3.2 is §9.4 as written. */
uniform float uAbsorb;
uniform vec4 uImpactA[${IMPACT_SLOTS}];
uniform vec4 uImpactB[${IMPACT_SLOTS}];

in vec3 vWorldPos;
in vec3 vNormalW;

out vec4 outColor;

void main() {
  // Analytic ray-sphere intersection (§9.4). R is the core radius 1.2 plus 5 %,
  // so the marched volume encloses the displaced surface.
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWorldPos - cameraPosition);
  const float R = 1.2 * 1.05;

  float b = dot(ro, rd);
  float c = dot(ro, ro) - R * R;
  float disc = b * b - c;
  // The geometry is the sphere, so this should never fire; it is here because a
  // NaN in the uniforms makes disc NaN, and NaN silently discards every
  // fragment — which looks exactly like a shader that failed to compile.
  if (disc < 0.0) discard;
  float sq = sqrt(disc);
  float t0 = -b - sq;
  float t1 = -b + sq;
  float stepLen = (t1 - t0) / float(${MAX_STEPS});

  // Per-pixel jitter (§9.4). uFrame moves it each frame so the dither pattern
  // does not sit still and read as texture. Scaled by uJitter — see its
  // declaration for why the spec's 1.0 reads as a lattice rather than as
  // dissolved banding.
  float jitter = ign(gl_FragCoord.xy + uFrame) * uJitter;

  vec3 col = uDeep * 0.5;
  float trans = 1.0;

  for (int i = 0; i < ${MAX_STEPS}; i++) {
    if (i >= uSteps) break;
    float t = t0 + (float(i) + jitter) * stepLen;
    vec3 p = ro + rd * t;
    // 0 at the centre of the volume, 1 at its surface.
    float rr = length(p) / R;
    // snoise is signed, about [-1,1], so raw fbm lands near ±0.4 and the
    // (1 - rr*rr) factor narrows it further. §9.4's smoothstep(0.15, 0.85, …)
    // window only makes sense against a [0,1] signal, so the field is normalised
    // into one first — otherwise nearly every fragment maps to 0 and the orb
    // renders as a dark shell with a bright rim. Deviation and measurement in
    // DECISIONS.md.
    float n = fbm(p * 1.7 + flow(uTime), uOctaves) * 0.5 + 0.5;
    // Denser toward the core — the orb reads as a luminous heart rather than a
    // hollow shell.
    float d = n * (1.0 - rr * rr);
    d = smoothstep(0.15, 0.85, d + 0.25 * uMid);
    vec3 emit = mix(uCoreColor, uAccentColor,
      smoothstep(0.2, 0.9, rr + 0.3 * snoise(p * 3.0 + uTime * 0.2)));
    // Per-step absorption. §9.4 has 3.2 written in.
//
// This is where the core's detail is lost. The transmittance variable decays by a
// every step, so
// deep in the volume — where the ray meets dense material on every step — the sum
// of a approaches 1, the accumulated colour converges on the emitted one regardless of how
// the density varies, and the fbm structure is cancelled out before anything downstream
// sees it. Scaling the colour (uEmission, C11) cannot recover detail that is
// already gone; this is the term that destroys it.
float a = 1.0 - exp(-d * stepLen * uAbsorb);
    col += trans * a * emit * (1.2 + 2.0 * uRms + 1.5 * uFlux);
    trans *= (1.0 - a);
  }

  // Fresnel rim (§9.4) — the silhouette lift that keeps the orb legible against
  // a dark background and gives it a sense of volume.
  float fres = pow(1.0 - clamp(dot(normalize(vNormalW), -rd), 0.0, 1.0), 3.0);
  col += fres * mix(uAccentColor, uCoreColor, 0.5) * (0.6 + 1.5 * uHigh);

  // Localized glow near recent impacts (§9.4). A second, wider and slower falloff
  // than the vertex stage's ripple, so a fresh impact lights the surface as well
  // as deforming it.
  float glow = 0.0;
  for (int i = 0; i < ${IMPACT_SLOTS}; i++) {
    float s = uImpactA[i].w;
    if (s <= 0.0) continue;
    float age = uTime - uImpactB[i].x;
    if (age < 0.0 || age > 2.5) continue;
    float ang = acos(clamp(dot(normalize(vWorldPos), uImpactA[i].xyz), -1.0, 1.0));
    glow += s * exp(-ang * 6.0) * exp(-age * 2.0);
  }
  col += glow * uAccentColor;

  // Emission scale. §9.4 accumulates density front to back, and near the centre the
  // ray spends a long time inside dense material — enough that the core saturates
  // well above 1.0 before it ever reaches a tone-mapping curve.
  //
  // C11 established this is **not** fixable downstream: with AgX *and* with ACES
  // *and* with bloom disabled, the core is a structureless pale wash. Nothing
  // recovers a field that is already saturated at source, so the scale has to be
  // applied here. See DECISIONS.md.
  col *= uEmission;

  // Additive (§9.2): alpha is irrelevant to the blend, but a fragment that
  // writes 0 alpha with additive blending is still added, so this is not a
  // transparency signal.
  outColor = vec4(col, 1.0);
}
`;

/** Injected as a `#define` so the loops' constant bounds match §9.4. */
export const ORB_DEFINES = {
  SOK_MAX_OCTAVES: MAX_OCTAVES,
} as const;
