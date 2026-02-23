"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import * as THREE from "three";
import KnowledgeOrb from "./KnowledgeOrb";
import ParticleSystem, { type ParticleSystemHandle } from "./ParticleSystem";
import { useStore } from "@/lib/store";
import { getAudioEngine } from "@/lib/audio";
import type { WikiEditEvent } from "@/lib/types";

// ─── Color palette helpers ────────────────────────────────────────────────────

function getBaseColor(event: WikiEditEvent): THREE.Color {
  if (event.isRevert) return new THREE.Color(0x330a00);
  if (event.isBot) return new THREE.Color(0x1a2233);
  if (event.sizeDelta > 0) return new THREE.Color(0x0d1a3a);
  return new THREE.Color(0x1a0d2e);
}

function getEmissiveColor(event: WikiEditEvent): THREE.Color {
  if (event.isRevert) return new THREE.Color(0xff3300);
  if (event.isBot) return new THREE.Color(0x6699bb);
  if (event.sizeDelta > 0) return new THREE.Color(0x2266ff);
  return new THREE.Color(0x8833cc);
}

function getDisplace(magnitude: WikiEditEvent["magnitude"]): number {
  switch (magnitude) {
    case "TINY": return 0.05;
    case "SMALL": return 0.2;
    case "MEDIUM": return 0.55;
    case "LARGE": return 1.0;
  }
}

// ─── Camera shake ─────────────────────────────────────────────────────────────

function CameraShake({ shakeRef }: { shakeRef: React.MutableRefObject<number> }) {
  const { camera } = useThree();
  const originRef = useRef(new THREE.Vector3(0, 0, 6));
  const orbitAngle = useRef(0);

  useFrame((_, delta) => {
    orbitAngle.current += delta * 0.08;
    const ox = Math.sin(orbitAngle.current) * 0.3;
    const oy = Math.cos(orbitAngle.current * 0.7) * 0.15;
    originRef.current.set(ox, oy, 6);

    const shake = shakeRef.current;
    if (shake > 0) {
      camera.position.set(
        originRef.current.x + (Math.random() - 0.5) * shake * 0.15,
        originRef.current.y + (Math.random() - 0.5) * shake * 0.15,
        originRef.current.z + (Math.random() - 0.5) * shake * 0.05
      );
      shakeRef.current = Math.max(0, shake - delta * 3);
    } else {
      camera.position.lerp(originRef.current, 0.04);
    }
    camera.lookAt(0, 0, 0);
  });

  return null;
}

// ─── Inner scene (needs R3F context) ─────────────────────────────────────────

function InnerScene() {
  const particleRef = useRef<ParticleSystemHandle>(null);
  const shakeRef = useRef(0);
  const audioRef = useRef(getAudioEngine());

  const [visualState, setVisualState] = useState({
    amplitude: 0,
    lowFreq: 0,
    highFreq: 0,
    displace: 0,
    baseColor: new THREE.Color(0x0d1a3a),
    emissiveColor: new THREE.Color(0x2266ff),
    isRevert: 0,
  });

  const displaceRef = useRef(0);
  const isRevertRef = useRef(0);

  const setAudio = useStore((s) => s.setAudio);
  const dequeue = useStore((s) => s.dequeue);

  // Poll event queue each frame
  useFrame((_, delta) => {
    const audio = audioRef.current;
    const amp = audio.getAmplitude();
    const low = audio.getLowFreq();
    const high = audio.getHighFreq();

    setAudio({ amplitude: amp, lowFreq: low, highFreq: high });

    // Decay displace & revert
    displaceRef.current = Math.max(0, displaceRef.current - delta * 1.2);
    isRevertRef.current = Math.max(0, isRevertRef.current - delta * 1.5);

    // Process up to 3 events per frame to avoid audio pile-up
    for (let i = 0; i < 3; i++) {
      const event = dequeue();
      if (!event) break;

      audio.triggerEdit(event.magnitude, event.isBot, event.isRevert, event.sizeDelta);
      particleRef.current?.spawn(event);

      const newDisplace = Math.max(displaceRef.current, getDisplace(event.magnitude));
      displaceRef.current = newDisplace;

      if (event.isRevert || event.magnitude === "LARGE") {
        shakeRef.current = Math.min(1, shakeRef.current + 0.6);
        isRevertRef.current = event.isRevert ? 1 : 0.3;
      }

      setVisualState({
        amplitude: amp,
        lowFreq: low,
        highFreq: high,
        displace: displaceRef.current,
        baseColor: getBaseColor(event),
        emissiveColor: getEmissiveColor(event),
        isRevert: isRevertRef.current,
      });
    }
  });

  return (
    <>
      <CameraShake shakeRef={shakeRef} />
      <ambientLight intensity={0.15} />
      <pointLight position={[5, 5, 5]} intensity={1.2} color={0x4488ff} />
      <KnowledgeOrb
        amplitude={visualState.amplitude}
        lowFreq={visualState.lowFreq}
        highFreq={visualState.highFreq}
        displace={visualState.displace}
        baseColor={visualState.baseColor}
        emissiveColor={visualState.emissiveColor}
        isRevert={visualState.isRevert}
      />
      <ParticleSystem ref={particleRef} highFreq={visualState.highFreq} />
      <EffectComposer>
        <Bloom
          intensity={0.8 + visualState.amplitude * 1.5}
          luminanceThreshold={0.2}
          luminanceSmoothing={0.9}
          mipmapBlur
        />
      </EffectComposer>
    </>
  );
}

// ─── Public Scene component ───────────────────────────────────────────────────

export default function Scene() {
  const setConnected = useStore((s) => s.setConnected);
  const enqueue = useStore((s) => s.enqueue);
  const [audioReady, setAudioReady] = useState(false);

  const initAudio = useCallback(async () => {
    if (audioReady) return;
    await getAudioEngine().init();
    setAudioReady(true);
  }, [audioReady]);

  // SSE connection
  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimeout: ReturnType<typeof setTimeout>;

    function connect() {
      es = new EventSource("/api/wiki-stream");

      es.onopen = () => setConnected(true);

      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as WikiEditEvent;
          enqueue(event);
        } catch {
          // ignore
        }
      };

      es.onerror = () => {
        setConnected(false);
        es?.close();
        retryTimeout = setTimeout(connect, 3000);
      };
    }

    connect();

    return () => {
      es?.close();
      clearTimeout(retryTimeout);
      setConnected(false);
    };
  }, [enqueue, setConnected]);

  return (
    <div
      className="w-full h-full"
      onClick={initAudio}
      onTouchStart={initAudio}
    >
      {!audioReady && (
        <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
          <p className="text-white/40 text-sm tracking-widest uppercase animate-pulse">
            tap to activate sound
          </p>
        </div>
      )}
      <Canvas
        camera={{ position: [0, 0, 6], fov: 50 }}
        gl={{ antialias: true, alpha: false }}
        dpr={[1, 2]}
        style={{ background: "#020408" }}
      >
        <InnerScene />
      </Canvas>
    </div>
  );
}
