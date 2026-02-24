export const orbVertexShader = /* glsl */ `
  varying vec3 vLocalPos;
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;

  void main() {
    vLocalPos = position;
    vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
    vWorldNormal = normalize(normalMatrix * normal);

    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const orbVolumetricFragmentShader = /* glsl */ `
  uniform float uTime;
  uniform float uAmplitude;
  uniform float uLowFreq;
  uniform float uHighFreq;
  uniform float uDisplace;
  uniform vec3  uBaseColor;
  uniform vec3  uEmissiveColor;
  uniform float uIsRevert;
  uniform float uRadius;

  varying vec3 vLocalPos;
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;

  float hash31(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  float noise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);

    float n000 = hash31(i + vec3(0.0, 0.0, 0.0));
    float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash31(i + vec3(1.0, 1.0, 1.0));

    float nx00 = mix(n000, n100, f.x);
    float nx10 = mix(n010, n110, f.x);
    float nx01 = mix(n001, n101, f.x);
    float nx11 = mix(n011, n111, f.x);
    float nxy0 = mix(nx00, nx10, f.y);
    float nxy1 = mix(nx01, nx11, f.y);
    return mix(nxy0, nxy1, f.z);
  }

  float fbm(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      v += noise3(p) * a;
      p = p * 2.02 + vec3(17.1, 7.7, 11.4);
      a *= 0.5;
    }
    return v;
  }

  vec2 sphereIntersect(vec3 ro, vec3 rd, vec3 center, float radius) {
    vec3 oc = ro - center;
    float b = dot(oc, rd);
    float c = dot(oc, oc) - radius * radius;
    float h = b * b - c;
    if (h < 0.0) return vec2(-1.0);
    h = sqrt(h);
    return vec2(-b - h, -b + h);
  }

  vec3 iridescence(float ndv) {
    float t = (1.0 - ndv) * 0.8 + uTime * 0.03;
    return 0.5 + 0.5 * cos(6.28318 * (vec3(1.0, 1.3, 1.7) * t + vec3(0.0, 0.15, 0.35)));
  }

  void main() {
    vec3 center = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    vec3 ro = cameraPosition;
    vec3 rd = normalize(vWorldPos - cameraPosition);

    vec2 hit = sphereIntersect(ro, rd, center, uRadius);
    if (hit.x < 0.0 && hit.y < 0.0) discard;

    float tNear = max(hit.x, 0.0);
    float tFar = max(hit.y, tNear + 0.001);
    float span = tFar - tNear;
    float stepSize = span / 24.0;
    float t = tNear;

    float density = 0.0;
    float glowAccum = 0.0;
    for (int i = 0; i < 24; i++) {
      vec3 pos = ro + rd * t;
      vec3 local = (pos - center) / uRadius;
      float radial = 1.0 - clamp(length(local), 0.0, 1.0);

      vec3 swirlP = local * 3.3 + vec3(0.0, uTime * 0.35, 0.0);
      float n = fbm(swirlP + fbm(swirlP.yzx * 0.75 + 9.2));
      float turbulence = n * 0.75 + sin((local.y + uTime * 0.45) * 6.0) * 0.25;

      float sampleDensity = smoothstep(0.28, 0.95, turbulence) * radial;
      density += sampleDensity * stepSize;
      glowAccum += sampleDensity * (0.7 + radial * 0.8);

      t += stepSize;
    }

    density *= 2.2 + uAmplitude * 1.8 + uLowFreq * 0.9;
    glowAccum *= 0.2 + uHighFreq * 0.25;

    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float ndv = clamp(dot(normalize(vWorldNormal), viewDir), 0.0, 1.0);
    float fresnel = pow(1.0 - ndv, 4.0);

    vec3 iri = iridescence(ndv);
    vec3 base = mix(uBaseColor, uEmissiveColor, 0.45 + uAmplitude * 0.25);
    vec3 innerMist = mix(base, vec3(0.82, 0.95, 1.0), density * 0.22);
    vec3 edgeGlow = mix(vec3(0.0, 0.9, 1.0), vec3(1.0), fresnel);
    vec3 chroma = mix(vec3(1.0), iri, 0.18 + fresnel * 0.55);

    vec3 color = innerMist * (0.6 + density * 0.6);
    color += edgeGlow * (fresnel * (2.4 + uAmplitude * 1.2));
    color += uEmissiveColor * glowAccum * 0.8;

    vec3 revertTint = vec3(0.72, 0.2, 0.95);
    color = mix(color, color + revertTint * (0.45 + fresnel), uIsRevert);
    color *= chroma;

    float depthFade = smoothstep(0.02, 0.20, span);
    float alpha = clamp(density * 0.32 + fresnel * 0.68, 0.0, 1.0) * depthFade;

    gl_FragColor = vec4(color, alpha);
  }
`;

export const orbFallbackFragmentShader = /* glsl */ `
  uniform float uTime;
  uniform float uAmplitude;
  uniform float uLowFreq;
  uniform float uHighFreq;
  uniform vec3  uBaseColor;
  uniform vec3  uEmissiveColor;
  uniform float uIsRevert;

  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;

  void main() {
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float ndv = max(dot(normalize(vWorldNormal), viewDir), 0.0);
    float fresnel = pow(1.0 - ndv, 4.0);
    float wideRim = pow(1.0 - ndv, 1.25);

    vec3 core = mix(uBaseColor, vec3(0.85, 0.95, 1.0), ndv * 0.75);
    vec3 rim = mix(vec3(0.0, 0.75, 0.92), vec3(1.0), fresnel);

    vec3 iridescence = 0.5 + 0.5 * cos(vec3(0.0, 1.7, 3.1) + (1.0 - ndv) * 7.0 + uTime * 0.04);
    vec3 color = core + rim * (0.75 + uLowFreq * 0.35) * wideRim;
    color += uEmissiveColor * (0.22 + uAmplitude * 0.55 + uHighFreq * 0.25);
    color *= mix(vec3(1.0), iridescence, 0.15 + fresnel * 0.35);

    color = mix(color, color + vec3(0.6, 0.1, 0.85) * (0.3 + fresnel), uIsRevert);

    float alpha = clamp(0.45 + wideRim * 0.4 + fresnel * 0.35, 0.0, 1.0);
    gl_FragColor = vec4(color, alpha);
  }
`;
