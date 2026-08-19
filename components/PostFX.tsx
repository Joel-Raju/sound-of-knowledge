"use client";

import { EffectComposer, Bloom, SMAA, Vignette, ChromaticAberration } from "@react-three/postprocessing";
import { BlendFunction, KernelSize } from "postprocessing";
import * as THREE from "three";

type Props = {
  isLowTier: boolean;
};

export default function PostFX({ isLowTier }: Props) {
  if (isLowTier) {
    return (
      <EffectComposer multisampling={0} enableNormalPass={false}>
        <Bloom
          intensity={0.8}
          luminanceThreshold={0.2}
          luminanceSmoothing={0.4}
          radius={0.7}
          mipmapBlur
          kernelSize={KernelSize.LARGE}
        />
        <Vignette
          eskil={false}
          offset={0.3}
          darkness={0.9}
          blendFunction={BlendFunction.NORMAL}
        />
      </EffectComposer>
    );
  }

  return (
    <EffectComposer multisampling={0} enableNormalPass={false}>
      {/* Signature Ori glow — strong, dreamy, wide-radius bloom */}
      <Bloom
        intensity={1.1}
        luminanceThreshold={0.2}
        luminanceSmoothing={0.4}
        radius={0.7}
        mipmapBlur
        kernelSize={KernelSize.LARGE}
      />

      {/* Cinematic edges */}
      <Vignette
        eskil={false}
        offset={0.3}
        darkness={0.9}
        blendFunction={BlendFunction.NORMAL}
      />

      {/* Subtle physical-lens RGB split */}
      <ChromaticAberration
        offset={new THREE.Vector2(0.0006, 0.0006)}
        radialModulation={false}
        modulationOffset={0}
        blendFunction={BlendFunction.NORMAL}
      />

      {/* SMAA replaces MSAA (broken under post-processing) */}
      <SMAA />
    </EffectComposer>
  );
}
