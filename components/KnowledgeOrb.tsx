"use client";

import { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { vertexShader, fragmentShader } from "@/lib/shaders";

type Props = {
  amplitude: number;
  lowFreq: number;
  highFreq: number;
  displace: number;
  baseColor: THREE.Color;
  emissiveColor: THREE.Color;
  isRevert: number;
};

export default function KnowledgeOrb({
  amplitude,
  lowFreq,
  highFreq,
  displace,
  baseColor,
  emissiveColor,
  isRevert,
}: Props) {
  const meshRef = useRef<THREE.Mesh>(null);

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
    }),
    []
  );

  useFrame((state) => {
    if (!meshRef.current) return;
    const t = state.clock.elapsedTime;

    uniforms.uTime.value = t;
    uniforms.uAmplitude.value = THREE.MathUtils.lerp(uniforms.uAmplitude.value, amplitude, 0.12);
    uniforms.uLowFreq.value = THREE.MathUtils.lerp(uniforms.uLowFreq.value, lowFreq, 0.08);
    uniforms.uHighFreq.value = THREE.MathUtils.lerp(uniforms.uHighFreq.value, highFreq, 0.15);
    uniforms.uDisplace.value = THREE.MathUtils.lerp(uniforms.uDisplace.value, displace, 0.06);
    uniforms.uBaseColor.value.lerp(baseColor, 0.05);
    uniforms.uEmissiveColor.value.lerp(emissiveColor, 0.08);
    uniforms.uIsRevert.value = THREE.MathUtils.lerp(uniforms.uIsRevert.value, isRevert, 0.1);

    meshRef.current.rotation.x = t * 0.07;
    meshRef.current.rotation.y = t * 0.11;
    meshRef.current.rotation.z = t * 0.04;
  });

  return (
    <mesh ref={meshRef}>
      <icosahedronGeometry args={[1.8, 6]} />
      <shaderMaterial
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        uniforms={uniforms}
        side={THREE.FrontSide}
      />
    </mesh>
  );
}
