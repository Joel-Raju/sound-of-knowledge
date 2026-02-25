"use client";

import { useStore } from "@/lib/store";
import IntroContent from "./IntroContent";

export default function AboutModal() {
  const aboutVisible = useStore((s) => s.aboutVisible);
  const setAboutVisible = useStore((s) => s.setAboutVisible);

  if (!aboutVisible) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={() => setAboutVisible(false)}
    >
      <div
        className="text-center space-y-6 px-8 py-12"
        onClick={(e) => e.stopPropagation()}
      >
        <IntroContent />
        <button
          onClick={() => setAboutVisible(false)}
          className="mt-8 text-white/40 hover:text-white/70 transition-colors text-xs tracking-widest uppercase"
        >
          close
        </button>
      </div>
    </div>
  );
}
