"use client";

import { useStore } from "@/lib/store";
import IntroContent from "./IntroContent";

export default function AboutModal() {
  const aboutVisible = useStore((s) => s.aboutVisible);
  const setAboutVisible = useStore((s) => s.setAboutVisible);

  if (!aboutVisible) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm px-4"
      onClick={() => setAboutVisible(false)}
    >
      <div
        className="text-center space-y-4 sm:space-y-6 px-4 sm:px-8 py-8 sm:py-12 max-w-lg w-full"
        onClick={(e) => e.stopPropagation()}
      >
        <IntroContent />
        <button
          onClick={() => setAboutVisible(false)}
          className="mt-6 sm:mt-8 text-white/40 hover:text-white/70 active:text-white/90 transition-colors text-xs tracking-widest uppercase touch-manipulation inline-block py-2"
        >
          close
        </button>
      </div>
    </div>
  );
}
