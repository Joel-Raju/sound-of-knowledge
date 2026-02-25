"use client";

import dynamic from "next/dynamic";
import Overlay from "@/components/Overlay";
import IntroMessage from "@/components/IntroMessage";
import AboutModal from "@/components/AboutModal";

const Scene = dynamic(() => import("@/components/Scene"), { ssr: false });

export default function Home() {
  return (
    <main className="relative w-screen h-screen bg-black">
      <Scene />
      <Overlay />
      <IntroMessage />
      <AboutModal />

      {/* Footer */}
      <div className="absolute bottom-3 sm:bottom-4 left-1/2 -translate-x-1/2 z-20">
        <a
          href="https://joelraju.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-white/30 hover:text-white/60 active:text-white/80 transition-colors text-[10px] sm:text-xs tracking-widest touch-manipulation inline-block py-1"
        >
          created by: joelraju.com
        </a>
      </div>
    </main>
  );
}
