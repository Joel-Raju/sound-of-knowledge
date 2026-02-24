"use client";

import { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import {
  orbVertexShader,
  orbVolumetricFragmentShader,
  orbFallbackFragmentShader,
} from "@/lib/shaders";

type Props = {
  amplitude: number;
  lowFreq: number;
  highFreq: number;
  displace: number;
  baseColor: THREE.Color;
  emissiveColor: THREE.Color;
  isRevert: number;
  isLowTier: boolean;
};

export default function KnowledgeOrb({
  amplitude,
  lowFreq,
  highFreq,
  displace,
  baseColor,
  emissiveColor,
  isRevert,
  isLowTier,
}: Props) {
  const meshRef = useRef<THREE.Mesh>(null);
  const materialRef = useRef<THREE.ShaderMaterial>(null);

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uAmplitude: { value: 0 },
      uLowFreq: { value: 0 },
      uHighFreq: { value: 0 },
      uDisplace: { value: 0 },
      uBaseColor: { value: new THREE.Color(0x1a2a6c) },
      uEmissiveColor: { value: new THREE.Color(0x4488ff) },
      uIsRevert: { value: 0 },
      uRadius: { value: 1.8 },
    }),
    []
  );

  useFrame((state) => {
    if (!meshRef.current || !materialRef.current) return;
    const t = state.clock.elapsedTime;
    const u = materialRef.current.uniforms;

    u.uTime.value = t;
    u.uAmplitude.value = THREE.MathUtils.lerp(u.uAmplitude.value, amplitude, 0.10);
    u.uLowFreq.value   = THREE.MathUtils.lerp(u.uLowFreq.value,   lowFreq,   0.07);
    u.uHighFreq.value  = THREE.MathUtils.lerp(u.uHighFreq.value,  highFreq,  0.12);
    u.uDisplace.value  = THREE.MathUtils.lerp(u.uDisplace.value,  displace,  0.05);
    u.uBaseColor.value.lerp(baseColor, 0.04);
    u.uEmissiveColor.value.lerp(emissiveColor, 0.06);
    u.uIsRevert.value  = THREE.MathUtils.lerp(u.uIsRevert.value,  isRevert,  0.08);

    // Very slow, organic rotation — Ori's spirit orb breathes, doesn't spin fast
    meshRef.current.rotation.x = t * 0.04;
    meshRef.current.rotation.y = t * 0.06;
    meshRef.current.rotation.z = Math.sin(t * 0.03) * 0.15;
  });

  return (
    <mesh ref={meshRef}>
      <sphereGeometry args={[1.8, isLowTier ? 64 : 128, isLowTier ? 64 : 128]} />
      <shaderMaterial
        ref={materialRef}
        vertexShader={orbVertexShader}
        fragmentShader={isLowTier ? orbFallbackFragmentShader : orbVolumetricFragmentShader}
        uniforms={uniforms}
        side={THREE.FrontSide}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </mesh>
  );
}
