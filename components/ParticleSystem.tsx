"use client";

import { useRef, useMemo, useCallback, forwardRef, useImperativeHandle } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { WikiEditEvent } from "@/lib/types";

export type ParticleSystemHandle = {
  spawn: (event: WikiEditEvent) => void;
};

const MAX_PARTICLES = 2000;

type Particle = {
  active: boolean;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
  size: number;
  color: THREE.Color;
};

function magnitudeParticleCount(magnitude: WikiEditEvent["magnitude"]): number {
  switch (magnitude) {
    case "TINY": return 1;
    case "SMALL": return 4;
    case "MEDIUM": return 12;
    case "LARGE": return 40;
  }
}

function magnitudeParticleSize(magnitude: WikiEditEvent["magnitude"]): number {
  switch (magnitude) {
    case "TINY": return 0.04;
    case "SMALL": return 0.07;
    case "MEDIUM": return 0.12;
    case "LARGE": return 0.22;
  }
}

function magnitudeLife(magnitude: WikiEditEvent["magnitude"]): number {
  switch (magnitude) {
    case "TINY": return 0.8;
    case "SMALL": return 1.4;
    case "MEDIUM": return 2.2;
    case "LARGE": return 3.5;
  }
}

function editColor(event: WikiEditEvent): THREE.Color {
  if (event.isRevert) return new THREE.Color(0xff4400);
  if (event.isBot) return new THREE.Color(0x88aacc);
  if (event.sizeDelta > 0) return new THREE.Color(0x44aaff);
  return new THREE.Color(0x6633aa);
}

type Props = {
  highFreq: number;
};

const ParticleSystem = forwardRef<ParticleSystemHandle, Props>(function ParticleSystem({ highFreq }, ref) {
  const pointsRef = useRef<THREE.Points>(null);

  const particles = useMemo<Particle[]>(() => {
    return Array.from({ length: MAX_PARTICLES }, () => ({
      active: false,
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      life: 0,
      maxLife: 1,
      size: 0.05,
      color: new THREE.Color(0x4488ff),
    }));
  }, []);

  const positions = useMemo(() => new Float32Array(MAX_PARTICLES * 3), []);
  const colors = useMemo(() => new Float32Array(MAX_PARTICLES * 3), []);
  const sizes = useMemo(() => new Float32Array(MAX_PARTICLES), []);

  const geoRef = useRef<THREE.BufferGeometry>(null);

  const spawnParticles = useCallback(
    (event: WikiEditEvent) => {
      const count = magnitudeParticleCount(event.magnitude);
      const size = magnitudeParticleSize(event.magnitude);
      const life = magnitudeLife(event.magnitude);
      const color = editColor(event);
      const speed = event.magnitude === "LARGE" ? 2.5 : event.magnitude === "MEDIUM" ? 1.5 : 0.8;

      let spawned = 0;
      for (let i = 0; i < MAX_PARTICLES && spawned < count; i++) {
        if (!particles[i].active) {
          const p = particles[i];
          p.active = true;
          p.life = life;
          p.maxLife = life;
          p.size = size;
          p.color.copy(color);

          // Spawn on sphere surface
          const theta = Math.random() * Math.PI * 2;
          const phi = Math.acos(2 * Math.random() - 1);
          const r = 1.8 + Math.random() * 0.3;
          p.position.set(
            r * Math.sin(phi) * Math.cos(theta),
            r * Math.sin(phi) * Math.sin(theta),
            r * Math.cos(phi)
          );

          // Velocity outward + slight tangent
          const outward = p.position.clone().normalize().multiplyScalar(speed);
          const tangent = new THREE.Vector3(
            Math.random() - 0.5,
            Math.random() - 0.5,
            Math.random() - 0.5
          )
            .normalize()
            .multiplyScalar(speed * 0.4);
          p.velocity.copy(outward).add(tangent);

          spawned++;
        }
      }
    },
    [particles]
  );

  useImperativeHandle(ref, () => ({ spawn: spawnParticles }), [spawnParticles]);

  useFrame((_, delta) => {
    const geo = geoRef.current;
    if (!geo) return;

    const speedMult = 1 + highFreq * 1.5;

    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = particles[i];
      const i3 = i * 3;

      if (p.active) {
        p.life -= delta;
        if (p.life <= 0) {
          p.active = false;
          positions[i3] = 0;
          positions[i3 + 1] = 0;
          positions[i3 + 2] = 0;
          sizes[i] = 0;
          colors[i3] = 0;
          colors[i3 + 1] = 0;
          colors[i3 + 2] = 0;
          continue;
        }

        p.position.addScaledVector(p.velocity, delta * speedMult);
        p.velocity.multiplyScalar(0.97); // drag

        const t = p.life / p.maxLife;
        positions[i3] = p.position.x;
        positions[i3 + 1] = p.position.y;
        positions[i3 + 2] = p.position.z;
        sizes[i] = p.size * t * t;
        colors[i3] = p.color.r * t;
        colors[i3 + 1] = p.color.g * t;
        colors[i3 + 2] = p.color.b * t;
      } else {
        positions[i3] = 0;
        positions[i3 + 1] = 0;
        positions[i3 + 2] = 0;
        sizes[i] = 0;
      }
    }

    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.attributes.size.needsUpdate = true;
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry ref={geoRef}>
        <bufferAttribute
          attach="attributes-position"
          args={[positions, 3]}
        />
        <bufferAttribute
          attach="attributes-color"
          args={[colors, 3]}
        />
        <bufferAttribute
          attach="attributes-size"
          args={[sizes, 1]}
        />
      </bufferGeometry>
      <pointsMaterial
        size={0.08}
        vertexColors
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        sizeAttenuation
      />
    </points>
  );
});

export default ParticleSystem;
