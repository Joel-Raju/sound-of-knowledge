/**
 * What fraction of the spawn sphere is actually on screen, over time?
 *
 * The human: "I see the comet in the first 5 seconds and then no more." The engine is
 * not stopping — sparks spawn continuously. So the comets must be off-screen.
 *
 * §9.1 puts the camera at radius 5.5 and §7.9 puts the edit shell at 7-13, so the
 * camera is **inside** the shell, and most of the sphere is behind or beside it. This
 * computes what fraction of the 64 language homes is inside the frustum, over time,
 * with the rig's real pose (including the entrance ease and the auto-orbit).
 */
import * as THREE from "three";
import {
  CAMERA,
  composeYawPitch,
  pitchAt,
} from "../engine/visual/camera-rig";
import { distanceForEnergy } from "../engine/visual/camera-rig";
import { LANG_HOMES, SHELL_RADIUS_LO, SHELL_RADIUS_SPAN } from "../engine/config";
import { hashIndex } from "../engine/util/hash";

const ASPECT = 16 / 9;
const WIKIS = [
  "enwiki", "jawiki", "dewiki", "ruwiki", "frwiki", "eswiki", "itwiki", "ptwiki",
  "plwiki", "nlwiki", "svwiki", "arwiki", "zhwiki", "ukwiki", "hewiki", "fiwiki",
  "nowiki", "trwiki", "kowiki", "huwiki", "cswiki", "elwiki", "idwiki", "viwiki",
  "mswiki", "thwiki", "simplewiki", "commonswiki", "metawiki", "wikidatawiki",
  "cawiki", "srwiki", "hrwiki", "bgwiki", "ltwiki", "slwiki", "skwiki", "etwiki",
  "lvwiki", "azwiki", "euwiki", "glwiki", "fa wiki", "urwiki", "bnwiki", "tawiki",
  "mlwiki", "mrwiki", "newiki", "siwiki", "kmwiki", "mywiki", "jvwiki", "suwiki",
  "yo wiki", "igwiki", "ha wiki", "am wiki", "zu wiki", "xho wiki", "nso wiki",
];

const HOMES: Float64Array = (() => {
  const out = new Float64Array(LANG_HOMES * 3);
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < LANG_HOMES; i++) {
    const y = 1 - (i / (LANG_HOMES - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = ga * i;
    out[i * 3] = Math.cos(th) * r;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = Math.sin(th) * r;
  }
  return out;
})();

/** The visible fraction of the homes at a given rig pose. */
const visibleFraction = (
  pos: THREE.Vector3,
  _forward: THREE.Vector3,
  _radius: number,
): { frac: number; visible: number[] } => {
  const cam = new THREE.PerspectiveCamera(CAMERA.fov, ASPECT, CAMERA.near, CAMERA.far);
  cam.position.copy(pos);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();

  const v = new THREE.Vector3();
  const visible: number[] = [];
  const seen = new Set<number>();

  for (const wiki of WIKIS) {
    const home = hashIndex(wiki, LANG_HOMES);
    if (seen.has(home)) continue;
    seen.add(home);
    const dir = new THREE.Vector3(
      HOMES[home * 3]!,
      HOMES[home * 3 + 1]!,
      HOMES[home * 3 + 2]!,
    );
    // Two radii, because the shell spans 7-13.
    for (const r of [SHELL_RADIUS_LO, SHELL_RADIUS_LO + SHELL_RADIUS_SPAN]) {
      v.copy(dir).multiplyScalar(r).project(cam);
      if (v.z > -1 && v.z < 1 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1) {
        visible.push(home);
        break;
      }
    }
  }
  return { frac: visible.length / seen.size, visible };
};

const main = (): void => {
  const pos = new THREE.Vector3();
  const fwd = new THREE.Vector3();

  console.log("visible fraction of the language homes, over the first 30 s:\n");
  console.log("   t    radius   yaw(deg)  visible homes");
  for (let t = 0; t <= 30; t += 2) {
    const yaw = 0.03 * t;
    const pitch = pitchAt(t);
    // The entrance: radius eases from 9 to the energy-adjusted target over 2.5 s.
    const entranceT = Math.min(1, t / 2.5);
    const eased = entranceT * entranceT * (3 - 2 * entranceT);
    const target = distanceForEnergy(0.55);
    const radius = 9 + (target - 9) * eased;

    composeYawPitch(radius, yaw, pitch, pos);
    fwd.copy(pos).negate().normalize();
    const { frac, visible } = visibleFraction(pos, fwd, radius);
    console.log(
      `  ${String(t).padStart(3)}s   ${radius.toFixed(2).padStart(6)}   ` +
        `${((yaw * 180) / Math.PI).toFixed(1).padStart(6)}    ${visible.length}/${WIKIS.length} ` +
        `(${frac.toFixed(0)})`,
    );
  }

  console.log(
    "\n  => the visible cone sweeps with the camera, so the fraction should be roughly\n" +
      "     constant. If it is, then 'the comets stopped' cannot be a frustum effect.",
  );
};

main();
