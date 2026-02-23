"use client";

import { useStore } from "@/lib/store";

export default function Overlay() {
  const totalCount = useStore((s) => s.totalCount);
  const audio = useStore((s) => s.audio);
  const overlayVisible = useStore((s) => s.overlayVisible);
  const toggleOverlay = useStore((s) => s.toggleOverlay);
  const connected = useStore((s) => s.connected);

  const intensityPct = Math.round(audio.amplitude * 100);

  return (
    <>
      {/* Toggle button */}
      <button
        onClick={toggleOverlay}
        className="absolute top-4 right-4 z-20 text-white/30 hover:text-white/70 transition-colors text-xs tracking-widest uppercase"
        aria-label="Toggle overlay"
      >
        {overlayVisible ? "hide" : "show"}
      </button>

      {overlayVisible && (
        <div className="absolute bottom-6 left-6 z-20 flex flex-col gap-2 pointer-events-none select-none">
          {/* Connection status */}
          <div className="flex items-center gap-2">
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                connected ? "bg-cyan-400 animate-pulse" : "bg-red-500"
              }`}
            />
            <span className="text-white/40 text-xs tracking-widest uppercase">
              {connected ? "live" : "connecting…"}
            </span>
          </div>

          {/* Edit count */}
          <div className="text-white/50 text-xs tracking-widest font-mono">
            <span className="text-white/20 uppercase mr-2">edits</span>
            {totalCount.toLocaleString()}
          </div>

          {/* Intensity meter */}
          <div className="flex items-center gap-2">
            <span className="text-white/20 text-xs tracking-widest uppercase">intensity</span>
            <div className="w-24 h-1 bg-white/10 rounded-full overflow-hidden">
              <div
                className="h-full bg-cyan-400 rounded-full transition-all duration-75"
                style={{ width: `${intensityPct}%` }}
              />
            </div>
            <span className="text-white/30 text-xs font-mono w-6">{intensityPct}</span>
          </div>
        </div>
      )}
    </>
  );
}
