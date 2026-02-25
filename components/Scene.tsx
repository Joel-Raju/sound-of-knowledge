"use client";

import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import KnowledgeOrb from "./KnowledgeOrb";
import ParticleSystem, {
  type ParticlePointerInfo,
  type ParticleSystemHandle,
} from "./ParticleSystem";
import { useStore } from "@/lib/store";
import { getAudioEngine } from "@/lib/audio";
import type { WikiEditEvent } from "@/lib/types";

// ─── Color palette helpers ────────────────────────────────────────────────────

function getBaseColor(event: WikiEditEvent): THREE.Color {
  if (event.isRevert) return new THREE.Color(0x1a0520);
  if (event.isBot)    return new THREE.Color(0x041520);
  if (event.sizeDelta > 0) return new THREE.Color(0x020d1a);
  return new THREE.Color(0x060a1e);
}

function getEmissiveColor(event: WikiEditEvent): THREE.Color {
  // Ori palette: white-cyan for adds, deep blue for removes, magenta for reverts
  if (event.isRevert) return new THREE.Color(0.9, 0.1, 1.0);
  if (event.isBot)    return new THREE.Color(0.2, 0.9, 0.8);
  if (event.sizeDelta > 0) return new THREE.Color(0.55, 0.92, 1.0);
  return new THREE.Color(0.1, 0.45, 1.0);
}

function getDisplace(magnitude: WikiEditEvent["magnitude"]): number {
  switch (magnitude) {
    case "TINY": return 0.05;
    case "SMALL": return 0.2;
    case "MEDIUM": return 0.55;
    case "LARGE": return 1.0;
  }
}

// ─── Camera drift ─────────────────────────────────────────────────────────────

function CameraDrift({ driftRef }: { driftRef: React.MutableRefObject<number> }) {
  const { camera } = useThree();
  const originRef   = useRef(new THREE.Vector3(0, 0, 5.5));
  const orbitAngle  = useRef(0);
  const lookTarget  = useRef(new THREE.Vector3());
  const shakeTarget = useRef(new THREE.Vector3());

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    // Very slow cinematic orbit — like a camera floating in a forest
    orbitAngle.current += delta * 0.025;

    const ox = Math.sin(orbitAngle.current) * 0.7 + Math.cos(t * 0.07) * 0.25;
    const oy = Math.cos(orbitAngle.current * 0.5) * 0.4 + Math.sin(t * 0.05) * 0.2;
    const oz = 5.5 + Math.sin(t * 0.04) * 0.4;
    originRef.current.set(ox, oy, oz);

    const drift = driftRef.current;
    if (drift > 0) {
      shakeTarget.current.set(
        originRef.current.x + (Math.random() - 0.5) * drift * 0.06,
        originRef.current.y + (Math.random() - 0.5) * drift * 0.06,
        originRef.current.z
      );
      camera.position.lerp(shakeTarget.current, 0.025);
      driftRef.current = Math.max(0, drift - delta * 1.2);
    } else {
      camera.position.lerp(originRef.current, 0.012);
    }

    // Subtle look-at wander — orb breathes, camera notices
    lookTarget.current.set(
      Math.sin(t * 0.08) * 0.12,
      Math.cos(t * 0.06) * 0.08,
      0
    );
    camera.lookAt(lookTarget.current);
  });

  return null;
}

// ── Volumetric-style inner glow ring ─────────────────────────────────────────
function SpiritGlow({ amplitude, lowFreq }: { amplitude: number; lowFreq: number }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const matRef  = useRef<THREE.MeshBasicMaterial>(null);

  useFrame((state) => {
    if (!meshRef.current || !matRef.current) return;
    const t = state.clock.elapsedTime;
    const pulse = 1.0 + Math.sin(t * 0.7) * 0.08 + amplitude * 0.25 + lowFreq * 0.15;
    meshRef.current.scale.setScalar(pulse * 1.0);
    matRef.current.opacity = 0.06 + amplitude * 0.12 + lowFreq * 0.06;
  });

  return (
    <mesh ref={meshRef}>
      <sphereGeometry args={[2.6, 32, 32]} />
      <meshBasicMaterial
        ref={matRef}
        color={new THREE.Color(0.0, 0.7, 1.0)}
        transparent
        side={THREE.BackSide}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </mesh>
  );
}

// ─── Inner scene (needs R3F context) ─────────────────────────────────────────

function InnerScene({
  isLowTier,
  onHoverChange,
  onParticleClick,
}: {
  isLowTier: boolean;
  onHoverChange: (info: ParticlePointerInfo | null) => void;
  onParticleClick: (info: ParticlePointerInfo) => void;
}) {
  const particleRef = useRef<ParticleSystemHandle>(null);
  const driftRef = useRef(0);
  const audioRef = useRef(getAudioEngine());

  const [visualState, setVisualState] = useState({
    amplitude: 0,
    lowFreq: 0,
    highFreq: 0,
    displace: 0,
    baseColor: new THREE.Color(0x0a1a2e),
    emissiveColor: new THREE.Color(0x7dd3fc),
    isRevert: 0,
  });

  const displaceRef = useRef(0);
  const isRevertRef = useRef(0);

  const setAudio = useStore((s) => s.setAudio);
  const dequeue = useStore((s) => s.dequeue);

  // Poll event queue each frame
  useFrame((state, delta) => {
    const audio = audioRef.current;
    const amp = audio.getAmplitude();
    const low = audio.getLowFreq();
    const high = audio.getHighFreq();

    setAudio({ amplitude: amp, lowFreq: low, highFreq: high });

    // Decay displace & revert (slower for dreamy feel)
    displaceRef.current = Math.max(0, displaceRef.current - delta * 0.8);
    isRevertRef.current = Math.max(0, isRevertRef.current - delta * 1.0);

    // Process fewer events on low-tier devices for better performance
    const maxEvents = isLowTier ? 1 : 2;
    for (let i = 0; i < maxEvents; i++) {
      const event = dequeue();
      if (!event) break;

      audio.triggerEdit(event);
      particleRef.current?.spawn(event);

      const newDisplace = Math.max(displaceRef.current, getDisplace(event.magnitude));
      displaceRef.current = newDisplace;

      if (event.isRevert || event.magnitude === "LARGE") {
        driftRef.current = Math.min(1, driftRef.current + 0.4);
        isRevertRef.current = event.isRevert ? 1 : 0.2;
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
      <CameraDrift driftRef={driftRef} />

      {/* Deep forest darkness — very low ambient */}
      <ambientLight intensity={0.04} color={0x0a1a2e} />

      {/* Ori's spirit light: cool white-blue key light */}
      <pointLight position={[0, 0, 4]}  intensity={2.5} color={0xaaddff} distance={12} decay={2} />

      {/* Bioluminescent fill: teal from below (forest floor glow) */}
      <pointLight position={[0, -4, 2]} intensity={1.2} color={0x00ccaa} distance={10} decay={2} />

      {/* Deep purple rim from behind (Kuro's shadow) */}
      <pointLight position={[-3, 2, -4]} intensity={0.8} color={0x4400aa} distance={14} decay={2} />

      {/* Soft cyan fill from above */}
      <pointLight position={[2, 5, 1]}  intensity={0.6} color={0x00aaff} distance={12} decay={2} />

      <KnowledgeOrb
        amplitude={visualState.amplitude}
        lowFreq={visualState.lowFreq}
        highFreq={visualState.highFreq}
        displace={visualState.displace}
        baseColor={visualState.baseColor}
        emissiveColor={visualState.emissiveColor}
        isRevert={visualState.isRevert}
        isLowTier={isLowTier}
      />

      {/* Volumetric inner glow sphere */}
      <SpiritGlow amplitude={visualState.amplitude} lowFreq={visualState.lowFreq} />

      <ParticleSystem
        ref={particleRef}
        highFreq={visualState.highFreq}
        lowFreq={visualState.lowFreq}
        isLowTier={isLowTier}
        onHoverChange={onHoverChange}
        onParticleClick={onParticleClick}
      />

      {/* Deep forest fog — starts close, very dark blue */}
      <fog attach="fog" args={[0x010510, 5, 22]} />
    </>
  );
}

function detectLowTierDevice() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent.toLowerCase();
  const isMobile = /iphone|ipad|ipod|android|mobile/.test(ua);
  const lowCpu = (navigator.hardwareConcurrency ?? 8) <= 6;
  const lowMemory = (navigator as any).deviceMemory ? (navigator as any).deviceMemory < 4 : false;
  return isMobile || lowCpu || lowMemory;
}

function isMobileDevice() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent.toLowerCase();
  return /iphone|ipad|ipod|android|mobile/.test(ua);
}

// ─── Public Scene component ───────────────────────────────────────────────────

export default function Scene() {
  const setConnected = useStore((s) => s.setConnected);
  const enqueue = useStore((s) => s.enqueue);
  const introFinished = useStore((s) => s.introFinished);
  const [audioReady, setAudioReady] = useState(false);
  const [popoverInfo, setPopoverInfo] = useState<ParticlePointerInfo | null>(null);
  const isLowTier = useMemo(() => detectLowTierDevice(), []);

  const handleParticleHover = useCallback((info: ParticlePointerInfo | null) => {
    setPopoverInfo(info);
  }, []);

  const handleParticleClick = useCallback((info: ParticlePointerInfo) => {
    setPopoverInfo(info);
    const targetUrl = info.event.editUrl ?? info.event.pageUrl;
    if (targetUrl) {
      window.open(targetUrl, "_blank", "noopener,noreferrer");
    }
  }, []);

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
      {introFinished && !audioReady && (
        <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
          <p className="text-white/40 text-sm tracking-widest uppercase animate-pulse">
            tap to activate sound
          </p>
        </div>
      )}
      <Canvas
        camera={{ position: [0, 0, 5.5], fov: isMobileDevice() ? 50 : 42 }}
        gl={{ antialias: !isLowTier, alpha: false, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.7, powerPreference: "high-performance" }}
        onCreated={({ gl }) => {
          gl.outputColorSpace = THREE.SRGBColorSpace;
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = isLowTier ? 1.5 : 1.8;
          gl.setPixelRatio(Math.min(window.devicePixelRatio, isLowTier ? 1 : 2));
        }}
        dpr={isLowTier ? [1, 1] : [1, 2]}
        style={{ background: "#010510" }}
        frameloop="always"
        performance={{ min: 0.5 }}
      >
        <InnerScene
          isLowTier={isLowTier}
          onHoverChange={handleParticleHover}
          onParticleClick={handleParticleClick}
        />
      </Canvas>

      {popoverInfo && (
        <div
          className="absolute z-30 max-w-70 sm:max-w-xs rounded-md sm:rounded-lg border border-cyan-300/35 bg-slate-950/95 px-2.5 sm:px-3 py-1.5 sm:py-2 text-[11px] sm:text-xs text-cyan-100 shadow-[0_0_30px_rgba(34,211,238,0.25)] pointer-events-none"
          style={{
            left: Math.min(window.innerWidth - (isMobileDevice() ? 290 : 280), popoverInfo.screenX + (isMobileDevice() ? 10 : 14)),
            top: Math.max(10, popoverInfo.screenY - (isMobileDevice() ? 30 : 24)),
          }}
        >
          <p className="font-semibold text-cyan-50 truncate text-xs sm:text-sm">{popoverInfo.event.title || "Untitled page"}</p>
          <p className="mt-0.5 sm:mt-1 text-cyan-200/80">
            delta: {popoverInfo.event.sizeDelta > 0 ? "+" : ""}
            {popoverInfo.event.sizeDelta.toLocaleString()} bytes
          </p>
          <p className="text-cyan-300/75 hidden sm:block">click particle to open this exact edit</p>
        </div>
      )}
    </div>
  );
}
