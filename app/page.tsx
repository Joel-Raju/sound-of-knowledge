import { Experience } from "@/components/experience";
import { VisualHarness } from "@/components/visual-harness";
import { DebugHarness } from "@/components/debug-harness";

/**
 * T5.1 — the page decides `?debug=1`, on the **server**.
 *
 * Both `Experience` and `VisualHarness` need to know. Reading
 * `window.location.search` during render looks simpler but is a hydration mismatch:
 * the server renders the non-debug branch and the client's first render produces the
 * debug one, which React reports as error #418 and which React resolves by throwing
 * away the server's markup. On a page that mounts a WebGL context that is not a
 * cosmetic problem.
 *
 * `searchParams` is a promise in Next 16, so this is an async server component.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const debug = params.debug === "1";
  // Passed down as a raw string so the client resolves §11.3's overrides without
  // touching `window` during render — which would be a hydration mismatch.
  const rawSearch = new URLSearchParams(
    Object.entries(params).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])),
  ).toString();

  return (
    <main className="min-h-dvh bg-black text-neutral-400">
      {/* The live piece. Renders nothing under `?debug=1`, so the debug page gets
          exactly one WebGL context from the T4 harness and never two. */}
      <Experience debug={debug} search={rawSearch} />

      {/* Debug-only visual harness: the orb, sparks, rings and dust with a
          deterministic spawn pattern, for `scripts/shot.ts` and the e2e suite.
          three.js is dynamically imported inside, so it costs a production visitor
          nothing (§12.4). */}
      {debug && <VisualHarness />}

      <p className="pointer-events-none fixed left-3 top-3 z-10 text-sm tracking-wide">
        Sound of Knowledge v2
      </p>

      {/* Debug-only: installs `window.__sok.renderOffline` under `?debug=1`.
          Dynamically imported, so it costs nothing in the production bundle. */}
      <DebugHarness />
    </main>
  );
}