"use client";

import { useRef, useMemo, useCallback, useEffect, useState, forwardRef, useImperativeHandle } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { WikiEditEvent } from "@/lib/types";

export type ParticleSystemHandle = {
  spawn: (event: WikiEditEvent) => void;
};

// Ori color palette
const ORI_COLORS = {
  // Revert = Kuro's dark corruption: deep magenta/purple
  revert:  new THREE.Color(0.9, 0.1, 1.0),
  // Bot = mechanical teal
  bot:     new THREE.Color(0.2, 0.9, 0.8),
  // Add = Ori's spirit light: bright white-cyan
  add:     new THREE.Color(0.6, 0.95, 1.0),
  // Remove = deep blue energy
  remove:  new THREE.Color(0.1, 0.5, 1.0),
  // Ambient wisps: soft teal/blue motes
  ambient: [
    new THREE.Color(0.0, 0.8, 0.9),
    new THREE.Color(0.3, 0.7, 1.0),
    new THREE.Color(0.5, 0.9, 1.0),
    new THREE.Color(0.1, 0.6, 0.8),
    new THREE.Color(0.7, 0.95, 1.0),
  ],
};

type Particle = {
  active: boolean;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  acceleration: THREE.Vector3;
  life: number;
  maxLife: number;
  size: number;
  baseSize: number;
  color: THREE.Color;
  type: "wisp" | "mote" | "streak";
  // orbit / spiral params
  orbitAxis: THREE.Vector3;
  orbitRadius: number;
  orbitAngle: number;
  orbitSpeed: number;
  orbitHeight: number;
  spiralTightness: number;
};

function createInitialParticles(maxParticles: number, moteCount: number): Particle[] {
  return Array.from({ length: maxParticles }, (_, i): Particle => {
    if (i < moteCount) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = 2.2 + Math.random() * 3.5;
      const axis = new THREE.Vector3(
        Math.random() - 0.5,
        Math.random() - 0.5,
        Math.random() - 0.5
      ).normalize();
      const size = 0.04 + Math.random() * 0.06;

      return {
        active: true,
        position: new THREE.Vector3(
          r * Math.sin(phi) * Math.cos(theta),
          r * Math.sin(phi) * Math.sin(theta),
          r * Math.cos(phi)
        ),
        velocity: new THREE.Vector3(),
        acceleration: new THREE.Vector3(),
        life: Infinity,
        maxLife: Infinity,
        size,
        baseSize: size,
        color: ORI_COLORS.ambient[i % ORI_COLORS.ambient.length].clone(),
        type: "mote",
        orbitAxis: axis,
        orbitRadius: r,
        orbitAngle: theta,
        orbitSpeed: (0.03 + Math.random() * 0.06) * (Math.random() < 0.5 ? 1 : -1),
        orbitHeight: (Math.random() - 0.5) * 0.8,
        spiralTightness: 0,
      };
    }

    return {
      active: false,
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      acceleration: new THREE.Vector3(),
      life: 0,
      maxLife: 1,
      size: 0.1,
      baseSize: 0.1,
      color: ORI_COLORS.add.clone(),
      type: "wisp",
      orbitAxis: new THREE.Vector3(0, 1, 0),
      orbitRadius: 0,
      orbitAngle: 0,
      orbitSpeed: 0,
      orbitHeight: 0,
      spiralTightness: 0,
    };
  });
}

// ── Magnitude helpers ─────────────────────────────────────────────────────────
function magnitudeCount(magnitude: WikiEditEvent["magnitude"]): number {
  switch (magnitude) {
    case "TINY":   return 3;
    case "SMALL":  return 10;
    case "MEDIUM": return 28;
    case "LARGE":  return 70;
  }
}
function magnitudeSize(magnitude: WikiEditEvent["magnitude"]): number {
  switch (magnitude) {
    case "TINY":   return 0.07;
    case "SMALL":  return 0.12;
    case "MEDIUM": return 0.20;
    case "LARGE":  return 0.35;
  }
}
function magnitudeLife(magnitude: WikiEditEvent["magnitude"]): number {
  switch (magnitude) {
    case "TINY":   return 2.0;
    case "SMALL":  return 3.5;
    case "MEDIUM": return 5.5;
    case "LARGE":  return 8.0;
  }
}
function editColor(event: WikiEditEvent): THREE.Color {
  if (event.isRevert)    return ORI_COLORS.revert;
  if (event.isBot)       return ORI_COLORS.bot;
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
    // Size attenuation
    gl_PointSize = aSize * (350.0 / -mv.z);
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
  lowFreq:  number;
  isLowTier: boolean;
};

// ── Component ─────────────────────────────────────────────────────────────────
const ParticleSystem = forwardRef<ParticleSystemHandle, Props>(
  function ParticleSystem({ highFreq, lowFreq, isLowTier }, ref) {
  const maxParticles = isLowTier ? 10_000 : 50_000;
  const moteCount = isLowTier ? 350 : 900;
  const spawnStart = moteCount;
  const [bufferVersion, setBufferVersion] = useState(0);

  const geoRef    = useRef<THREE.BufferGeometry>(null);
  const matRef    = useRef<THREE.ShaderMaterial>(null);
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
    particlesRef.current = createInitialParticles(maxParticles, moteCount);
    setPositionsAttr(positionsRef.current);
    setColorsAttr(aColorsRef.current);
    setSizesAttr(aSizesRef.current);
    setBufferVersion((v) => v + 1);
  }, [maxParticles, moteCount]);

  // ── Spawn on wiki event ─────────────────────────────────────────────────────
  const spawnParticles = useCallback((event: WikiEditEvent) => {
    const particles = particlesRef.current;
    if (particles.length === 0) return;

    const count = magnitudeCount(event.magnitude);
    const size  = magnitudeSize(event.magnitude);
    const life  = magnitudeLife(event.magnitude);
    const color = editColor(event);
    const speed = event.magnitude === "LARGE" ? 2.2
                : event.magnitude === "MEDIUM" ? 1.4
                : event.magnitude === "SMALL"  ? 0.8
                : 0.4;

    // Decide particle type mix based on magnitude
    const streakFrac = event.magnitude === "LARGE" ? 0.3 : 0.1;

    let spawned = 0;
    for (let i = spawnStart; i < maxParticles && spawned < count; i++) {
      if (particles[i].active) continue;
      const p = particles[i];

      p.active   = true;
      p.life     = life * (0.7 + Math.random() * 0.6);
      p.maxLife  = p.life;
      p.baseSize = size * (0.6 + Math.random() * 0.8);
      p.size     = p.baseSize;
      p.color.copy(color);
      p.type     = Math.random() < streakFrac ? "streak" : "wisp";

      // Spawn on orb surface
      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.acos(2 * Math.random() - 1);
      const r     = 1.85 + Math.random() * 0.3;
      p.position.set(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.sin(phi) * Math.sin(theta),
        r * Math.cos(phi)
      );

      // Velocity: outward burst + strong tangential spiral (Ori wisp curl)
      const outward = p.position.clone().normalize();
      // Perpendicular tangent for spiral
      const up      = Math.abs(outward.y) < 0.9
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(1, 0, 0);
      const tangent = new THREE.Vector3().crossVectors(outward, up).normalize();
      const binorm  = new THREE.Vector3().crossVectors(outward, tangent).normalize();

      const spiralDir = tangent.clone()
        .multiplyScalar(Math.cos(theta * 3))
        .addScaledVector(binorm, Math.sin(theta * 3));

      p.velocity
        .copy(outward).multiplyScalar(speed * 0.4)
        .addScaledVector(spiralDir, speed * 0.9)
        .addScaledVector(
          new THREE.Vector3(Math.random()-0.5, Math.random()-0.5, Math.random()-0.5),
          speed * 0.25
        );

      // Streaks get stronger outward kick
      if (p.type === "streak") {
        p.velocity.addScaledVector(outward, speed * 0.8);
        p.baseSize *= 1.6;
      }

      // Gentle upward float (Ori particles always drift up)
      p.acceleration.set(
        (Math.random() - 0.5) * 0.1,
        0.15 + Math.random() * 0.2,
        (Math.random() - 0.5) * 0.1
      );

      p.spiralTightness = 0.3 + Math.random() * 0.4;
      spawned++;
    }
  }, [spawnStart, maxParticles]);

  useImperativeHandle(ref, () => ({ spawn: spawnParticles }), [spawnParticles]);

  // ── Per-frame update ────────────────────────────────────────────────────────
  useFrame((state, delta) => {
    const geo = geoRef.current;
    if (!geo) return;

    const particles = particlesRef.current;
    const positions = positionsRef.current;
    const aColors = aColorsRef.current;
    const aSizes = aSizesRef.current;
    if (particles.length === 0) return;

    const t          = state.clock.elapsedTime;
    const audioBoost = 1.0 + highFreq * 0.6 + lowFreq * 0.3;
    const breathPulse = 1.0 + Math.sin(t * 0.7) * 0.12 + lowFreq * 0.15;

    for (let i = 0; i < maxParticles; i++) {
      const p  = particles[i];
      const i3 = i * 3;

      // ── Ambient motes ────────────────────────────────────────────────────
      if (p.type === "mote") {
        // True 3-D orbit around tilted axis
        p.orbitAngle += p.orbitSpeed * delta * (1.0 + lowFreq * 0.4);

        // Rodrigues rotation: rotate initial radial vector around orbitAxis
        const cosA = Math.cos(p.orbitAngle);
        const sinA = Math.sin(p.orbitAngle);
        const ax   = p.orbitAxis;
        const r    = p.orbitRadius * (1.0 + Math.sin(t * 0.25 + i * 0.07) * 0.06);

        // Pick a stable "initial" direction perpendicular to axis
        const initDir = Math.abs(ax.y) < 0.9
          ? new THREE.Vector3(1, 0, 0)
          : new THREE.Vector3(0, 0, 1);
        const perp = new THREE.Vector3().crossVectors(ax, initDir).normalize();
        const perp2 = new THREE.Vector3().crossVectors(ax, perp).normalize();

        p.position.set(
          r * (perp.x * cosA + perp2.x * sinA),
          r * (perp.y * cosA + perp2.y * sinA) + p.orbitHeight,
          r * (perp.z * cosA + perp2.z * sinA)
        );

        // Twinkle: each mote has its own phase
        const twinkle = 0.55 + Math.sin(t * 1.8 + i * 0.37) * 0.45;
        const sz      = p.baseSize * twinkle * breathPulse;

        positions[i3]     = p.position.x;
        positions[i3 + 1] = p.position.y;
        positions[i3 + 2] = p.position.z;
        aSizes[i]         = sz;
        aColors[i3]       = p.color.r * twinkle;
        aColors[i3 + 1]   = p.color.g * twinkle;
        aColors[i3 + 2]   = p.color.b * twinkle;
        continue;
      }

      // ── Spawn particles (wisp / streak) ─────────────────────────────────
      if (!p.active) continue;

      p.life -= delta;
      if (p.life <= 0) {
        p.active = false;
        positions[i3] = positions[i3+1] = positions[i3+2] = 0;
        aSizes[i] = 0;
        aColors[i3] = aColors[i3+1] = aColors[i3+2] = 0;
        continue;
      }

      // Physics
      p.velocity.addScaledVector(p.acceleration, delta);
      p.velocity.multiplyScalar(p.type === "streak" ? 0.978 : 0.970);
      p.position.addScaledVector(p.velocity, delta * audioBoost * 0.55);

      if (p.position.lengthSq() > 35.0 * 35.0) {
        p.active = false;
        positions[i3] = positions[i3+1] = positions[i3+2] = 0;
        aSizes[i] = 0;
        aColors[i3] = aColors[i3+1] = aColors[i3+2] = 0;
        continue;
      }

      const lr = p.life / p.maxLife;          // 1→0
      const fadeIn  = Math.min(1, (1 - lr) * 8); // quick fade-in at birth
      // Wisps: smooth bell curve. Streaks: sharp spike then fade
      const envelope = p.type === "streak"
        ? lr * lr * (1 - lr) * 4
        : Math.sin(lr * Math.PI) * fadeIn;

      const sz = p.baseSize * envelope * (1.0 + highFreq * 0.5) * audioBoost;

      positions[i3]     = p.position.x;
      positions[i3 + 1] = p.position.y;
      positions[i3 + 2] = p.position.z;
      aSizes[i]         = sz;
      aColors[i3]       = p.color.r * envelope;
      aColors[i3 + 1]   = p.color.g * envelope;
      aColors[i3 + 2]   = p.color.b * envelope;
    }

    geo.attributes.position.needsUpdate = true;
    (geo.attributes as Record<string, THREE.BufferAttribute>).aColor.needsUpdate = true;
    (geo.attributes as Record<string, THREE.BufferAttribute>).aSize.needsUpdate  = true;
  });

  // ── Shader uniforms ─────────────────────────────────────────────────────────
  const uniforms = useMemo(() => ({ uTime: { value: 0 } }), []);

  return (
    <points>
      <bufferGeometry ref={geoRef}>
        <bufferAttribute attach="attributes-position" args={[positionsAttr, 3]} key={`pos-${bufferVersion}`} />
        <bufferAttribute attach="attributes-aColor"   args={[colorsAttr, 3]} key={`color-${bufferVersion}`} />
        <bufferAttribute attach="attributes-aSize"    args={[sizesAttr, 1]} key={`size-${bufferVersion}`} />
      </bufferGeometry>
      <shaderMaterial
        ref={matRef}
        vertexShader={PARTICLE_VERT}
        fragmentShader={PARTICLE_FRAG}
        uniforms={uniforms}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
});

export default ParticleSystem;
