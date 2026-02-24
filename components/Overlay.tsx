"use client";

import { useState } from "react";
import { useStore } from "@/lib/store";

export default function Overlay() {
  const totalCount = useStore((s) => s.totalCount);
  const history = useStore((s) => s.history);
  const audio = useStore((s) => s.audio);
  const overlayVisible = useStore((s) => s.overlayVisible);
  const toggleOverlay = useStore((s) => s.toggleOverlay);
  const connected = useStore((s) => s.connected);
  const [streamVisible, setStreamVisible] = useState(true);

  const intensityPct = Math.round(audio.amplitude * 100);
  const recentEdits = history.slice(-35).reverse();

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
        <button
          onClick={() => setStreamVisible((v) => !v)}
          className="absolute top-10 right-4 z-20 text-white/30 hover:text-white/70 transition-colors text-xs tracking-widest uppercase"
          aria-label="Toggle edits stream"
        >
          {streamVisible ? "hide stream" : "show stream"}
        </button>
      )}

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

      {overlayVisible && streamVisible && (
        <aside className="absolute right-4 top-16 bottom-4 z-20 w-88 rounded-xl border border-cyan-300/20 bg-slate-950/70 backdrop-blur-sm shadow-[0_0_30px_rgba(15,118,110,0.25)] pointer-events-auto">
          <div className="flex items-center justify-between px-3 py-2 border-b border-cyan-300/15">
            <p className="text-[11px] tracking-widest uppercase text-cyan-100/80">live edit stream</p>
            <span className="text-[10px] text-cyan-200/60">{recentEdits.length}</span>
          </div>

          <div className="h-[calc(100%-2.25rem)] overflow-y-auto px-2 py-2 space-y-2">
            {recentEdits.map((edit, index) => {
              const targetUrl = edit.editUrl ?? edit.pageUrl;
              return (
                <div
                  key={`${edit.id}-${edit.timestamp}-${index}`}
                  className="rounded-md border border-white/10 bg-white/3 px-2 py-1.5"
                >
                  <p className="text-xs text-cyan-50 truncate">{edit.title || "Untitled page"}</p>
                  <p className="text-[11px] text-cyan-200/70">
                    {edit.sizeDelta > 0 ? "+" : ""}
                    {edit.sizeDelta.toLocaleString()} bytes
                  </p>
                  {targetUrl ? (
                    <a
                      href={targetUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] text-cyan-300 hover:text-cyan-100 underline underline-offset-2"
                    >
                      open edit
                    </a>
                  ) : (
                    <span className="text-[11px] text-cyan-400/40">link unavailable</span>
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
