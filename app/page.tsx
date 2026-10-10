import { DebugHarness } from "@/components/debug-harness";

export default function Page() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-black text-neutral-400">
      <p className="text-sm tracking-wide">Sound of Knowledge v2</p>
      {/* Debug-only: installs `window.__sok.renderOffline` under `?debug=1`.
          Dynamically imported, so it costs nothing in the production bundle. */}
      <DebugHarness />
    </main>
  );
}
