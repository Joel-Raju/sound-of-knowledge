/**
 * Probe: what actually controls where a note comes from, and is it reproducible?
 *
 * T6.6, written because A4 ("each sound comes from the direction its comet came from")
 * is the one human-check item with a mechanical substrate and no human-check method.
 * The human reported "I see random comets" — which turns out to be correct, for two
 * separable reasons this probe separates.
 *
 * Run: `npx tsx scripts/probe-a4-direction.ts`
 */
import { SpatialMapper } from "../engine/music/spatial-mapper";
import type { Vec3 } from "../engine/types";
import { CAMERA_YAW_RATE, SHELL_RADIUS_LO, SHELL_RADIUS_HI, CAMERA_RADIUS } from "../engine/config";

const mapper = new SpatialMapper();
const a: Vec3 = { x: 0, y: 0, z: 0 };
const b: Vec3 = { x: 0, y: 0, z: 0 };

const dir = (v: Vec3) => {
  const m = Math.hypot(v.x, v.y, v.z) || 1;
  return [v.x / m, v.y / m, v.z / m].map((n) => n.toFixed(4)).join(" ");
};

console.log("=== 1. Is direction deterministic for the same edit? ===");
for (let i = 0; i < 3; i++) {
  mapper.placeEdit("enwiki", "Alpha Page", 4242, a);
  console.log(`  run ${i + 1}: ${dir(a)}  radius ${mapper.radiusOf("Alpha Page", 4242).toFixed(2)}`);
}
mapper.placeEdit("enwiki", "Alpha Page", 4242, a);
mapper.placeEdit("enwiki", "Alpha Page", 4242, b);
const selfDelta = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
console.log(`  -> identical across runs: ${selfDelta === 0 ? "YES, bit-for-bit" : `NO (delta ${selfDelta})`}`);

console.log("\n=== 2. Does the wiki move it? (home is per-wiki) ===");
const wikis = ["enwiki", "jawiki", "dewiki", "ruwiki", "frwiki", "eswiki"];
const seen = new Set<string>();
for (const w of wikis) {
  mapper.placeEdit(w, "Alpha Page", 4242, a);
  const d = dir(a);
  seen.add(d);
  console.log(`  ${w.padEnd(8)} -> ${d}`);
}
console.log(`  -> ${seen.size} distinct directions across ${wikis.length} wikis`);

console.log("\n=== 3. Does the title move it? (jitter is hashed from title:id) ===");
for (const t of ["Alpha Page", "Beta Page", "Gamma Page", "Delta Page"]) {
  mapper.placeEdit("enwiki", t, 4242, a);
  console.log(`  ${t.padEnd(12)} -> ${dir(a)}`);
}

console.log("\n=== 4. Why screen-left/right is not a stable anchor ===");
console.log(
  `  camera auto-orbit  CAMERA_YAW_RATE = ${CAMERA_YAW_RATE} rad/s ` +
    `= ${((CAMERA_YAW_RATE * 180) / Math.PI).toFixed(2)} deg/s ` +
    `= ${((CAMERA_YAW_RATE * 180 * 60) / Math.PI).toFixed(0)} deg/min`,
);
console.log(
  `  the camera orbits at radius ${CAMERA_RADIUS}, INSIDE the [${SHELL_RADIUS_LO}, ` +
    `${SHELL_RADIUS_HI}] spawn shell, so every direction is ahead of it and rotating.`,
);
console.log(
  `  => over a 3 s comet flight the frame turns ` +
    `${((CAMERA_YAW_RATE * 3 * 180) / Math.PI).toFixed(1)} deg. Correlating "which side` +
    ` was that on screen" with a sound is not a question the screen can answer.`,
);
