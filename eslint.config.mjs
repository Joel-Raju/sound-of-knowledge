import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Spec §1.2 — hot paths (render loop, scheduler tick, ingest worker,
 * AudioWorklet `process()`) must not allocate per frame/sample.
 *
 * Rule 1.1.11 + §12.4.2: hot-path files opt in by carrying a
 * `// @hot-file` header comment, which enables the banned-syntax list below.
 * The intent is to make an allocation obvious at review time rather than to
 * pretend a linter can prove absence of allocation.
 */
const HOT_PATH_FILES = [
  "engine/ingest/ingest.worker.ts",
  "engine/audio/voice-pool.worklet.ts",
  "engine/audio/dsp/**/*.ts",
  "engine/audio/allocator.ts",
  "engine/music/scheduler.ts",
  "engine/visual/renderer.ts",
  "engine/visual/sparks.ts",
  "engine/visual/rings.ts",
  "engine/visual/dust.ts",
  "engine/visual/orb.ts",
  "engine/visual/camera-rig.ts",
  "engine/visual/governor.ts",
  "engine/visual/visual-queue.ts",
  "engine/visual/labels.ts",
  "engine/util/random.ts",
  "engine/util/ring-buffer.ts",
];

const bannedCall = (method) => ({
  selector: `CallExpression > MemberExpression.callee[property.name='${method}']`,
  message: `\`${method}()\` allocates an array; hot paths must use explicit indexed loops (§1.2).`,
});

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "dist/**",
    "public/engine/**",
    "artifacts/**",
    "coverage/**",
    "test-results/**",
    "playwright-report/**",
    "next-env.d.ts",
  ]),

  // ---- Spec §1.1.11: no `any` -------------------------------------------
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": ["warn", { allow: ["error", "warn"] }],
      // A leading underscore marks a deliberately-unused parameter or binding.
      // Needed because several DSP `next(t, dt)` overrides stopped using `t`
      // once exponential decay became incremental, but must keep the signature.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },

  // ---- Spec §1.2 / §12.4.2: hot-path allocation guard ---------------------
  //
  // These files opt in by being listed in HOT_PATH_FILES above. The enforced
  // rules are the ones spec §12.4.2 names explicitly: array methods that
  // allocate, spread-in-call-arguments, and `new Array(...)`.
  //
  // Object/array *literals* are deliberately NOT banned file-wide: message
  // types, config tables and shader-uniform sets need them, and a blanket ban
  // would make the files unwritable without catching anything real. Per §12.4.2
  // the remaining risk is handled by tagging hot functions with `// @hot` and
  // reviewing them manually (done at T6.3).
  {
    files: HOT_PATH_FILES,
    rules: {
      "no-restricted-syntax": [
        "error",
        { message: "Hot path (§1.2): array methods allocate.", ...bannedCall("map") },
        { message: "Hot path (§1.2): array methods allocate.", ...bannedCall("filter") },
        { message: "Hot path (§1.2): array methods allocate.", ...bannedCall("forEach") },
        { message: "Hot path (§1.2): array methods allocate.", ...bannedCall("reduce") },
        { message: "Hot path (§1.2): slice allocates.", ...bannedCall("slice") },
        { message: "Hot path (§1.2): concat allocates.", ...bannedCall("concat") },
        {
          message: "Hot path (§1.2): spread in a call argument allocates.",
          selector: "CallExpression > SpreadElement",
        },
        {
          message: "Hot path (§1.2): `new Array(n)` allocates per call.",
          selector: "NewExpression[callee.name='Array']",
        },
      ],
    },
  },

  // ---- Spec §1.1.11 / §4: scripts and config are not product hot paths ----
  {
    files: ["scripts/**", "*.config.ts", "*.config.mjs", "tests/**"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
]);

export default eslintConfig;
