/**
 * What tier does a Mac get?
 *
 * `detectTier` reads the GPU renderer string. The regexes are:
 *   SOFTWARE_GPU  = /swiftshader|llvmpipe|software/
 *   INTEGRATED_GPU = /intel|uhd|iris/
 *
 * A Mac reports "Apple M1", "Apple M2 Pro", "ANGLE (Apple, Apple M2, ...)" — none of
 * which match either regex, and a desktop is not coarse-pointer, so the tier falls
 * through to "high". That is the desired answer.
 *
 * But an **Intel Mac** with integrated graphics reports "Intel Iris Plus Graphics" or
 * "ANGLE (Intel, Intel(R) Iris(TM) Plus Graphics ...)" — which matches INTEGRATED_GPU
 * and gives "medium". Also correct: medium still gets HRTF.
 *
 * This runs the real `detectTier` over the strings real browsers actually report, so
 * the answer is not a guess about the regexes.
 */
import { detectTier, type TierEnv } from "../engine/visual/tier";

const CASES: Array<[string, TierEnv]> = [
  ["Apple M1 (Safari)", { gpuRenderer: "Apple M1", width: 1512, height: 982, cores: 8, deviceMemory: 8 }],
  [
    "Apple M2 Pro (Chrome, ANGLE)",
    {
      gpuRenderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)",
      width: 1728,
      height: 1117,
      cores: 10,
      deviceMemory: 8,
    },
  ],
  [
    "Intel Iris Plus (Chrome, ANGLE)",
    {
      gpuRenderer:
        "ANGLE (Intel, Intel(R) Iris(TM) Plus Graphics 655, OpenGL 4.1)",
      width: 1470,
      height: 956,
      cores: 8,
      deviceMemory: 8,
    },
  ],
  [
    "Intel UHD Graphics 630 (Chrome)",
    {
      gpuRenderer: "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      width: 1920,
      height: 1080,
      cores: 8,
      deviceMemory: 8,
    },
  ],
  ["SwiftShader (headless CI)", { gpuRenderer: "Google SwiftShader", width: 1280, height: 720, cores: 4, deviceMemory: 4 }],
  ["llvmpipe (Linux, no GPU)", { gpuRenderer: "llvmpipe (LLVM 15.0, 256 bits)", width: 1920, height: 1080, cores: 8, deviceMemory: 8 }],
  ["iPhone (coarse pointer)", { gpuRenderer: "Apple A15", width: 390, height: 844, coarsePointer: true, cores: 6, deviceMemory: 6 }],
];

const PANNING: Record<string, string> = {
  high: "HRTF",
  medium: "HRTF",
  low: "equalpower",
};

console.log("GPU string                                    -> tier     panning model\n");
for (const [_name, env] of CASES) {
  const t = detectTier(env);
  const gpu = (env.gpuRenderer ?? "").slice(0, 44);
  console.log(`${gpu.padEnd(46)} -> ${t.padEnd(8)} ${PANNING[t]}`);
}
