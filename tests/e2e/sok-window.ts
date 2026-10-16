/**
 * The `window.__sok` debug handle, declared **once** for the whole e2e suite.
 *
 * Two spec files each used to declare `Window.__sok` with the subset they needed, and
 * `tsc` rejected it: interface merging requires duplicate members to have identical
 * types, so the second declaration silently changed the first's meaning and the
 * typecheck failed with errors pointing at property accesses that were perfectly valid
 * in the file that owned them.
 *
 * One declaration, in one place, covering everything the suite touches. Adding a
 * capability to the debug handle now means adding it here — which is the point: a
 * handle that only one spec knows about is a handle nothing else can rely on.
 */

export interface SokStats {
  fps: number;
  emaMs: number;
  p95Ms: number;
  tier: string;
  level: number;
  scale: number;
  drawCalls: number;
  triangles: number;
  /** Real GPU frame cost from the last synchronised sample (see DECISIONS.md). */
  syncedMs: number;
}

export interface SokNotable {
  text: string;
  href: string;
}

export interface SokVisual {
  engine: unknown;
  status: string;
  message?: string;
  stats(): SokStats | null;
  /** §9.3 — the harness's harmony override, used by the palette-ease test. */
  engineWithHarmony?: { setHarmony(mode: string, rootPc: number): void };

  // --- T4.1–T4.4: spawn helpers -------------------------------------------
  debugSpawn(n?: number): void;
  addImpacts(n?: number, magnitude?: number, kind?: "push" | "dent"): void;
  poolCounts(): { sparks: number; rings: number };

  // --- T4.5: §10.2's fire table and §9.9's labels -------------------------
  debugFire(flavor: string): void;
  labelCounts(): { active: number; notable: number };
  lastNotable(): SokNotable | null;

  // --- layer handles the specs assert against -----------------------------
  sparks: { spawned: number } | null;
  rings: { spawned: number } | null;
  orb: { impactCount: number } | null;
  dust: { drawn: number } | null;
  post: { bloomIntensity: number } | null;
}

declare global {
  interface Window {
    __sokVisualReady?: boolean;
    __sok?: { visual?: SokVisual };
  }
}

export {};