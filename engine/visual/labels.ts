/**
 * §9.9 — the DOM label pool and the ticker feed.
 *
 * **Two halves, deliberately split.** The gating and URL construction are exported as
 * free functions so §13.2's two requirements — "label spawn throttling logic (pure)"
 * and "URL/href construction" — can be tested without a DOM. `LabelLayer` is the thin
 * shell around them that owns six `<a>` elements and projects them each frame. The
 * engine's test environment is Node with no DOM, and a pool that cannot be tested
 * without one is a pool that will not be.
 *
 * **`textContent` only, never `innerHTML`.** Titles are attacker-controlled strings
 * that arrive over SSE from a live public API. `innerHTML` here would be a stored-XSS
 * sink reachable from the network. There is no sanitisation library here and no need
 * for one: assigning text cannot introduce markup.
 */
import * as THREE from "three";
import type { NormalizedEdit } from "../types";

/** §9.9 — six anchors, pre-created and recycled. */
export const LABEL_POOL_SIZE = 6;
/** §9.9 — `importance ≥ 0.55`. */
export const LABEL_MIN_IMPORTANCE = 0.55;
/** §9.9 — at most one per 1.2 s. */
export const LABEL_MIN_INTERVAL_SEC = 1.2;
/** §9.9 — total lifetime 3.2 s. */
export const LABEL_LIFETIME_SEC = 3.2;
/** §9.9 — fade-in 0.3 s. */
export const LABEL_FADE_IN_SEC = 0.3;
/** §9.9 — fade-out 0.9 s. */
export const LABEL_FADE_OUT_SEC = 0.9;
/** §9.9 — the anchor floats above the edit's shell origin. */
export const LABEL_Y_OFFSET = 0.25;

/** §9.9 — `importance ≥ 0.6` for the ticker. */
export const TICKER_MIN_IMPORTANCE = 0.6;
/** §9.9 — at most once per 2.5 s. */
export const TICKER_MIN_INTERVAL_SEC = 2.5;

// --- pure logic ----------------------------------------------------------------

export interface LabelGateInput {
  importance: number;
  ns: number;
  showTitles: boolean;
  /** render-clock seconds of the last spawn, or -Infinity if none yet */
  lastSpawnAt: number;
  /** anchors currently alive */
  activeCount: number;
  /** render-clock seconds now */
  now: number;
}

/**
 * §9.9's spawn rule. Every clause is a separate early return so a rejection says
 * *which* rule refused, which is the difference between a tunable and a black box.
 */
export function shouldSpawnLabel(g: LabelGateInput): { ok: true } | { ok: false; why: string } {
  if (!g.showTitles) return { ok: false, why: "showTitles off" };
  if (g.ns !== 0) return { ok: false, why: `ns ${g.ns} is not article` };
  if (g.importance < LABEL_MIN_IMPORTANCE) {
    return { ok: false, why: `importance ${g.importance.toFixed(3)} < ${LABEL_MIN_IMPORTANCE}` };
  }
  if (g.activeCount >= LABEL_POOL_SIZE) return { ok: false, why: "pool full" };
  const since = g.now - g.lastSpawnAt;
  if (since < LABEL_MIN_INTERVAL_SEC) return { ok: false, why: `only ${since.toFixed(2)}s since last` };
  return { ok: true };
}

/**
 * §9.9 — `https://${host}/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`.
 *
 * The space→underscore happens **before** `encodeURIComponent`, as the spec writes it.
 * That ordering is what makes the rest safe: by the time the encoder runs there are no
 * spaces left, and everything that could otherwise terminate the path — `?`, `#`, `/`
 * — becomes `%3F`, `%23`, `%2F`. Reversing the two would let an edit titled
 * `Foo?action=delete` address a different URL entirely.
 */
export function buildArticleHref(host: string, title: string): string {
  return `https://${host}/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

/** §9.9 — `LANG  Title`. Text only; see the module comment on `textContent`. */
export function labelText(edit: NormalizedEdit): string {
  return `${edit.lang}  ${edit.title}`;
}

export interface TickerGateInput {
  importance: number;
  actor: NormalizedEdit["actor"];
  lastEmitAt: number;
  now: number;
}

/**
 * §9.9 — `notable` events at most once per 2.5 s for `importance ≥ 0.6`, not bots.
 *
 * Bot edits are excluded because the ticker is the one place a human reads prose about
 * what is happening; a stream of "User:1234 edited…" is noise, and bots are the
 * bulk of the traffic.
 */
export function shouldEmitTicker(t: TickerGateInput): boolean {
  if (t.actor === "bot") return false;
  if (t.importance < TICKER_MIN_IMPORTANCE) return false;
  return t.now - t.lastEmitAt >= TICKER_MIN_INTERVAL_SEC;
}

/**
 * §9.9's opacity envelope over a 3.2 s lifetime: 0.3 s up, hold, 0.9 s down.
 *
 * 3.2 − 0.3 − 0.9 = 2.0 s of hold. Exported because the arithmetic is worth pinning:
 * these three numbers only add up to the lifetime if they were read off the same line
 * of the spec.
 */
export function labelOpacity(ageSec: number): number {
  if (ageSec < 0 || ageSec >= LABEL_LIFETIME_SEC) return 0;
  if (ageSec < LABEL_FADE_IN_SEC) return ageSec / LABEL_FADE_IN_SEC;
  const fadeOutStart = LABEL_LIFETIME_SEC - LABEL_FADE_OUT_SEC;
  if (ageSec >= fadeOutStart) return (LABEL_LIFETIME_SEC - ageSec) / LABEL_FADE_OUT_SEC;
  return 1;
}

// --- the DOM layer -------------------------------------------------------------

export interface NotableEvent {
  edit: NormalizedEdit;
  href: string;
  text: string;
}

interface Slot {
  el: HTMLAnchorElement;
  worldPos: THREE.Vector3;
  bornAt: number;
  live: boolean;
}

/**
 * §9.9's label pool.
 *
 * The layer is `pointer-events:none` so it never eats a drag on the canvas, while each
 * anchor is `pointer-events:auto` so it stays clickable — the one-line detail that
 * makes "clickable to open the article" (§1, bullet 7) true without stealing input
 * anywhere else.
 */
export class LabelLayer {
  private readonly slots: Slot[] = [];
  private lastSpawnAt = -Infinity;
  private lastTickerAt = -Infinity;
  private readonly onNotable: ((e: NotableEvent) => void) | undefined;
  private readonly tmp = new THREE.Vector3();
  /** §11.3 — `settings.showTitles`. Defaults true; the settings panel drives this. */
  private showTitles = true;

  constructor(
    private readonly doc: Document,
    /** §9.9 — the ticker feed, consumed by the HUD (§11.4). */
    onNotable?: (e: NotableEvent) => void,
  ) {
    this.onNotable = onNotable;
    const layer = doc.createElement("div");
    layer.className = "sok-labels";
    layer.setAttribute("pointer-events", "none");
    layer.setAttribute("aria-hidden", "false");
    for (let i = 0; i < LABEL_POOL_SIZE; i++) {
      const el = doc.createElement("a");
      el.style.position = "absolute";
      el.style.left = "0";
      el.style.top = "0";
      el.style.opacity = "0";
      el.style.pointerEvents = "auto";
      el.style.display = "none";
      el.target = "_blank";
      el.rel = "noopener noreferrer";
      el.tabIndex = -1;
      el.className = "sok-label";
      layer.appendChild(el);
      this.slots.push({
        el,
        worldPos: new THREE.Vector3(),
        bornAt: 0,
        live: false,
      });
    }
    this.layer = layer;
  }

  readonly layer: HTMLDivElement;

  /** §11.3 — reflect the user's setting without tearing down the pool. */
  setShowTitles(on: boolean): void {
    this.showTitles = on;
    if (on) return;
    // Turning titles off should take existing labels down, not just refuse new ones —
    // otherwise the setting appears not to work until the next 3.2 s expires.
    for (const slot of this.slots) {
      if (!slot.live) continue;
      slot.live = false;
      slot.el.style.display = "none";
      slot.el.style.opacity = "0";
    }
  }

  /** Anchors currently alive. §9.9's `≤ 6 active` gate reads this. */
  get activeCount(): number {
    let n = 0;
    for (const slot of this.slots) if (slot.live) n++;
    return n;
  }

  /**
   * §9.9 — consider an edit for a label. Returns whether one was spawned.
   *
   * `shellOrigin` is where the edit already sits in the world; the anchor is placed
   * `(0, 0.25, 0)` above it so the text clears the edit's own spark.
   */
  spawn(edit: NormalizedEdit, shellOrigin: THREE.Vector3, now: number): boolean {
    const gate = shouldSpawnLabel({
      importance: edit.importance,
      ns: edit.ns,
      showTitles: this.showTitles,
      lastSpawnAt: this.lastSpawnAt,
      activeCount: this.activeCount,
      now,
    });
    if (!gate.ok) return false;

    const slot = this.slots.find((s) => !s.live);
    // Unreachable while `activeCount < LABEL_POOL_SIZE`, which the gate just checked.
    // Kept rather than asserted non-null so a future rule change fails visible instead
    // of throwing inside a render frame.
    if (!slot) return false;

    const text = labelText(edit);
    slot.el.textContent = text;
    slot.el.href = buildArticleHref(edit.host, edit.title);
    slot.worldPos.copy(shellOrigin);
    slot.worldPos.y += LABEL_Y_OFFSET;
    slot.bornAt = now;
    slot.live = true;
    slot.el.style.display = "block";
    slot.el.style.opacity = "0";
    this.lastSpawnAt = now;
    return true;
  }

  /**
   * §9.9 — project each live anchor and write its transform.
   *
   * Hiding is per-anchor and does not end the label's life: an anchor that swings
   * behind the core should come back when it swings out again, still counting against
   * the `≤ 6` pool for the remainder of its 3.2 s.
   */
  update(now: number, camera: THREE.Camera, width: number, height: number): void {
    for (const slot of this.slots) {
      if (!slot.live) continue;
      const age = now - slot.bornAt;
      if (age >= LABEL_LIFETIME_SEC) {
        slot.live = false;
        slot.el.style.display = "none";
        slot.el.style.opacity = "0";
        continue;
      }
      this.tmp.copy(slot.worldPos).project(camera);
      const out =
        this.tmp.z > 1 || Math.abs(this.tmp.x) > 1.1 || Math.abs(this.tmp.y) > 1.1;
      if (out) {
        slot.el.style.display = "none";
        continue;
      }
      const px = ((this.tmp.x + 1) / 2) * width;
      const py = ((1 - this.tmp.y) / 2) * height;
      slot.el.style.display = "block";
      slot.el.style.transform = `translate3d(${px.toFixed(1)}px, ${py.toFixed(1)}px, 0)`;
      slot.el.style.opacity = labelOpacity(age).toFixed(3);
    }
  }

  /**
   * §9.9's ticker feed — `notable` events, throttled.
   *
   * Separate from `spawn` on purpose: a label is anchored to a place in space and a
   * ticker is a line of prose, and §9.9 gives them different thresholds (0.55 / 0.6),
   * different intervals (1.2 s / 2.5 s) and different exclusions (the label excludes
   * non-article namespaces, the ticker excludes bots).
   */
  maybeEmitNotable(edit: NormalizedEdit, now: number): boolean {
    if (!shouldEmitTicker({
      importance: edit.importance,
      actor: edit.actor,
      lastEmitAt: this.lastTickerAt,
      now,
    })) {
      return false;
    }
    this.lastTickerAt = now;
    this.onNotable?.({
      edit,
      text: labelText(edit),
      href: buildArticleHref(edit.host, edit.title),
    });
    return true;
  }

  dispose(): void {
    this.layer.remove();
  }
}