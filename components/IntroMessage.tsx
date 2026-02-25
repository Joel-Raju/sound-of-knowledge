"use client";

import { useState, useEffect } from "react";
import { useStore } from "@/lib/store";
import IntroContent from "./IntroContent";

export default function IntroMessage() {
  const [visible, setVisible] = useState(true);
  const [fading, setFading] = useState(false);
  const setIntroFinished = useStore((s) => s.setIntroFinished);

  useEffect(() => {
    // Start fading after 4 seconds
    const fadeTimer = setTimeout(() => {
      setFading(true);
    }, 4000);

    // Remove from DOM and signal completion after fade animation
    const hideTimer = setTimeout(() => {
      setVisible(false);
      setIntroFinished(true);
    }, 5500);

    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(hideTimer);
    };
  }, []);

  if (!visible) return null;

  return (
    <div
      className={`absolute inset-0 z-40 flex items-center justify-center pointer-events-none transition-opacity duration-1500 ease-out ${
        fading ? "opacity-0" : "opacity-100"
      }`}
    >
      <IntroContent />
    </div>
  );
}
