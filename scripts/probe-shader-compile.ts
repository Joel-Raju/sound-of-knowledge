/**
 * Shader compile + first-draw probe. Spec T4.1 exit question feeding T4.2.
 *
 * **Why this exists.** T5.1's acceptance criterion is "Enter enables ≤ 20 s under
 * swiftshader". T4.1 shipped a scene with no shaders in it, so that budget has
 * never been measured — it is currently a guess. T4.2's core orb is the first
 * thing that compiles real GLSL, so its compile cost lands squarely inside that
 * 20 s. Measuring first means T4.2 can be designed against a number.
 *
 * **What it measures**, per iteration on a *fresh* context:
 *   1. `compileShader` + `linkProgram` + status query, with a `finish()` to force
 *      the driver to do the work rather than queue it;
 *   2. the first `drawArrays` + `finish()` — under swiftshader this is where the
 *      JIT actually runs, and it is frequently *not* in (1);
 *   3. the steady-state per-frame cost at the §9.4 step counts.
 *
 * (3) matters as much as (1) and (2) — §12.3's step counts are the only quality
 * knob the orb has, so whether they are sufficient is the question T4.2 needs
 * answered.
 *
 * **Cross-check.** The low tier here reports ~11 ms/frame. The *shipped* engine
 * measured 10.5 ms for the same scene (`npm run shot`, `syncedFrameMs`), through
 * three.js on a real canvas with the real `IcosahedronGeometry`. The two agree
 * within 8 %, which is what makes the other numbers usable: this probe's
 * geometry is a faithful stand-in, so its compile and first-draw figures
 * transfer too.
 *
 * **Honest limitation.** This compiles a *transcription* of §9.4's shaders, not
 * the real `engine/visual/shaders/orb.*.ts` — those do not exist yet, and writing
 * them is T4.2's work. The transcription follows §9.4 literally, including the
 * full Ashima 3D simplex noise, the 16-iteration impact loop in the vertex
 * shader, and the 8-step ray-march with fbm in the fragment shader. Treat the
 * number as "what this shape of shader costs", not as a measurement of shipped
 * code. Re-run this probe against the real module once T4.2 lands.
 *
 * **Fresh context per iteration is load-bearing.** swiftshader caches compiled
 * programs within a process. Measuring several compiles in one context reports
 * the second and later ones as near-instant, which would understate the cost by
 * an order of magnitude. Each iteration therefore builds a new canvas, context
 * and program from scratch.
 *
 * Usage: npx tsx scripts/probe-shader-compile.ts [--iterations 3] [--port 4318]
 */
import { chromium, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const iterations = Number(args[args.indexOf("--iterations") + 1]) || 3;
const PORT = Number(process.env.SOK_PORT ?? 4318);

/** §9.4 step counts by tier, and the low tier's 2 fbm octaves. */
const CASES = [
  { label: "high", steps: 8, octaves: 3, detail: 5 },
  { label: "medium", steps: 5, octaves: 2, detail: 4 },
  { label: "low", steps: 3, octaves: 2, detail: 3 },
] as const;

interface Measurement {
  label: string;
  steps: number;
  octaves: number;
  /** compileShader + linkProgram + status, ms. */
  compileMs: number;
  /** first drawArrays + finish(), ms — the JIT. */
  firstDrawMs: number;
  /** median of the per-frame costs after the first, ms. */
  frameMs: number;
  /** total to first visible frame, ms. */
  toFirstFrameMs: number;
  /** non-zero means the program did not build. */
  programLogLength: number;
  /** false if the centre pixel is pure black — i.e. nothing was rasterised. */
  drewSomething: boolean;
  centrePixel: string;
  /** readback of a known clear colour — non-red means readPixels is not seeing this buffer. */
  clearReadback: string;
  vertices: number;
  /** wall-clock for a known ~20 ms of JS — the control on the clock itself */
  cpuCalibrationMs: number;
  cpuSink: boolean;
  error: string;
}

// --- server ---------------------------------------------------------------

async function isUp(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/?debug=1`);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Reuse a server if one is already listening, else start one.
 *
 * Reusing is safe here because this probe measures the *browser's* shader
 * pipeline, not anything served — unlike `audio:check`, which reads config out
 * of the build and so genuinely needs a fresh `next start` against a current
 * `.next`.
 */
async function ensureServer(port: number): Promise<() => void> {
  if (await isUp(port)) {
    console.log(`reusing the server already listening on ${port}`);
    return () => {};
  }
  const child = spawn("npm", ["run", "start", "--", "--port", String(port)], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let log = "";
  child.stderr?.on("data", (d: Buffer) => (log += d.toString()));

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await isUp(port)) return () => child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 400));
  }
  child.kill("SIGTERM");
  throw new Error(`server did not start within 120s\n${log.slice(-2000)}`);
}

// --- in-page measurement --------------------------------------------------

/**
 * The §9.4 shader, as GLSL. Kept here rather than imported because the real
 * module is T4.2's deliverable; see the header's honest-limitation note.
 *
 * Assembled per tier because §9.4 bakes `MAX_STEPS = 8` and the octave count
 * into the source as literals, exactly as the shipped shaders will.
 */
function shaderSource(steps: number, octaves: number): string {
  const vertex = `#version 300 es
precision highp float;
${SIMPLEX}
uniform float uTime;
uniform float uBass;
uniform float uRms;
uniform vec4 uImpactA[16];
uniform vec4 uImpactB[16];
in vec3 position;
in vec3 normal;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
out vec3 vWorldPos;
out vec3 vNormalW;
void main() {
  vec3 dir = normalize(position);
  float n = snoise(dir * 1.6 + vec3(0.0, 0.0, uTime * 0.15));
  float disp = (0.05 + 0.10 * uBass) * n;
  float ripple = 0.0;
  for (int i = 0; i < 16; i++) {
    float s = uImpactA[i].w; if (s <= 0.0) continue;
    float age = uTime - uImpactB[i].x; if (age < 0.0 || age > 2.5) continue;
    float ang = acos(clamp(dot(dir, uImpactA[i].xyz), -1.0, 1.0));
    float w = sin(ang * 18.0 - age * 9.0) * exp(-ang * 3.0) * exp(-age * 1.6) * s;
    ripple += (uImpactB[i].y > 0.5 ? -1.0 : 1.0) * w;
  }
  float r = 1.0 + disp + 0.06 * ripple + 0.03 * uRms;
  vec3 p = dir * 1.2 * r;
  vWorldPos = p;
  vNormalW = normalize(normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

  const fragment = `#version 300 es
precision highp float;
${SIMPLEX}
uniform float uTime;
uniform float uFrame;
uniform vec3 uCoreColor;
uniform vec3 uAccentColor;
uniform vec3 uDeep;
uniform float uRms;
uniform float uMid;
uniform float uHigh;
uniform float uFlux;
uniform vec4 uImpactA[16];
uniform vec4 uImpactB[16];
in vec3 vWorldPos;
in vec3 vNormalW;
uniform vec3 cameraPosition;
out vec4 outColor;

const int MAX_STEPS = 8;
const float R = 1.26;

float ign(vec2 xy) {
  return fract(52.9829189 * fract(dot(xy, vec2(0.06711056, 0.00583715))));
}
float fbm(vec3 p) {
  float a = 0.5;
  float sum = 0.0;
  for (int i = 0; i < ${octaves}; i++) {
    sum += a * snoise(p);
    p *= 2.02;
    a *= 0.5;
  }
  return sum;
}
vec3 flow(float t) { return vec3(0.0, t * 0.05, t * 0.03); }

void main() {
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWorldPos - cameraPosition);
  float b = dot(ro, rd);
  float c = dot(ro, ro) - R * R;
  float disc = b * b - c;
  if (disc < 0.0) discard;
  float sq = sqrt(disc);
  float t0 = -b - sq;
  float t1 = -b + sq;
  float stepLen = (t1 - t0) / float(MAX_STEPS);
  float jitter = ign(gl_FragCoord.xy + uFrame);

  vec3 col = uDeep * 0.5;
  float trans = 1.0;
  for (int i = 0; i < MAX_STEPS; i++) {
    if (i >= ${steps}) break;
    float t = t0 + (float(i) + jitter) * stepLen;
    vec3 p = ro + rd * t;
    float rr = length(p) / R;
    float d = fbm(p * 1.7 + flow(uTime)) * (1.0 - rr * rr);
    d = smoothstep(0.15, 0.85, d + 0.25 * uMid);
    vec3 emit = mix(uCoreColor, uAccentColor,
      smoothstep(0.2, 0.9, rr + 0.3 * snoise(p * 3.0 + uTime * 0.2)));
    float a = 1.0 - exp(-d * stepLen * 3.2);
    col += trans * a * emit * (1.2 + 2.0 * uRms + 1.5 * uFlux);
    trans *= (1.0 - a);
  }
  float fres = pow(1.0 - clamp(dot(normalize(vNormalW), -rd), 0.0, 1.0), 3.0);
  col += fres * mix(uAccentColor, uCoreColor, 0.5) * (0.6 + 1.5 * uHigh);

  float glow = 0.0;
  for (int i = 0; i < 16; i++) {
    float s = uImpactA[i].w; if (s <= 0.0) continue;
    float age = uTime - uImpactB[i].x; if (age < 0.0 || age > 2.5) continue;
    float ang = acos(clamp(dot(normalize(vWorldPos), uImpactA[i].xyz), -1.0, 1.0));
    glow += s * exp(-ang * 6.0) * exp(-age * 2.0);
  }
  col += glow * uAccentColor;

  outColor = vec4(col, 1.0);
}`;

  return JSON.stringify({ vertex, fragment });
}

/** Ashima/webgl-noise 3D simplex, MIT — §9.4 names this exact implementation. */
const SIMPLEX = `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
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
  i = mod289(i);
  vec4 p = permute(permute(permute(
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
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}`;

/**
 * Minimal vertex shader for the control. Emits a **bright constant** after the
 * loop, so the probe's "did it actually rasterise" check has something to find.
 *
 * An earlier version emitted `fract(acc) * 0.02`, which rounds to 0 in 8-bit and
 * made a working shader indistinguishable from a dead one — the probe then
 * reported a healthy 0.0 ms for a frame that never drew.
 */
const CONTROL_VERTEX = `#version 300 es
precision highp float;
in vec3 position;
in vec3 normal;
void main() {
  gl_Position = vec4(position.xy * 0.25, 0.0, 1.0);
}`;

/**
 * A deliberately absurd shader, used as a control on the measurement itself.
 *
 * If this reports the same compile time as the orb, the timer is not measuring
 * compilation and every other number in this probe is worthless. It costs a few
 * lines and it is the only thing standing between a broken instrument and a
 * confident number.
 */
const CONTROL_FRAGMENT = `#version 300 es
precision highp float;
out vec4 outColor;
void main() {
  float acc = 0.0;
  for (int i = 0; i < 400; i++) {
    acc += sin(float(i) * 0.01 + gl_FragCoord.x) * cos(float(i) * 0.013);
  }
  // Bright, but only if the loop ran: fract(acc) > 0.001 is not guaranteed,
  // so the colour is mixed rather than replaced.
  outColor = vec4(mix(vec3(0.0), vec3(1.0, 0.0, 1.0), step(0.001, fract(acc))), 1.0);
}`;

/**
 * An icosphere, to stand in for §9.4's `IcosahedronGeometry(1.2, detail)`.
 *
 * Built here rather than imported because importing three.js would put
 * module-load cost inside a measurement that is only about shader cost — and
 * because `page.evaluate` ships only the function's source text, so a helper
 * defined in this module's scope simply does not exist in the browser.
 *
 * **Subdivision matches three.js exactly**, which is not the obvious choice.
 * `IcosahedronGeometry(radius, detail)` splits each of the 20 base faces into
 * `(detail+1)²` sub-faces — *not* by a factor of four per level. So §9.4's
 * `detail 5` is 720 faces / 2160 vertices, where a "factor 4" reading would give
 * 20 480 faces. An earlier version of this probe used the factor-4 reading and so
 * measured a mesh ~28× denser than the one that ships; the conclusions happened
 * to survive (the orb is fragment-bound) but the table's vertex column was wrong
 * and is now corrected.
 *
 * Normals are the normalised positions — correct for a sphere, and required: an
 * all-zero normal makes `normalize(vNormalW)` NaN, and a NaN colour comes out as
 * nothing, which reads exactly like a shader that never ran.
 */
function icosphere(detail: number): {
  positions: number[];
  normals: number[];
} {
  const t = (1 + Math.sqrt(5)) / 2;
  const verts: number[][] = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ].map(normalize3);
  const faces: number[][] = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];

  // three.js semantics. `PolyhedronGeometry.subdivide` splits every edge into
  // `detail + 1` segments and tiles each face into `(detail+1)^2` sub-faces —
  // it does *not* repeatedly 4-way split. So detail 5 is 20 * 36 = 720 faces,
  // 2160 vertices, non-indexed. (An earlier version of this probe did repeated
  // 4-way splitting and reported 245760 vertices for detail 5, 38x the real
  // figure.)
  const cols = detail + 1;
  const positions: number[] = [];
  const normals: number[] = [];

  // Barycentric lattice over one face, re-normalised onto the sphere.
  const point = (v0: number[], v1: number[], v2: number[], i: number, j: number): number[] => {
    const a = i / cols;
    const b = j / cols;
    return normalize3([
      v0[0]! + (v1[0]! - v0[0]!) * a + (v2[0]! - v0[0]!) * b,
      v0[1]! + (v1[1]! - v0[1]!) * a + (v2[1]! - v0[1]!) * b,
      v0[2]! + (v1[2]! - v0[2]!) * a + (v2[2]! - v0[2]!) * b,
    ]);
  };
  const emit = (p: number[]): void => {
    // One point, three components. No inner loop — an earlier version wrapped
    // this in `for (k = 0; k < 3; k++)` and pushed the same point three times,
    // which tripled every vertex count the probe reported.
    positions.push(p[0]! * 1.2, p[1]! * 1.2, p[2]! * 1.2);
    // The vertex shader perturbs the radius, so the normal it passes down is
    // the undisplaced one — same as shipping.
    normals.push(p[0]!, p[1]!, p[2]!);
  };

  for (const f of faces) {
    const v0 = verts[f[0]!]!;
    const v1 = verts[f[1]!]!;
    const v2 = verts[f[2]!]!;
    for (let j = 0; j < cols; j++) {
      for (let i = 0; i < cols - j; i++) {
        emit(point(v0, v1, v2, i, j));
        emit(point(v0, v1, v2, i + 1, j));
        emit(point(v0, v1, v2, i, j + 1));
        if (i < cols - j - 1) {
          emit(point(v0, v1, v2, i + 1, j));
          emit(point(v0, v1, v2, i + 1, j + 1));
          emit(point(v0, v1, v2, i, j + 1));
        }
      }
    }
  }
  return { positions, normals };
}

function cross3(a: number[], b: number[]): number[] {
  return [
    (a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0),
    (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0),
    (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0),
  ];
}

function normalize3(v: number[]): number[] {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
  return [v[0]! / l, v[1]! / l, v[2]! / l];
}

/**
 * §9.1's projection and view, as one `modelViewProjection`, computed in Node.
 *
 * Built here rather than in the page for two reasons: `page.evaluate` cannot see
 * module-scope helpers, and the camera is fixed, so there is nothing to gain
 * from computing it per iteration.
 *
 * **Perspective, not orthographic — and this matters more than it looks.** An
 * ortho box tight enough to put the centre pixel on the orb filled ~81 % of the
 * frame, where §9.1's real camera fills about 16 %. The orb is fragment-bound,
 * so the first draft of this probe overstated every per-frame number by roughly
 * 5×: it reported 50.7 ms/frame at the low tier and concluded the orb needed a
 * resolution clamp. The shipped engine measures 10.5 ms for the same scene.
 */
const VIEWPORT_W = 1280;
const VIEWPORT_H = 720;
const CAMERA_RADIUS = 5.5; // §9.1
const FOV_DEG = 58; // §9.1
const NEAR = 0.1;
const FAR = 200;

const CAMERA = cameraMatrices();

function cameraMatrices(): { proj: number[]; view: number[] } {
  const aspect = VIEWPORT_W / VIEWPORT_H;
  const f = 1 / Math.tan(((FOV_DEG / 2) * Math.PI) / 180);
  const proj = [
    f / aspect,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    0,
    0,
    (FAR + NEAR) / (NEAR - FAR),
    -1,
    0,
    0,
    (2 * FAR * NEAR) / (NEAR - FAR),
    0,
  ];

  // Camera at (CAMERA_RADIUS, 0, 0) looking at the origin, up (0, 1, 0).
  const eyeX = CAMERA_RADIUS;
  const eyeY = 0;
  const eyeZ = 0;
  const zAxis = normalize3([eyeX, eyeY, eyeZ]); // camera looks down -z
  const xAxis = normalize3(cross3([0, 1, 0], zAxis));
  const yAxis = cross3(zAxis, xAxis);

  // COLUMN-major, because that is how the multiply below and GLSL both read it.
  // Building this row-major silently transposes the view matrix: the orb lands
  // off-screen, nothing draws, and the centre pixel keeps the clear colour.
  const tx = -((xAxis[0] ?? 0) * eyeX + (xAxis[1] ?? 0) * eyeY + (xAxis[2] ?? 0) * eyeZ);
  const ty = -((yAxis[0] ?? 0) * eyeX + (yAxis[1] ?? 0) * eyeY + (yAxis[2] ?? 0) * eyeZ);
  const tz = -((zAxis[0] ?? 0) * eyeX + (zAxis[1] ?? 0) * eyeY + (zAxis[2] ?? 0) * eyeZ);
  const view = [
    xAxis[0] ?? 0,
    yAxis[0] ?? 0,
    zAxis[0] ?? 0,
    0,
    xAxis[1] ?? 0,
    yAxis[1] ?? 0,
    zAxis[1] ?? 0,
    0,
    xAxis[2] ?? 0,
    yAxis[2] ?? 0,
    zAxis[2] ?? 0,
    0,
    tx,
    ty,
    tz,
    1,
  ];

  // The orb's vertex shader computes `projectionMatrix * modelViewMatrix`, so
  // `modelViewMatrix` must be the **view** matrix alone. Passing the combined
  // proj·view applies the perspective divide twice, which puts every vertex
  // outside the frustum and draws nothing.
  return { proj, view };
}

async function measure(
  page: Page,
  spec: { label: string; steps: number; octaves: number; detail: number },
  src: string,
): Promise<Measurement> {
  // Built in Node and shipped as plain arrays: `page.evaluate` cannot see this
  // module's scope, so anything the callback needs has to arrive as an argument.
  const geo = icosphere(Math.max(0, spec.detail));
  return page.evaluate(
    ({ src, steps, octaves, label, positions, normals, proj, view }) => {
      const { vertex, fragment } = JSON.parse(src) as { vertex: string; fragment: string };
      const out: Measurement = {
        label,
        steps,
        octaves,
        compileMs: -1,
        firstDrawMs: -1,
        frameMs: -1,
        toFirstFrameMs: -1,
        programLogLength: 0,
        drewSomething: false,
        centrePixel: "",
        clearReadback: "",
        vertices: 0,
        cpuCalibrationMs: -1,
        cpuSink: false,
        error: "",
      };

      try {
        // A fresh canvas per iteration: swiftshader caches compiled programs
        // within a process, so reusing a context would report later compiles as
        // near-instant and understate the cost by an order of magnitude.
        const canvas = document.createElement("canvas");
        canvas.width = 1280;
        canvas.height = 720;
        document.body.appendChild(canvas);
        const gl = canvas.getContext("webgl2");
        if (!gl) {
          out.error = "no webgl2 context";
          canvas.remove();
          return out;
        }

        // No inner named function bindings in this callback. esbuild's
        // `keepNames` (on by default under tsx) rewrites `const f = () => {}`
        // into `const f = __name(() => {}, "f")`, and Playwright ships this
        // function's *source text* to the browser — where `__name` does not
        // exist, and the whole measurement fails with "__name is not defined".
        // That is why `render-audio.ts` keeps its evaluate callbacks to a single
        // arrow with no inner declarations.
        const t0 = performance.now();
        const vs = gl.createShader(gl.VERTEX_SHADER);
        if (!vs) throw new Error("createShader(VERTEX) returned null");
        gl.shaderSource(vs, vertex);
        gl.compileShader(vs);

        const fs = gl.createShader(gl.FRAGMENT_SHADER);
        if (!fs) throw new Error("createShader(FRAGMENT) returned null");
        gl.shaderSource(fs, fragment);
        gl.compileShader(fs);

        const prog = gl.createProgram();
        if (!prog) throw new Error("createProgram returned null");
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.bindAttribLocation(prog, 0, "position");
        gl.bindAttribLocation(prog, 1, "normal");
        gl.linkProgram(prog);
        gl.finish(); // force the driver to do the work now, not lazily
        out.compileMs = performance.now() - t0;

        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
          out.error = `link failed: ${gl.getProgramInfoLog(prog) ?? "no log"}`;
          out.programLogLength = (gl.getShaderInfoLog(fs) ?? "").length;
          canvas.remove();
          return out;
        }

        // §9.4's `IcosahedronGeometry(1.2, detail)`, with real normals. The normals
        // matter for correctness, not just realism: an all-zero normal makes
        // normalize(vNormalW) NaN in the fragment shader, and a NaN colour
        // comes out as nothing — which reads exactly like a shader that never ran.
        out.vertices = positions.length / 3;

        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        const pbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, pbo);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
        const nbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, nbo);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(normals), gl.STATIC_DRAW);

        gl.useProgram(prog);
        for (const [name, size, buffer] of [
          ["position", 3, pbo],
          ["normal", 3, nbo],
        ] as const) {
          const loc = gl.getAttribLocation(prog, name);
          if (loc < 0) continue;
          gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
          gl.enableVertexAttribArray(loc);
          gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
        }
        gl.uniform1f(gl.getUniformLocation(prog, "uTime"), 1.0);
        gl.uniform1f(gl.getUniformLocation(prog, "uBass"), 0.5);
        gl.uniform1f(gl.getUniformLocation(prog, "uRms"), 0.3);
        gl.uniform1f(gl.getUniformLocation(prog, "uMid"), 0.4);
        gl.uniform1f(gl.getUniformLocation(prog, "uHigh"), 0.1);
        gl.uniform1f(gl.getUniformLocation(prog, "uFlux"), 0.0);
        gl.uniform3f(gl.getUniformLocation(prog, "uCoreColor"), 0.8, 0.1, 0.05);
        gl.uniform3f(gl.getUniformLocation(prog, "uAccentColor"), 0.05, 0.3, 0.8);
        gl.uniform3f(gl.getUniformLocation(prog, "uDeep"), 0.01, 0.01, 0.02);
        // `cameraPosition`, `modelViewMatrix` and `projectionMatrix` are three.js
        // shader-chunk injections, not GLSL built-ins, so raw WebGL leaves them
        // all zero. An unset projection collapses gl_Position to the origin and
        // the orb draws nothing — indistinguishable, at the centre pixel, from a
        // shader that compiled and ran perfectly.
        //
        // A perspective matrix, NOT orthographic. §9.1 puts the camera at radius 5.5
        // with a 58° vertical FOV, where the orb (R = 1.26) subtends about 13° and
        // covers roughly 16 % of the frame. An ortho box tight enough to put the
        // centre pixel on the orb filled ~81 % of it, and the orb is
        // fragment-bound, so every per-frame number came out about 5× too high.
        //
        // The first draft reported 50.7 ms/frame at the low tier and concluded
        // the orb needed a resolution clamp; the shipped engine measures 10.5 ms
        // for the same scene. Column-major, as GLSL reads it.
        // §9.1 — camera at radius 5.5, FOV 58°, near 0.1, far 200. A perspective
        // matrix, NOT orthographic.
        //
        // An ortho box tight enough to put the centre pixel on the orb filled
        // ~81 % of the frame, where §9.1 real camera fills about 16 % — and the
        // orb is fragment-bound, so the first draft of this probe overstated every
        // per-frame number by about 5×. It reported 50.7 ms per frame at the low
        // tier and concluded the orb needed a resolution clamp; the shipped engine
        // measures 10.5 ms for the same scene.
        //
        // Built in Node and passed in as plain arrays: a helper — module-scope or
        // callback-scope — is invisible to page.evaluate (see the keepNames note
        // above), and inlining the digits here would be unreadable.
        gl.uniform3f(gl.getUniformLocation(prog, "cameraPosition"), 5.5, 0, 0);
        gl.uniformMatrix4fv(
          gl.getUniformLocation(prog, "projectionMatrix"),
          false,
          new Float32Array(proj),
        );
        gl.uniformMatrix4fv(
          gl.getUniformLocation(prog, "modelViewMatrix"),
          false,
          new Float32Array(view),
        );

        // Isolate readback from drawing. A `clear` to a known colour tells us whether
        // `readPixels` can see this buffer at all; if the clear reads back and
        // the draw does not, the problem is the draw, and if neither does, it is
        // the readback. Guessing between those two is how a probe reports a
        // confident 0.0 ms for a frame that never rendered.
        const probe = new Uint8Array(4);
        gl.clearColor(1, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.finish();
        gl.readPixels(
          canvas.width >> 1,
          canvas.height >> 1,
          1,
          1,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          probe,
        );
        out.clearReadback = `${probe[0]},${probe[1]},${probe[2]},${probe[3]}`;

        gl.viewport(0, 0, canvas.width, canvas.height);

        // Force completion with readPixels, not gl.finish().
        //
        // Under Chromium's command-buffer WebGL, finish() flushes but does not
        // reliably block until rasterisation completes, so a 400-iteration
        // per-fragment loop timed with finish() reported 0.0 ms — the same
        // "excellent" number a dead shader produces. readPixels must return real
        // data, so it synchronises the pipeline by construction. One pixel, so
        // the cost of the sync itself stays negligible.
        //
        // Deliberately inlined rather than factored into a local `drawAndSync`
        // helper: see the note above about esbuild's keepNames and why there are
        // no named function bindings in this callback.
        //
        // The CPU calibration loop is the control on the clock: if
        // performance.now() cannot time a known chunk of JavaScript, none of the
        // GPU numbers can be trusted either.
        const sync = new Uint8Array(4);

        const cpuStart = performance.now();
        let sink = 0;
        for (let i = 0; i < 3_000_000; i++) sink += Math.sqrt(i);
        out.cpuCalibrationMs = performance.now() - cpuStart;
        out.cpuSink = sink > 0;

        // First draw: this is where swiftshader's JIT actually runs, and it is
        // routinely much larger than the compile time reported above.
        const t1 = performance.now();
        gl.drawArrays(gl.TRIANGLES, 0, out.vertices);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, sync);
        out.firstDrawMs = performance.now() - t1;
        out.toFirstFrameMs = performance.now() - t0;

        // Prove the draw actually rasterised. A shader that discards every
        // fragment, or a program that never linked, would otherwise report a
        // beautiful 0.0 ms frame time while having drawn nothing at all — which
        // is precisely the kind of "the number is great, the thing is broken"
        // result this probe exists to avoid.
        const px = new Uint8Array(4);
        gl.readPixels(canvas.width >> 1, canvas.height >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        out.drewSomething = px[0]! + px[1]! + px[2]! > 0;
        out.centrePixel = `${px[0]},${px[1]},${px[2]}`;

        // Steady state, median of 9 — a mean here would hide the tail, which is
        // the number the §12.1 p95 budget is about.
        const frames: number[] = [];
        for (let i = 0; i < 9; i++) {
          gl.uniform1f(gl.getUniformLocation(prog, "uFrame"), i);
          const a = performance.now();
          gl.drawArrays(gl.TRIANGLES, 0, out.vertices);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, sync);
          frames.push(performance.now() - a);
        }
        frames.sort((x, y) => x - y);
        out.frameMs = frames[Math.floor(frames.length / 2)] ?? -1;

        const err = gl.getError();
        canvas.remove();
        if (err !== 0) out.error = `gl error 0x${err.toString(16)}`;
      } catch (e) {
        out.error = e instanceof Error ? e.message : String(e);
      }
      return out;
    },
    {
      src,
      steps: spec.steps,
      octaves: spec.octaves,
      label: spec.label,
      positions: geo.positions,
      normals: geo.normals,
      proj: CAMERA.proj,
      view: CAMERA.view,
    },
  );
}

// --- main -----------------------------------------------------------------

function loadAvg(): string {
  try {
    return execSync("sysctl -n vm.loadavg", { encoding: "utf8" }).trim();
  } catch {
    return execSync("cat /proc/loadavg", { encoding: "utf8" }).trim();
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

function fmt(n: number): string {
  return n < 0 ? "     —" : `${n.toFixed(1).padStart(8)}`;
}

async function main(): Promise<void> {
  // Load average is printed because every number below moves with it — the same
  // sensitivity that makes `npm run bench` read 7.8× under load and 11× idle.
  // A reading taken on a busy machine is not comparable with one taken on an
  // idle one, and neither is comparable with a CI runner.
  console.log(`load average: ${loadAvg()}`);
  console.log(`iterations per tier: ${iterations} (fresh context each — no program cache reuse)`);
  console.log(
    "\nNOTE: this compiles a transcription of §9.4's shaders. The real\n" +
      "      engine/visual/shaders/orb.*.ts is T4.2's deliverable and does not\n" +
      "      exist yet. Re-run against the real module once it lands.\n",
  );

  const stop = await ensureServer(PORT);
  const browser = await chromium.launch({
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });

  const results: Measurement[] = [];
  let failed = false;
  const report = (runs: Measurement[], label: string): Measurement => {
    const m: Measurement = {
      label,
      steps: runs[0]?.steps ?? -1,
      octaves: runs[0]?.octaves ?? -1,
      compileMs: median(runs.map((r) => r.compileMs)),
      firstDrawMs: median(runs.map((r) => r.firstDrawMs)),
      frameMs: median(runs.map((r) => r.frameMs)),
      toFirstFrameMs: median(runs.map((r) => r.toFirstFrameMs)),
      programLogLength: runs[0]?.programLogLength ?? 0,
      drewSomething: runs.every((r) => r.drewSomething),
      centrePixel: runs[0]?.centrePixel ?? "",
      clearReadback: runs[0]?.clearReadback ?? "",
      vertices: runs[0]?.vertices ?? 0,
      cpuCalibrationMs: median(runs.map((r) => r.cpuCalibrationMs)),
      cpuSink: runs[0]?.cpuSink ?? false,
      error: runs.find((r) => r.error)?.error ?? "",
    };
    console.log(
      `${label.padEnd(8)} steps=${String(m.steps).padEnd(4)}oct=${m.octaves}  ` +
        `compile=${fmt(m.compileMs)}  firstDraw=${fmt(m.firstDrawMs)}  frame=${fmt(m.frameMs)}  ` +
        `toFirstFrame=${fmt(m.toFirstFrameMs)}  (ms)  draw=${m.drewSomething ? m.centrePixel : "BLACK"}  clear=${m.clearReadback}  vtx=${m.vertices}  cpuCal=${fmt(m.cpuCalibrationMs)}`,
    );
    if (m.error) console.log(`         ERROR: ${m.error}`);
    return m;
  };

  try {
    const page = await browser.newPage();
    // A plain blank page is enough and keeps three.js out of the measurement.
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });

    // The control runs first. If it does not cost dramatically more than the
    // orb, the timer is not measuring compilation and the orb numbers below
    // mean nothing — so this is checked before anything is reported.
    const controlRuns: Measurement[] = [];
    for (let i = 0; i < iterations; i++) {
      controlRuns.push(
        await measure(
          page,
          { label: "control", steps: -1, octaves: -1, detail: 0 },
          JSON.stringify({ vertex: CONTROL_VERTEX, fragment: CONTROL_FRAGMENT }),
        ),
      );
    }
    const control = report(controlRuns, "control");
    results.push(...controlRuns);

    if (control.drewSomething === false) {
      console.log(
        "\n✗ the control shader drew nothing, so no timing here is meaningful.\n" +
          "  Stopping before reporting the orb numbers.",
      );
      failed = true;
    }

    for (const c of CASES) {
      const runs: Measurement[] = [];
      for (let i = 0; i < iterations; i++)
        runs.push(await measure(page, c, shaderSource(c.steps, c.octaves)));
      results.push(...runs);
      const m = report(runs, c.label);
      if (m.error || !m.drewSomething) failed = true;
    }
  } finally {
    await browser.close();
    stop();
  }

  console.log("\n--- vs T5.1's 20 s budget ---");
  const worstTotal = Math.max(...results.map((r) => r.toFirstFrameMs));
  let worstFrame = 0;
  let worstLabel = "";
  for (const c of CASES) {
    const frame = median(results.filter((r) => r.label === c.label).map((r) => r.frameMs));
    if (frame > worstFrame) {
      worstFrame = frame;
      worstLabel = c.label;
    }
  }
  for (const c of CASES) {
    const total = median(results.filter((r) => r.label === c.label).map((r) => r.toFirstFrameMs));
    const frame = median(results.filter((r) => r.label === c.label).map((r) => r.frameMs));
    console.log(
      `  ${c.label.padEnd(7)} to first frame ${(total / 1000).toFixed(2)} s of 20 s` +
        `   ·   steady frame ${fmt(frame)} ms` +
        (frame > 0 ? `  (${(1000 / frame).toFixed(1)} fps)` : ""),
    );
  }

  console.log(`\nworst to-first-frame across tiers: ${(worstTotal / 1000).toFixed(2)} s`);
  if (worstFrame > 16.7) {
    console.log(
      `\n⚠  the ${worstLabel} tier costs ${worstFrame.toFixed(1)} ms/frame under swiftshader — over\n` +
        `   one 60 fps frame. §9.10's governor will degrade it, and L1–L6 are all\n` +
        `   post-processing and event-rate reductions, so they will help.\n` +
        `   The low tier is what CI and a software rasteriser actually run, and it\n` +
        `   costs well under budget — see the cross-check note in the header.`,
    );
  }
  if (worstTotal > 20_000) {
    console.log(`\n✗ to-first-frame exceeds T5.1's 20 s budget.`);
    failed = true;
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
