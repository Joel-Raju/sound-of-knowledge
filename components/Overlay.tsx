"use client";

import { useState, useEffect, useRef } from "react";
import { useStore } from "@/lib/store";

function useFPS() {
  const [fps, setFps] = useState(0);
  const framesRef = useRef(0);
  const lastTimeRef = useRef(performance.now());

  useEffect(() => {
    let rafId: number;
    
    const tick = () => {
      framesRef.current++;
      const now = performance.now();
      const delta = now - lastTimeRef.current;
      
      if (delta >= 1000) {
        setFps(Math.round((framesRef.current * 1000) / delta));
        framesRef.current = 0;
        lastTimeRef.current = now;
      }
      
      rafId = requestAnimationFrame(tick);
    };
    
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  return fps;
}

export default function Overlay() {
  const totalCount = useStore((s) => s.totalCount);
  const history = useStore((s) => s.history);
  const audio = useStore((s) => s.audio);
  const overlayVisible = useStore((s) => s.overlayVisible);
  const toggleOverlay = useStore((s) => s.toggleOverlay);
  const connected = useStore((s) => s.connected);
  const toggleAbout = useStore((s) => s.toggleAbout);
  const [streamVisible, setStreamVisible] = useState(false);
  const fps = useFPS();

  const intensityPct = Math.round(audio.amplitude * 100);
  const recentEdits = history.slice(-35).reverse();

  return (
    <>
      {/* About button */}
      <button
        onClick={toggleAbout}
        className="absolute top-3 left-3 sm:top-4 sm:left-4 z-20 text-white/30 hover:text-white/70 active:text-white/90 transition-colors text-[10px] sm:text-xs tracking-widest uppercase touch-manipulation"
        aria-label="About"
      >
        about
      </button>

      {/* Toggle button */}
      <button
        onClick={toggleOverlay}
        className="absolute top-3 right-3 sm:top-4 sm:right-4 z-20 text-white/30 hover:text-white/70 active:text-white/90 transition-colors text-[10px] sm:text-xs tracking-widest uppercase touch-manipulation"
        aria-label="Toggle overlay"
      >
        {overlayVisible ? "hide" : "show"}
      </button>

      {overlayVisible && (
        <button
          onClick={() => setStreamVisible((v) => !v)}
          className="absolute top-9 sm:top-10 right-3 sm:right-4 z-20 text-white/30 hover:text-white/70 active:text-white/90 transition-colors text-[10px] sm:text-xs tracking-widest uppercase touch-manipulation"
          aria-label="Toggle edits stream"
        >
          {streamVisible ? "hide stream" : "show stream"}
        </button>
      )}

      {overlayVisible && (
        <div className="absolute bottom-3 left-3 sm:bottom-6 sm:left-6 z-20 flex flex-col gap-1.5 sm:gap-2 pointer-events-none select-none">
          {/* Connection status */}
          <div className="flex items-center gap-1.5 sm:gap-2">
            <span
              className={`w-1 h-1 sm:w-1.5 sm:h-1.5 rounded-full ${
                connected ? "bg-cyan-400 animate-pulse" : "bg-red-500"
              }`}
            />
            <span className="text-white/40 text-[10px] sm:text-xs tracking-widest uppercase">
              {connected ? "live" : "connecting…"}
            </span>
          </div>

          {/* Edit count */}
          <div className="text-white/50 text-[10px] sm:text-xs tracking-widest font-mono">
            <span className="text-white/20 uppercase mr-1.5 sm:mr-2">edits</span>
            {totalCount.toLocaleString()}
          </div>

          {/* Intensity meter */}
          <div className="flex items-center gap-1.5 sm:gap-2">
            <span className="text-white/20 text-[10px] sm:text-xs tracking-widest uppercase">intensity</span>
            <div className="w-16 sm:w-24 h-0.5 sm:h-1 bg-white/10 rounded-full overflow-hidden">
              <div
                className="h-full bg-cyan-400 rounded-full transition-all duration-75"
                style={{ width: `${intensityPct}%` }}
              />
            </div>
            <span className="text-white/30 text-[10px] sm:text-xs font-mono w-5 sm:w-6">{intensityPct}</span>
          </div>

          {/* FPS counter */}
          <div className="text-white/40 text-[10px] sm:text-xs font-mono">
            <span className="text-white/20 uppercase mr-1.5 sm:mr-2">fps</span>
            {fps}
          </div>
        </div>
      )}

      {overlayVisible && streamVisible && (
        <aside className="absolute right-2 sm:right-4 top-14 sm:top-16 bottom-2 sm:bottom-4 z-20 w-72 sm:w-80 md:w-88 rounded-lg sm:rounded-xl border border-cyan-300/20 bg-slate-950/80 sm:bg-slate-950/70 backdrop-blur-sm shadow-[0_0_30px_rgba(15,118,110,0.25)] pointer-events-auto max-h-[calc(100vh-7rem)] sm:max-h-none">
          <div className="flex items-center justify-between px-2.5 sm:px-3 py-1.5 sm:py-2 border-b border-cyan-300/15">
            <p className="text-[10px] sm:text-[11px] tracking-widest uppercase text-cyan-100/80">live edit stream</p>
            <span className="text-[9px] sm:text-[10px] text-cyan-200/60">{recentEdits.length}</span>
          </div>

          <div className="h-[calc(100%-2.25rem)] overflow-y-auto px-1.5 sm:px-2 py-1.5 sm:py-2 space-y-1.5 sm:space-y-2 overscroll-contain">
            {recentEdits.map((edit, index) => {
              const targetUrl = edit.editUrl ?? edit.pageUrl;
              return (
                <div
                  key={`${edit.id}-${edit.timestamp}-${index}`}
                  className="rounded-md border border-white/10 bg-white/3 px-2 py-1.5 touch-manipulation"
                >
                  <p className="text-[11px] sm:text-xs text-cyan-50 truncate">{edit.title || "Untitled page"}</p>
                  <p className="text-[10px] sm:text-[11px] text-cyan-200/70">
                    {edit.sizeDelta > 0 ? "+" : ""}
                    {edit.sizeDelta.toLocaleString()} bytes
                  </p>
                  {targetUrl ? (
                    <a
                      href={targetUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[10px] sm:text-[11px] text-cyan-300 hover:text-cyan-100 active:text-cyan-50 underline underline-offset-2 inline-block py-0.5 touch-manipulation"
                    >
                      open edit
                    </a>
                  ) : (
                    <span className="text-[10px] sm:text-[11px] text-cyan-400/40">link unavailable</span>
                  )}
                </div>
              );
            })}
          </div>
        </aside>
      )}
    </>
  );
}
