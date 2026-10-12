/**
 * Shared GLSL chunks. Spec §9.4.
 *
 * These are template strings, not modules — they are pasted into the orb's
 * vertex and fragment sources, and nowhere else. Keeping them here rather than in
 * the orb files is what lets the same `snoise` appear in both stages without
 * duplicating ~50 lines of noise.
 */

/**
 * 3D simplex noise, from Ashima Arts' webgl-noise (MIT).
 *
 * §9.4 names this exact implementation, and it is the standard one — any other
 * 3D simplex has a different range and the orb's look would drift. Kept
 * byte-faithful to upstream except for whitespace, because "equivalent" here
 * means numerically identical: `fbm` sums this eight times per march step and
 * small differences accumulate visibly in the banding pattern.
 */
export const SNOISE_GLSL = /* glsl */ `
vec3 sok_mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 sok_mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 sok_permute(vec4 x) { return sok_mod289(((x * 34.0) + 10.0) * x); }
vec4 sok_taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

  i = sok_mod289(i);
  vec4 p = sok_permute(sok_permute(sok_permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  vec4 norm = sok_taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

/**
 * Fractal Brownian motion over `snoise`. Spec §9.4.
 *
 * The octave count arrives as a uniform rather than being baked into the source,
 * so §9.10's L3 ("octaves 2") and §12.3's per-tier octaves are one uniform write
 * rather than three shader variants. The loop is bounded by a constant and
 * broken on the uniform because GLSL ES 3.0 still requires a constant-expression
 * loop bound for reliable compilation on some drivers.
 */
export const FBM_GLSL = /* glsl */ `
float fbm(vec3 p, int octaves) {
  float amp = 0.5;
  float sum = 0.0;
  for (int i = 0; i < SOK_MAX_OCTAVES; i++) {
    if (i >= octaves) break;
    sum += amp * snoise(p);
    p *= 2.02;
    amp *= 0.5;
  }
  return sum;
}
`;

/**
 * Interleaved-gradient noise, §9.4: `fract(52.9829189 * fract(dot(xy, ...)))`.
 *
 * Used as the per-pixel march jitter. The orb is a 3–8 step ray march; without a
 * jitter the step boundaries quantise into visible concentric bands, and a
 * *per-pixel* dither is what dissolves them — a per-frame constant would just
 * move the bands.
 */
export const IGN_GLSL = /* glsl */ `
float ign(vec2 xy) {
  return fract(52.9829189 * fract(dot(xy, vec2(0.06711056, 0.00583715))));
}
`;

/**
 * §9.4's slow 3D flow offset. Extracted so the vertex and fragment stages agree
 * on where the noise field is drifting to; a mismatch shows as the surface
 * sliding relative to the interior.
 */
export const FLOW_GLSL = /* glsl */ `
vec3 flow(float t) { return vec3(0.0, t * 0.05, t * 0.03); }
`;
