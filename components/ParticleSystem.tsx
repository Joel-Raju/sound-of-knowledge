"use client";

import { useRef, useMemo, useCallback, useEffect, useState, forwardRef, useImperativeHandle } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import type { WikiEditEvent } from "@/lib/types";
import { particleVertexShader, particleFragmentShader } from "@/lib/shaders";

export type ParticleSystemHandle = {
  spawn: (event: WikiEditEvent) => void;
};

export type ParticlePointerInfo = {
  event: WikiEditEvent;
  screenX: number;
  screenY: number;
  size: number;
};

type Particle = {
  active: boolean;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  acceleration: THREE.Vector3;
  life: number;
  maxLife: number;
  baseSize: number;
  size: number;
  color: THREE.Color;
  event: WikiEditEvent | null;
  seed: number;
  phase: number;
  bornAt: number;
};

function createInitialParticles(maxParticles: number): Particle[] {
  return Array.from({ length: maxParticles }, (_, i): Particle => {
    return {
      active: false,
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      acceleration: new THREE.Vector3(),
      life: 0,
      maxLife: 1,
      baseSize: 0,
      size: 0,
      color: new THREE.Color(),
      event: null,
      seed: i,
      phase: 0,
      bornAt: 0,
    };
  });
}

function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seedNorm(seed: number, salt: number): number {
  return ((seed ^ Math.imul(salt, 2654435761)) >>> 0) / 4294967295;
}

function sizeFromEdit(event: WikiEditEvent, seed: number): number {
  const absDelta = Math.abs(event.sizeDelta);
  const normalized = Math.min(1, Math.log10(absDelta + 1) / 4);
  // Visible glowing motes — middle ground between blobs and specks.
  const magnitudeBase =
    event.magnitude === "LARGE"
      ? 0.2
      : event.magnitude === "MEDIUM"
        ? 0.15
        : event.magnitude === "SMALL"
          ? 0.1
          : 0.07;
  const rangeFactor = 0.7 + seedNorm(seed, 7) * 1.1;
  return (magnitudeBase + normalized * 0.12) * rangeFactor;
}

// How many particles an edit spawns — large edits get a cluster of small motes
function countFromEdit(event: WikiEditEvent): number {
  switch (event.magnitude) {
    case "LARGE": return 5;
    case "MEDIUM": return 3;
    case "SMALL": return 1;
    case "TINY": return 1;
  }
}

function lifeFromMagnitude(magnitude: WikiEditEvent["magnitude"], seed: number): number {
  const variation = 0.65 + seedNorm(seed, 11) * 1.2;
  switch (magnitude) {
    case "TINY": return 3.0 * variation;
    case "SMALL": return 4.5 * variation;
    case "MEDIUM": return 6.5 * variation;
    case "LARGE": return 10.0 * variation;
  }
}

// ── Color: desaturated + lifted so particles glow under bloom ─────────────────
function editColor(event: WikiEditEvent, seed: number): THREE.Color {
  const color = new THREE.Color();
  if (event.isRevert) {
    color.setHSL(0.8 + seedNorm(seed, 1) * 0.1, 0.7, 0.65); // Magentas/Purples
  } else if (event.isBot) {
    color.setHSL(0.45 + seedNorm(seed, 2) * 0.15, 0.7, 0.65); // Cyans/Teals
  } else if (event.sizeDelta > 0) {
    // Warm adds: yellow/orange/pink
    color.setHSL(0.05 + seedNorm(seed, 3) * 0.15, 0.7, 0.65);
  } else {
    // Cool removes: blue/purple
    color.setHSL(0.55 + seedNorm(seed, 4) * 0.15, 0.7, 0.65);
  }
  return color;
}

// ── Smoothed value noise (3D) — the potential field for the curl ──────────────
// Hash-based value noise with smoothstep interpolation.
function hash3(x: number, y: number, z: number): number {
  let h = Math.imul((x | 0), 374761393) ^ Math.imul((y | 0), 668265263) ^ Math.imul((z | 0), 1442695040);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function valueNoise(p: THREE.Vector3): number {
  const ix = Math.floor(p.x);
  const iy = Math.floor(p.y);
  const iz = Math.floor(p.z);
  const fx = p.x - ix;
  const fy = p.y - iy;
  const fz = p.z - iz;
  // Smoothstep falloff for C1-ish continuity
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);

  const c000 = hash3(ix,     iy,     iz);
  const c100 = hash3(ix + 1, iy,     iz);
  const c010 = hash3(ix,     iy + 1, iz);
  const c110 = hash3(ix + 1, iy + 1, iz);
  const c001 = hash3(ix,     iy,     iz + 1);
  const c101 = hash3(ix + 1, iy,     iz + 1);
  const c011 = hash3(ix,     iy + 1, iz + 1);
  const c111 = hash3(ix + 1, iy + 1, iz + 1);

  const nx00 = c000 + (c100 - c000) * ux;
  const nx10 = c010 + (c110 - c010) * ux;
  const nx01 = c001 + (c101 - c001) * ux;
  const nx11 = c011 + (c111 - c011) * ux;
  const nxy0 = nx00 + (nx10 - nx00) * uy;
  const nxy1 = nx01 + (nx11 - nx01) * uy;
  return nxy0 + (nxy1 - nxy0) * uz;
}

// Analytic curl via finite differences of the scalar potential `valueNoise`.
// curl = ∇ × F where F is derived from the gradient; here we compute curl of
// a vector potential A=(n,n,n) sampled with offset arguments per axis so the
// result is divergence-free → particles swirl/eddy like smoke instead of
// collapsing or flying off randomly. This matches the visual_spec.md intent.
const _curlPos = new THREE.Vector3();
const _hA = new THREE.Vector3();
const _hB = new THREE.Vector3();
const EPS = 0.0001;
function curlNoise(p: THREE.Vector3, t: number, out: THREE.Vector3): THREE.Vector3 {
  // Offset the potential per-axis to break symmetry and add time evolution
  _curlPos.set(p.x + 0.13 * t, p.y + 0.17 * t, p.z + 0.11 * t);

  // Sample potential at offset points to approximate partial derivatives
  _hA.copy(_curlPos).addScalar(0); _hA.x += EPS;
  _hB.copy(_curlPos).addScalar(0); _hB.x -= EPS;
  const pxA = valueNoise(_hA);
  const pxB = valueNoise(_hB);
  _hA.copy(_curlPos).addScalar(0); _hA.y += EPS;
  _hB.copy(_curlPos).addScalar(0); _hB.y -= EPS;
  const pyA = valueNoise(_hA);
  const pyB = valueNoise(_hB);
  _hA.copy(_curlPos).addScalar(0); _hA.z += EPS;
  _hB.copy(_curlPos).addScalar(0); _hB.z -= EPS;
  const pzA = valueNoise(_hA);
  const pzB = valueNoise(_hB);

  const dndx = (pxA - pxB) / (2 * EPS);
  const dndy = (pyA - pyB) / (2 * EPS);
  const dndz = (pzA - pzB) / (2 * EPS);

  // curl of a vector potential whose components share this scalar field with
  // axis-dependent offsets → divergence-free swirling flow
  out.set(
    dndz * 0.5 - dndy * 0.3,
    dndx * 0.4 - dndz * 0.2,
    dndy * 0.6 - dndx * 0.5
  );
  return out;
}

// ── Props ─────────────────────────────────────────────────────────────────────
type Props = {
  highFreq: number;
  lowFreq: number;
  isLowTier: boolean;
  onHoverChange: (info: ParticlePointerInfo | null) => void;
  onParticleClick: (info: ParticlePointerInfo) => void;
};

const ParticleSystem = forwardRef<ParticleSystemHandle, Props>(
  function ParticleSystem({ highFreq, lowFreq, isLowTier, onHoverChange, onParticleClick }, ref) {
    const maxParticles = isLowTier ? 1500 : 3000;
    const [bufferVersion, setBufferVersion] = useState(0);

    const geoRef = useRef<THREE.BufferGeometry>(null);
    const positionsRef = useRef<Float32Array>(new Float32Array(0));
    const velocitiesRef = useRef<Float32Array>(new Float32Array(0));
    const aColorsRef = useRef<Float32Array>(new Float32Array(0));
    const aSizesRef = useRef<Float32Array>(new Float32Array(0));
    const particlesRef = useRef<Particle[]>([]);

    const [positionsAttr, setPositionsAttr] = useState<Float32Array>(new Float32Array(0));
    const [velocitiesAttr, setVelocitiesAttr] = useState<Float32Array>(new Float32Array(0));
    const [colorsAttr, setColorsAttr] = useState<Float32Array>(new Float32Array(0));
    const [sizesAttr, setSizesAttr] = useState<Float32Array>(new Float32Array(0));

    useEffect(() => {
      positionsRef.current = new Float32Array(maxParticles * 3);
      // Initialize all particles offscreen so dead ones don't raycast-hit at origin
      for (let i = 0; i < maxParticles; i++) {
        positionsRef.current[i * 3 + 2] = -10000;
      }
      velocitiesRef.current = new Float32Array(maxParticles * 3);
      aColorsRef.current = new Float32Array(maxParticles * 3);
      aSizesRef.current = new Float32Array(maxParticles);
      particlesRef.current = createInitialParticles(maxParticles);
      setPositionsAttr(positionsRef.current);
      setVelocitiesAttr(velocitiesRef.current);
      setColorsAttr(aColorsRef.current);
      setSizesAttr(aSizesRef.current);
      setBufferVersion((v) => v + 1);
    }, [maxParticles]);

    const spawnParticles = useCallback(
      (event: WikiEditEvent) => {
        const particles = particlesRef.current;
        if (particles.length === 0) return;

        const count = countFromEdit(event);
        const baseSeed = hashString(`${event.id}-${event.title}-${event.timestamp}`);

        for (let c = 0; c < count; c++) {
          const freeIndex = particles.findIndex((p) => !p.active);
          let targetIndex = freeIndex;

          if (targetIndex === -1) {
            let oldest = 0;
            for (let i = 1; i < particles.length; i++) {
              if (particles[i].bornAt < particles[oldest].bornAt) oldest = i;
            }
            targetIndex = oldest;
          }

          const p = particles[targetIndex];
          // Vary the seed per cluster mote so they don't overlap perfectly
          const seed = hashString(`${baseSeed}-${c}`);

          const theta = seedNorm(seed, 17) * Math.PI * 2;
          const phi = Math.acos(seedNorm(seed, 19) * 2 - 1);
          // Spawn at/around the orb surface (radius ~1.8) and outward,
          // so motes are always visible and pickable — never buried inside.
          const radius = 1.85 + seedNorm(seed, 23) * 1.4;
          const speed = 0.05 + seedNorm(seed, 31) * 0.8;
          const life = lifeFromMagnitude(event.magnitude, seed) * (0.7 + seedNorm(seed, 43) * 0.5);

          p.active = true;
          p.event = event;
          p.seed = seed;
          p.phase = seedNorm(seed, 41) * Math.PI * 2;
          p.baseSize = sizeFromEdit(event, seed);
          p.size = p.baseSize;
          p.life = life;
          p.maxLife = life;
          p.bornAt = performance.now();
          p.color.copy(editColor(event, seed));

          p.position.set(
            radius * Math.sin(phi) * Math.cos(theta),
            radius * Math.sin(phi) * Math.sin(theta),
            radius * Math.cos(phi)
          );

          const outward = p.position.clone().normalize();
          const up = Math.abs(outward.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
          const tangent = new THREE.Vector3().crossVectors(outward, up).normalize();

          p.velocity
            .copy(outward)
            .multiplyScalar(speed * (0.2 + seedNorm(seed, 47) * 0.5))
            .addScaledVector(tangent, speed * (0.3 + seedNorm(seed, 53) * 0.6));

          p.acceleration.set(
            (seedNorm(seed, 59) - 0.5) * 0.15,
            0.02 + seedNorm(seed, 61) * 0.1,
            (seedNorm(seed, 67) - 0.5) * 0.15
          );
        }
      },
      []
    );

    useImperativeHandle(ref, () => ({ spawn: spawnParticles }), [spawnParticles]);

    const getInfoFromIndex = useCallback(
      (index: number, nativeEvent: PointerEvent): ParticlePointerInfo | null => {
        const p = particlesRef.current[index];
        if (!p?.active || !p.event) return null;
        return {
          event: p.event,
          screenX: nativeEvent.clientX,
          screenY: nativeEvent.clientY,
          size: p.size,
        };
      },
      []
    );

    const handlePointerMove = useCallback(
      (evt: ThreeEvent<PointerEvent>) => {
        if (typeof evt.index !== "number") {
          onHoverChange(null);
          return;
        }
        const info = getInfoFromIndex(evt.index, evt.nativeEvent);
        onHoverChange(info);
      },
      [getInfoFromIndex, onHoverChange]
    );

    const handlePointerOut = useCallback(() => {
      onHoverChange(null);
    }, [onHoverChange]);

    const handleClick = useCallback(
      (evt: ThreeEvent<PointerEvent>) => {
        if (typeof evt.index !== "number") return;
        const info = getInfoFromIndex(evt.index, evt.nativeEvent);
        if (!info) return;
        onParticleClick(info);
      },
      [getInfoFromIndex, onParticleClick]
    );

    // Reusable scratch vectors to avoid per-particle allocations in the hot loop
    const scratchCurl = useMemo(() => new THREE.Vector3(), []);
    const scratchSwirl = useMemo(() => new THREE.Vector3(), []);

    useFrame((state, delta) => {
      const geo = geoRef.current;
      if (!geo) return;

      const particles = particlesRef.current;
      const positions = positionsRef.current;
      const velocities = velocitiesRef.current;
      const aColors = aColorsRef.current;
      const aSizes = aSizesRef.current;
      if (particles.length === 0) return;

      const t = state.clock.elapsedTime;
      const audioBoost = 1 + highFreq * 0.4 + lowFreq * 0.3;
      const curlTime = t * 0.2;
      // Curl strength now actually responds to low frequencies (feedback loop)
      const curlStrength = 0.5 + lowFreq * 1.8;
      let needsUpdate = false;

      for (let i = 0; i < maxParticles; i++) {
        const p = particles[i];
        const i3 = i * 3;

        if (!p.active) {
          // Park dead particles far offscreen so they don't raycast-intercept
          // clicks aimed at live ones (size 0 makes them invisible but the
          // raycaster ignores size and checks world position within threshold).
          positions[i3] = 0;
          positions[i3 + 1] = 0;
          positions[i3 + 2] = -10000;
          velocities[i3] = 0;
          velocities[i3 + 1] = 0;
          velocities[i3 + 2] = 0;
          aSizes[i] = 0;
          aColors[i3] = 0;
          aColors[i3 + 1] = 0;
          aColors[i3 + 2] = 0;
          continue;
        }

        p.life -= delta;
        if (p.life <= 0 || p.position.lengthSq() > 50 * 50) {
          p.active = false;
          p.event = null;
          positions[i3] = 0;
          positions[i3 + 1] = 0;
          positions[i3 + 2] = -10000;
          velocities[i3] = 0;
          velocities[i3 + 1] = 0;
          velocities[i3 + 2] = 0;
          aSizes[i] = 0;
          aColors[i3] = 0;
          aColors[i3 + 1] = 0;
          aColors[i3 + 2] = 0;
          continue;
        }

        // Divergence-free curl noise → swirling, eddying wisps (not random drift)
        curlNoise(p.position, curlTime + p.seed * 0.1, scratchCurl);
        p.velocity.addScaledVector(scratchCurl, delta * curlStrength);

        // Central swirl to keep particles orbiting rather than escaping
        scratchSwirl.set(-p.position.z, p.position.y * 0.1, p.position.x).normalize();
        const swirlStrength = 0.05 + seedNorm(p.seed, 71) * 0.1;

        p.velocity.addScaledVector(scratchSwirl, swirlStrength * delta * (1 + lowFreq * 0.8));
        p.velocity.addScaledVector(p.acceleration, delta);
        p.velocity.multiplyScalar(0.975 + seedNorm(p.seed, 79) * 0.015);
        p.position.addScaledVector(p.velocity, delta * audioBoost * 0.5);

        const lifeRatio = p.life / p.maxLife;
        const fadeCurve = Math.pow(Math.max(0, lifeRatio), 0.75) * Math.sin((1 - lifeRatio) * Math.PI);
        // Slow, gentle breathing — no high-frequency strobing (which blooms into flashes)
        const breathe = 0.9 + Math.sin(t * 0.6 + p.phase) * 0.1;

        p.size = p.baseSize * Math.max(0.2, fadeCurve) * breathe * (1 + highFreq * 0.4);
        needsUpdate = true;

        positions[i3] = p.position.x;
        positions[i3 + 1] = p.position.y;
        positions[i3 + 2] = p.position.z;
        velocities[i3] = p.velocity.x;
        velocities[i3 + 1] = p.velocity.y;
        velocities[i3 + 2] = p.velocity.z;
        aSizes[i] = p.size;

        // Steady color with only a slow audio-driven swell — no fast pulsing
        const colorSwell = 1.0 + lowFreq * 0.3;
        aColors[i3] = p.color.r * fadeCurve * colorSwell;
        aColors[i3 + 1] = p.color.g * fadeCurve * colorSwell;
        aColors[i3 + 2] = p.color.b * fadeCurve * colorSwell;
      }

      if (needsUpdate) {
        geo.attributes.position.needsUpdate = true;
        (geo.attributes as Record<string, THREE.BufferAttribute>).aColor.needsUpdate = true;
        (geo.attributes as Record<string, THREE.BufferAttribute>).aSize.needsUpdate = true;
        (geo.attributes as Record<string, THREE.BufferAttribute>).aVelocity.needsUpdate = true;
      }
    });

    const uniforms = useMemo(() => ({ uTime: { value: 0 } }), []);

    return (
      <points
        onPointerMove={handlePointerMove}
        onPointerOut={handlePointerOut}
        onClick={handleClick}
      >
        <bufferGeometry ref={geoRef}>
          <bufferAttribute attach="attributes-position" args={[positionsAttr, 3]} key={`pos-${bufferVersion}`} />
          <bufferAttribute attach="attributes-aVelocity" args={[velocitiesAttr, 3]} key={`vel-${bufferVersion}`} />
          <bufferAttribute attach="attributes-aColor" args={[colorsAttr, 3]} key={`color-${bufferVersion}`} />
          <bufferAttribute attach="attributes-aSize" args={[sizesAttr, 1]} key={`size-${bufferVersion}`} />
        </bufferGeometry>
        <shaderMaterial
          vertexShader={particleVertexShader}
          fragmentShader={particleFragmentShader}
          uniforms={uniforms}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
    );
  }
);

export default ParticleSystem;
