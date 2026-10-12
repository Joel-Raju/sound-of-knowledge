import { VisualHarness } from "@/components/visual-harness";
import { DebugHarness } from "@/components/debug-harness";

export default function Page() {
  return (
    <main className="min-h-dvh bg-black text-neutral-400">
      {/* Full-viewport WebGL canvas, driven by the palette's `deep` clear colour
          (§9.1). The engine is only constructed under `?debug=1`; otherwise the
          canvas is an empty black box and costs one element. */}
      <VisualHarness />
      <p className="pointer-events-none fixed left-3 top-3 z-10 text-sm tracking-wide">
        Sound of Knowledge v2
      </p>
      {/* Debug-only: installs `window.__sok.renderOffline` under `?debug=1`.
          Dynamically imported, so it costs nothing in the production bundle. */}
      <DebugHarness />
    </main>
  );
}
