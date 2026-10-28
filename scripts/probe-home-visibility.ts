/**
 * Is a wiki's home direction EVER on screen, as the camera orbits?
 *
 * The homes are fixed in world space (one of 64 Fibonacci-sphere points, chosen by
 * hashing the wiki). The camera orbits inside them at radius 5.5 with a 58° vertical FOV
 * and ~89° horizontal.
 *
 * So a home that is never within the frustum means **every edit from that wiki produces
 * an invisible comet** — the note plays, the orb is struck, and nothing is seen.
 *
 * This sweeps a full orbit for each wiki and reports the best alignment it ever gets.
 */
import * as THREE from "three";
import { CAMERA, composeYawPitch, pitchAt, distanceForEnergy } from "../engine/visual/camera-rig";
import { LANG_HOMES, SHELL_RADIUS_LO, SHELL_RADIUS_SPAN } from "../engine/config";
import { hashIndex } from "../engine/util/hash";

const ASPECT = 16 / 9;

const HOMES: number[][] = (() => {
  const out: number[][] = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < LANG_HOMES; i++) {
    const y = 1 - (i / (LANG_HOMES - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = ga * i;
    out.push([Math.cos(th) * r, y, Math.sin(th) * r]);
  }
  return out;
})();

const WIKIS = [
  "enwiki", "jawiki", "dewiki", "ruwiki", "frwiki", "eswiki", "itwiki", "ptwiki",
  "plwiki", "nlwiki", "svwiki", "arwiki", "zhwiki", "ukwiki", "hewiki", "fiwiki",
  "nowiki", "trwiki", "kowiki", "huwiki", "cswiki", "elwiki", "idwiki", "viwiki",
  "mswiki", "thwiki", "simplewiki", "commonswiki", "metawiki", "wikidatawiki",
];

const main = (): void => {
  const pos = new THREE.Vector3();
  const cam = new THREE.PerspectiveCamera(CAMERA.fov, ASPECT, CAMERA.near, CAMERA.far);
  const v = new THREE.Vector3();
  const radius = distanceForEnergy(0.55);
  const R0 = SHELL_RADIUS_LO;
  const R1 = SHELL_RADIUS_LO + SHELL_RADIUS_SPAN;

  console.log(
    `camera orbits at radius ${radius.toFixed(2)}, FOV ${CAMERA.fov}° vertical ` +
      `(~${((2 * Math.atan(Math.tan((CAMERA.fov * Math.PI) / 360) * ASPECT) * 180) / Math.PI).toFixed(0)}° horizontal)\n`,
  );
  console.log("  wiki           home   best on-screen fraction over a full orbit");
  console.log("  ----------------------------------------------------------------");

  const results: Array<{ wiki: string; frac: number }> = [];

  for (const wiki of WIKIS) {
    const home = hashIndex(wiki, LANG_HOMES);
    const dir = HOMES[home]!;
    let hits = 0;
    let samples = 0;

    for (let step = 0; step < 360; step += 2) {
      const yaw = (step * Math.PI) / 180;
      const pitch = pitchAt((step * Math.PI) / 180 / 0.03);
      composeYawPitch(radius, yaw, pitch, pos);
      cam.position.copy(pos);
      cam.lookAt(0, 0, 0);
      cam.updateMatrixWorld(true);
      cam.updateProjectionMatrix();

      let on = false;
      for (const r of [R0, R1]) {
        v.set(dir[0]! * r, dir[1]! * r, dir[2]! * r).project(cam);
        if (v.z > -1 && v.z < 1 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1) {
          on = true;
          break;
        }
      }
      samples++;
      if (on) hits++;
    }
    const frac = hits / samples;
    results.push({ wiki, frac });
    console.log(
      `  ${wiki.padEnd(14)} ${String(home).padStart(4)}   ${(frac * 100).toFixed(0).padStart(3)}% of the orbit`,
    );
  }

  const never = results.filter((r) => r.frac === 0);
  const rare = results.filter((r) => r.frac > 0 && r.frac < 0.2);
  console.log(`\n  never visible at all: ${never.length} of ${results.length}`);
  for (const r of never) console.log(`    ${r.wiki}`);
  console.log(`  visible only rarely (<20% of the orbit): ${rare.length}`);
  for (const r of rare) console.log(`    ${r.wiki}  ${(r.frac * 100).toFixed(0)}%`);
};

main();
