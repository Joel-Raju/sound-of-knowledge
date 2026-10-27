/**
 * What would it take to make the comets visible?
 *
 * **The finding.** §9.1 puts the camera at radius 5.5, *inside* the 7-13 edit shell.
 * The homes are fixed in world space, one per wiki, and the camera's frustum only
 * contains a slice of them. Measured on the live stream: **8 %** of fired notes produce
 * an on-screen comet, and the seven busiest wikis — enwiki, dewiki, frwiki, zhwiki,
 * cewiki, nlwiki, eswiki — produce **zero**, while a low-traffic wiki like itwiki
 * produces 100 % of its notes visibly.
 *
 * So the piece is playing to a camera pointed at empty space, most of the time.
 *
 * This measures the candidate fixes, weighted by the *observed traffic mix*, so the
 * choice is made on numbers rather than on taste.
 */
import * as THREE from "three";
import { CAMERA, composeYawPitch, pitchAt, distanceForEnergy } from "../engine/visual/camera-rig";
import { LANG_HOMES, SHELL_RADIUS_LO, SHELL_RADIUS_SPAN } from "../engine/config";
import { hashIndex } from "../engine/util/hash";

const ASPECT = 16 / 9;

/** The observed traffic mix, from the live stream over 45 s. */
const TRAFFIC: Record<string, number> = {
  enwiki: 36, dewiki: 13, frwiki: 12, zhwiki: 9, cewiki: 7, nlwiki: 5, eswiki: 5,
  itwiki: 4, ruwiki: 4, plwiki: 4, svwiki: 4, arwiki: 4, viwiki: 4, zh_yuewiki: 3,
  bnwiki: 2, nlwiki2: 1, thwiki: 2, trwiki: 1, ptwiki: 1, kowiki: 1, azwiki: 1,
  simplewiki: 1, huwiki: 1, dawiki: 1, magwiki: 1, cebwiki: 1, glwiki: 1, slwiki: 1,
  elwiki: 1, aswiki: 1, nowiki: 1,
};

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

/** Traffic-weighted fraction of edits that land on screen, over a full orbit. */
const visibleFraction = (opts: {
  fov: number;
  radius: number;
  orbitRate: number;
  seconds: number;
}): number => {
  const cam = new THREE.PerspectiveCamera(opts.fov, ASPECT, CAMERA.near, CAMERA.far);
  const pos = new THREE.Vector3();
  const v = new THREE.Vector3();
  const R0 = SHELL_RADIUS_LO;
  const R1 = SHELL_RADIUS_LO + SHELL_RADIUS_SPAN;

  let visibleWeighted = 0;
  let totalWeighted = 0;
  const steps = 180;

  for (const [wiki, weight] of Object.entries(TRAFFIC)) {
    const home = hashIndex(wiki, LANG_HOMES);
    const dir = HOMES[home]!;
    let hits = 0;
    for (let s = 0; s < steps; s++) {
      const t = (s / steps) * opts.seconds;
      const yaw = opts.orbitRate * t;
      const pitch = pitchAt(t);
      composeYawPitch(opts.radius, yaw, pitch, pos);
      cam.position.copy(pos);
      cam.lookAt(0, 0, 0);
      cam.updateMatrixWorld(true);
      cam.updateProjectionMatrix();
      for (const r of [R0, R1]) {
        v.set(dir[0]! * r, dir[1]! * r, dir[2]! * r).project(cam);
        if (v.z > -1 && v.z < 1 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1) {
          hits++;
          break;
        }
      }
    }
    visibleWeighted += (hits / steps) * weight;
    totalWeighted += weight;
  }
  return visibleWeighted / totalWeighted;
};

const ORBIT_PERIOD = (rate: number): number => (2 * Math.PI) / rate;

const main = (): void => {
  const current = visibleFraction({
    fov: CAMERA.fov,
    radius: distanceForEnergy(0.55),
    orbitRate: 0.03,
    seconds: ORBIT_PERIOD(0.03),
  });
  console.log(
    `CURRENT (spec §9.1): FOV ${CAMERA.fov}°, radius ${distanceForEnergy(0.55).toFixed(1)}, ` +
      `orbit 0.03 rad/s (${(ORBIT_PERIOD(0.03) / 60).toFixed(1)} min/rev)\n` +
      `  traffic-weighted visible fraction: ${(current * 100).toFixed(1)}%\n`,
  );

  console.log("  candidate change                     visible    notes/min visible");
  const rows: Array<[string, number]> = [];
  const push = (label: string, o: Parameters<typeof visibleFraction>[0]): void => {
    const f = visibleFraction(o);
    rows.push([label, f]);
  };

  const base = { orbitRate: 0.03, seconds: ORBIT_PERIOD(0.03) };
  push("FOV 58 -> 75", { ...base, fov: 75, radius: distanceForEnergy(0.55) });
  push("FOV 58 -> 90", { ...base, fov: 90, radius: distanceForEnergy(0.55) });
  push("FOV 58 -> 110", { ...base, fov: 110, radius: distanceForEnergy(0.55) });
  push("orbit 0.03 -> 0.12 rad/s", {
    fov: CAMERA.fov,
    radius: distanceForEnergy(0.55),
    orbitRate: 0.12,
    seconds: ORBIT_PERIOD(0.12),
  });
  push("orbit 0.03 -> 0.25 rad/s", {
    fov: CAMERA.fov,
    radius: distanceForEnergy(0.55),
    orbitRate: 0.25,
    seconds: ORBIT_PERIOD(0.25),
  });
  push("radius 5.5 -> 20 (outside the shell)", {
    fov: CAMERA.fov,
    radius: 20,
    orbitRate: 0.03,
    seconds: ORBIT_PERIOD(0.03),
  });
  push("radius 5.5 -> 14", {
    fov: CAMERA.fov,
    radius: 14,
    orbitRate: 0.03,
    seconds: ORBIT_PERIOD(0.03),
  });

  for (const [label, f] of rows) {
    console.log(
      `  ${label.padEnd(38)} ${(f * 100).toFixed(1).padStart(6)}%    ${(4.8 * f).toFixed(2)}`,
    );
  }
  console.log(
    `\n  (notes/min visible assumes the measured live rate of ~4.8 notes/s, i.e. ~288/min)`,
  );
};

main();
