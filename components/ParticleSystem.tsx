"use client";

import { useRef, useMemo, useCallback, useEffect, useState, forwardRef, useImperativeHandle } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import type { WikiEditEvent } from "@/lib/types";

export type ParticleSystemHandle = {
  spawn: (event: WikiEditEvent) => void;
};

export type ParticlePointerInfo = {
  event: WikiEditEvent;
  screenX: number;
  screenY: number;
  size: number;
};

const ORI_COLORS = {
  revert: new THREE.Color(0.9, 0.1, 1.0),
  bot: new THREE.Color(0.2, 0.9, 0.8),
  add: new THREE.Color(0.6, 0.95, 1.0),
  remove: new THREE.Color(0.1, 0.5, 1.0),
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
      color: ORI_COLORS.add.clone(),
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
  const magnitudeBase =
    event.magnitude === "LARGE"
      ? 0.36
      : event.magnitude === "MEDIUM"
        ? 0.25
        : event.magnitude === "SMALL"
          ? 0.16
          : 0.09;
  const rangeFactor = 0.8 + seedNorm(seed, 7) * 2.2;
  return (magnitudeBase + normalized * 0.5) * rangeFactor;
}

function lifeFromMagnitude(magnitude: WikiEditEvent["magnitude"], seed: number): number {
  const variation = 0.65 + seedNorm(seed, 11) * 0.9;
  switch (magnitude) {
    case "TINY":
      return 2.2 * variation;
    case "SMALL":
      return 3.6 * variation;
    case "MEDIUM":
      return 5.4 * variation;
    case "LARGE":
      return 8.2 * variation;
  }
}

function editColor(event: WikiEditEvent): THREE.Color {
  if (event.isRevert) return ORI_COLORS.revert;
  if (event.isBot) return ORI_COLORS.bot;
  if (event.sizeDelta > 0) return ORI_COLORS.add;
  return ORI_COLORS.remove;
}

// ── Particle shader (custom glowing sprite) ───────────────────────────────────
const PARTICLE_VERT = /* glsl */`
  attribute float aSize;
  attribute vec3  aColor;
  varying   vec3  vColor;
  varying   float vAlpha;
  uniform   float uTime;

  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // Size attenuation with guard rails to avoid huge/invalid point sizes
    // when particles are too close to (or behind) the camera.
    float z = max(0.1, -mv.z);
    gl_PointSize = clamp(aSize * (520.0 / z), 0.0, 196.0);
    gl_Position  = projectionMatrix * mv;
    vAlpha = 1.0;
  }
`;

const PARTICLE_FRAG = /* glsl */`
  varying vec3  vColor;
  varying float vAlpha;

  void main() {
    // Soft radial glow — bright core, wide halo
    vec2  uv   = gl_PointCoord * 2.0 - 1.0;
    float dist = length(uv);
    if (dist > 1.0) discard;

    // Two-layer glow: tight bright core + wide soft halo
    float core = exp(-dist * dist * 6.0);
    float halo = exp(-dist * dist * 1.5) * 0.4;
    float alpha = (core + halo) * vAlpha;

    gl_FragColor = vec4(vColor * (1.0 + core * 1.5), alpha);
  }
`;

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
    const maxParticles = isLowTier ? 1200 : 4800;
    const [bufferVersion, setBufferVersion] = useState(0);

    const geoRef = useRef<THREE.BufferGeometry>(null);
    const positionsRef = useRef<Float32Array>(new Float32Array(0));
    const aColorsRef = useRef<Float32Array>(new Float32Array(0));
    const aSizesRef = useRef<Float32Array>(new Float32Array(0));
    const particlesRef = useRef<Particle[]>([]);
    const [positionsAttr, setPositionsAttr] = useState<Float32Array>(new Float32Array(0));
    const [colorsAttr, setColorsAttr] = useState<Float32Array>(new Float32Array(0));
    const [sizesAttr, setSizesAttr] = useState<Float32Array>(new Float32Array(0));

    useEffect(() => {
      positionsRef.current = new Float32Array(maxParticles * 3);
      aColorsRef.current = new Float32Array(maxParticles * 3);
      aSizesRef.current = new Float32Array(maxParticles);
      particlesRef.current = createInitialParticles(maxParticles);
      setPositionsAttr(positionsRef.current);
      setColorsAttr(aColorsRef.current);
      setSizesAttr(aSizesRef.current);
      setBufferVersion((v) => v + 1);
    }, [maxParticles]);

    const spawnParticles = useCallback(
      (event: WikiEditEvent) => {
        const particles = particlesRef.current;
        if (particles.length === 0) return;

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
        const seed = hashString(`${event.id}-${event.title}-${event.timestamp}`);

        const theta = seedNorm(seed, 17) * Math.PI * 2;
        const phi = Math.acos(seedNorm(seed, 19) * 2 - 1);
        const radius = 1.75 + seedNorm(seed, 23) * 0.45;
        const speed = 0.1 + seedNorm(seed, 31) * 0.55;
        const life = lifeFromMagnitude(event.magnitude, seed);

        p.active = true;
        p.event = event;
        p.seed = seed;
        p.phase = seedNorm(seed, 41) * Math.PI * 2;
        p.baseSize = sizeFromEdit(event, seed);
        p.size = p.baseSize;
        p.life = life;
        p.maxLife = life;
        p.bornAt = performance.now();
        p.color.copy(editColor(event));

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
          .multiplyScalar(speed * (0.35 + seedNorm(seed, 47) * 0.8))
          .addScaledVector(tangent, speed * (0.12 + seedNorm(seed, 53) * 0.5));

        p.acceleration.set(
          (seedNorm(seed, 59) - 0.5) * 0.1,
          0.03 + seedNorm(seed, 61) * 0.14,
          (seedNorm(seed, 67) - 0.5) * 0.1
        );
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

    useFrame((state, delta) => {
      const geo = geoRef.current;
      if (!geo) return;

      const particles = particlesRef.current;
      const positions = positionsRef.current;
      const aColors = aColorsRef.current;
      const aSizes = aSizesRef.current;
      if (particles.length === 0) return;

      const t = state.clock.elapsedTime;
      const audioBoost = 1 + highFreq * 0.25 + lowFreq * 0.2;

      for (let i = 0; i < maxParticles; i++) {
        const p = particles[i];
        const i3 = i * 3;

        if (!p.active) {
          positions[i3] = 0;
          positions[i3 + 1] = 0;
          positions[i3 + 2] = 0;
          aSizes[i] = 0;
          aColors[i3] = 0;
          aColors[i3 + 1] = 0;
          aColors[i3 + 2] = 0;
          continue;
        }

        p.life -= delta;
        if (p.life <= 0 || p.position.lengthSq() > 44 * 44) {
          p.active = false;
          p.event = null;
          positions[i3] = 0;
          positions[i3 + 1] = 0;
          positions[i3 + 2] = 0;
          aSizes[i] = 0;
          aColors[i3] = 0;
          aColors[i3 + 1] = 0;
          aColors[i3 + 2] = 0;
          continue;
        }

        const swirl = new THREE.Vector3(-p.position.z, 0, p.position.x).normalize();
        const swirlStrength = 0.02 + seedNorm(p.seed, 71) * 0.08;

        p.velocity.addScaledVector(swirl, swirlStrength * delta * (1 + lowFreq * 0.6));
        p.velocity.addScaledVector(p.acceleration, delta);
        p.velocity.multiplyScalar(0.984 + seedNorm(p.seed, 79) * 0.008);
        p.position.addScaledVector(p.velocity, delta * audioBoost * 0.38);

        const lifeRatio = p.life / p.maxLife;
        const fadeCurve = Math.pow(Math.max(0, lifeRatio), 0.75) * Math.sin((1 - lifeRatio) * Math.PI);
        const flicker = 0.75 + Math.sin(t * (1.1 + seedNorm(p.seed, 83) * 2.1) + p.phase) * 0.45;

        p.size = p.baseSize * Math.max(0.3, fadeCurve) * flicker * (1 + highFreq * 0.45);

        positions[i3] = p.position.x;
        positions[i3 + 1] = p.position.y;
        positions[i3 + 2] = p.position.z;
        aSizes[i] = p.size;
        aColors[i3] = p.color.r * flicker;
        aColors[i3 + 1] = p.color.g * flicker;
        aColors[i3 + 2] = p.color.b * flicker;
      }

      geo.attributes.position.needsUpdate = true;
      (geo.attributes as Record<string, THREE.BufferAttribute>).aColor.needsUpdate = true;
      (geo.attributes as Record<string, THREE.BufferAttribute>).aSize.needsUpdate = true;
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
          <bufferAttribute attach="attributes-aColor" args={[colorsAttr, 3]} key={`color-${bufferVersion}`} />
          <bufferAttribute attach="attributes-aSize" args={[sizesAttr, 1]} key={`size-${bufferVersion}`} />
        </bufferGeometry>
        <shaderMaterial
          vertexShader={PARTICLE_VERT}
          fragmentShader={PARTICLE_FRAG}
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
