/**
 * Shockwave rings. Spec §9.6.
 *
 * Instanced billboards, capacity 24 — deliberately small, because a ring is a
 * punctuating event (spawned on a revert) rather than ambient motion. At 24 the
 * whole pool is 24 quads; there is no cost argument for more.
 *
 * Stateless like the sparks: a ring's radius is `easeOutCubic(u)` where
 * `u = (uTime − start) / duration`, so the CPU writes a start time once and never
 * touches it again.
 */
import * as THREE from "three";
import { RINGS_FRAG, RINGS_VERT, RING_DURATION } from "./shaders/rings.shader";

/** §9.6 — 24 rings is the specified capacity. */
export const RING_CAPACITY = 24;

export class Rings {
  readonly mesh: THREE.Mesh;
  readonly geometry: THREE.InstancedBufferGeometry;
  readonly material: THREE.ShaderMaterial;

  readonly aOrigin: THREE.InstancedBufferAttribute;
  readonly aTimes: THREE.InstancedBufferAttribute;
  readonly aColor: THREE.InstancedBufferAttribute;

  private head = 0;
  private totalSpawned = 0;

  constructor() {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3),
    );
    geo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);

    this.aOrigin = instanced(RING_CAPACITY, 3);
    this.aTimes = instanced(RING_CAPACITY, 2);
    this.aColor = instanced(RING_CAPACITY, 3);
    geo.setAttribute("aOrigin", this.aOrigin);
    geo.setAttribute("aTimes", this.aTimes);
    geo.setAttribute("aColor", this.aColor);

    geo.instanceCount = RING_CAPACITY;

    this.geometry = geo;
    this.material = new THREE.ShaderMaterial({
      vertexShader: RINGS_VERT,
      fragmentShader: RINGS_FRAG,
      uniforms: { uTime: { value: 0 } },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      glslVersion: THREE.GLSL3,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.name = "sok-rings";
  }

  /**
   * Spawn a ring at the edit's shell position (§9.6 — reverts only).
   *
   * Overwrites the oldest slot, as §9.4's impact buffer does. Returns the slot
   * used, so tests can follow the wrap.
   */
  spawn(origin: THREE.Vector3, color: THREE.Color, startTime: number): number {
    const i = this.head;
    const oA = this.aOrigin.array as Float32Array;
    const tA = this.aTimes.array as Float32Array;
    const cA = this.aColor.array as Float32Array;

    oA[i * 3] = origin.x;
    oA[i * 3 + 1] = origin.y;
    oA[i * 3 + 2] = origin.z;
    tA[i * 2] = startTime;
    tA[i * 2 + 1] = RING_DURATION;
    cA[i * 3] = color.r;
    cA[i * 3 + 1] = color.g;
    cA[i * 3 + 2] = color.b;

    this.aOrigin.addUpdateRange(i, 1);
    this.aTimes.addUpdateRange(i, 1);
    this.aColor.addUpdateRange(i, 1);
    this.aOrigin.needsUpdate = true;
    this.aTimes.needsUpdate = true;
    this.aColor.needsUpdate = true;

    this.head = (i + 1) % RING_CAPACITY;
    this.totalSpawned++;
    return i;
  }

  update(timeSec: number): void {
    this.material.uniforms.uTime!.value = timeSec;
  }

  /** Live rings, saturating at capacity. */
  get spawned(): number {
    return Math.min(RING_CAPACITY, this.totalSpawned);
  }

  /** The slot the next ring overwrites. */
  get cursor(): number {
    return this.head;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

function instanced(cap: number, size: number): THREE.InstancedBufferAttribute {
  return new THREE.InstancedBufferAttribute(new Float32Array(cap * size), size, true);
}