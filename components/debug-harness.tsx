"use client";

import { useEffect } from "react";

/**
 * Debug-only audio harness mount. Spec §13.3.
 *
 * Installs `window.__sok.renderOffline` when `?debug=1` so
 * `scripts/render-audio.ts` can drive a full offline render from Playwright.
 *
 * The engine is **dynamically imported**, never statically: it pulls in the
 * whole audio graph and the scheduler, and the production bundle has a 40 KB
 * budget (§12.4). A debug-only affordance must not cost a production visitor a
 * single byte.
 */
export function DebugHarness(): null {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("debug") !== "1") return;

    let cancelled = false;
    const sok = (window as unknown as { __sok?: unknown }).__sok ?? {};
    (sok as { renderOffline?: unknown }).renderOffline = "loading";
    (window as unknown as { __sok: unknown }).__sok = sok;

    void (async () => {
      try {
        const mod = await import("@/engine/debug/render-offline");
        if (cancelled) return;
        // The browser cannot return Float32Arrays over the CDP bridge intact at
        // 120 s × 48 kHz × 2 ch (≈ 46 MB), so `renderOffline` accepts
        // `returnAudio: false` and the caller reads `report` only. The WAVs are
        // produced by the in-page `encodeWav` path, which streams base64.
        (sok as { renderOffline: unknown }).renderOffline = async (
          opts: Parameters<typeof mod.renderOffline>[0] & { returnAudio?: boolean },
        ) => {
          const result = await mod.renderOffline(opts);
          const wantsAudio = opts.returnAudio !== false;
          const payload: Record<string, unknown> = { report: result.report };
          if (wantsAudio) {
            const wav = await import("@/engine/audio/wav");
            payload.wav = toBase64(
              wav.encodeWav({
                left: result.left,
                right: result.right,
                sampleRate: result.report.sampleRate,
              }),
            );
          }
          return payload;
        };
        (window as unknown as { __sokReady?: boolean }).__sokReady = true;
      } catch (err) {
        if (cancelled) return;
        (window as unknown as { __sokError?: string }).__sokError = String(err);
        (window as unknown as { __sokReady?: boolean }).__sokReady = true;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}

/**
 * Base64 without blowing the argument limit.
 *
 * `btoa(String.fromCharCode(...bytes))` throws on megabyte inputs — it exceeds
 * the engine's argument count — so the conversion is chunked.
 */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
