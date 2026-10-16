/**
 * §10.2 — the fire table: which edit becomes which visual.
 *
 * ```
 * | flavor      | sparks              | rings     | orb impact             | other                    |
 * | add         | streak, accent      | –         | push, at arrival       | –                        |
 * | remove      | streak, core        | –         | push, at arrival       | –                        |
 * | large       | streak ×1.8, K=36   | –         | strong push            | trauma +0.15; bloom swell|
 * | revert      | –                   | ring      | **dent** immediately   | CA kick, trauma +0.30    |
 * | new         | burst (48)          | –         | –                     | label priority           |
 * | bot-thud    | bot pulse           | –         | small push at arrival  | –                        |
 * | bot-tick    | bot pulse (smaller) | –         | –                     | –                        |
 * ```
 *
 * **Why this is a class and not a function.** §10.2's "at arrival" impacts cannot happen
 * when the note is fired — the spark has not arrived yet. They wait in
 * `pendingImpacts[32]` with an activation time and are flushed each frame, which is
 * state, so the table needs something to hold it.
 *
 * **Why the targets are injected.** §10.2 is the mapping that the harness has been
 * *faking* since T4.2 — sparks and orb impacts have been fired by hand-written
 * synthetic code in `visual-harness.tsx`, which means the table above has never once
 * been exercised. Structural types rather than the concrete classes mean the whole
 * table can be tested against recording fakes, with no WebGL context.
 */
import * as THREE from "three";
import type { NormalizedEdit, NoteEvent, NoteFlavor } from "../types";
import type { ImpactKind } from "./orb";
import type { EventColor } from "./palette";
import { sparkDuration, SPARK_ARRIVAL_FRACTION } from "./sparks";
import { BLOOM_SWELL_LARGE } from "./post";

/** §10.2 — "a small fixed array `pendingImpacts[32]`". */
export const PENDING_IMPACT_SLOTS = 32;

/** §10.2 — a large edit's streak is "×1.8 size". */
export const LARGE_STREAK_SIZE_SCALE = 1.8;
/** §10.2 — trauma figures are the spec's own. */
export const TRAUMA_LARGE = 0.15;
export const TRAUMA_REVERT = 0.3;

/** Magnitudes per impact. `push` is §9.4's response to a strike. */
export const IMPACT_MAGNITUDE = {
  /** add / remove — an ordinary edit. */
  normal: 0.5,
  /** §10.2 — a large edit gets a "strong push". */
  large: 1.0,
  /** §10.2 — bot-thud gets a "small push". */
  small: 0.25,
  /** §10.2 — a revert's "dent". */
  dent: 1.0,
} as const;

/**
 * §10.2's `accent` / `core` streak variants.
 *
 * **A gap in the spec, recorded rather than invented.** §9.5 defines exactly three
 * spark kinds (`streak`, `botPulse`, `burst`) and gives `aStyle` a `size`, a `jIndex01`
 * and a `brightness` — none of which is a two-valued `accent`/`core` switch. The names
 * appear only in §10.2's table. Both are therefore fired as `streak` and differ by
 * brightness, which is the only per-streak style axis §9.5 defines that the two words
 * plausibly mean. If the variants are ever specified, this is the one line to change.
 */
export const STREAK_STYLE_BRIGHTNESS = { accent: 1.0, core: 1.35 } as const;
export type StreakStyle = keyof typeof STREAK_STYLE_BRIGHTNESS;

// --- injectable targets --------------------------------------------------------

export interface FireSparks {
  spawnStreak(
    origin: THREE.Vector3,
    dirToCore: THREE.Vector3,
    color: THREE.Color,
    magnitude: number,
    opts?: { sizeScale?: number; brightnessScale?: number },
  ): number;
  spawnBurst(origin: THREE.Vector3, color: THREE.Color, magnitude: number): number;
  spawnBotPulse(
    origin: THREE.Vector3,
    dirToCore: THREE.Vector3,
    color: THREE.Color,
    magnitude: number,
  ): number;
}

export interface FireRings {
  spawn(origin: THREE.Vector3, color: THREE.Color, startTime: number): number;
}

export interface FireOrb {
  addImpact(
    dir: THREE.Vector3,
    magnitude: number,
    kind: ImpactKind,
    startTime: number,
  ): void;
}

/** Optional — a headless caller (the offline renderer, tests) may omit these. */
export interface FireExtras {
  post?: {
    kickChromaticAberration(amount?: number): void;
    swellBloom(amount: number): void;
  };
  addTrauma?(amount: number): void;
  labels?: {
    spawn(edit: NormalizedEdit, shellOrigin: THREE.Vector3, now: number): boolean;
    maybeEmitNotable(edit: NormalizedEdit, now: number): boolean;
  };
}

export interface FireTargets extends FireExtras {
  sparks: FireSparks;
  rings: FireRings;
  orb: FireOrb;
  colorFor(kind: EventColor, magnitude: number): THREE.Color;
}

interface PendingImpact {
  active: boolean;
  at: number;
  dir: THREE.Vector3;
  magnitude: number;
  kind: ImpactKind;
}

export class VisualDirector {
  private readonly pending: PendingImpact[] = [];
  /** The pooled colours, so a fire allocates no garbage per note. */
  private readonly dirToCore = new THREE.Vector3();

  constructor(private readonly targets: FireTargets) {
    for (let i = 0; i < PENDING_IMPACT_SLOTS; i++) {
      this.pending.push({
        active: false,
        at: 0,
        dir: new THREE.Vector3(),
        magnitude: 0,
        kind: "push",
      });
    }
  }

  /** Impacts waiting for their activation time. §5.5's `visualQueueLen` cousin. */
  get pendingImpacts(): number {
    let n = 0;
    for (const p of this.pending) if (p.active) n++;
    return n;
  }

  /**
   * §10.2 — fire one note's visuals.
   *
   * `now` is the render clock (seconds since `t0`), matching the `uTime` the particle
   * shaders evaluate against. `shellOrigin` is where the edit sits in the world.
   */
  fire(note: NoteEvent, shellOrigin: THREE.Vector3, now: number): void {
    const { edit, flavor } = note;
    // The burst is radial and has no direction; the streaks all point at the core.
    this.dirToCore.copy(shellOrigin).normalize().multiplyScalar(-1);
    const mag = edit.magnitude;

    switch (flavor) {
      case "add":
        this.streak(note, shellOrigin, "addition", "accent", mag, 1);
        this.deferImpact(this.dirToCore, IMPACT_MAGNITUDE.normal, "push", now, mag);
        break;

      case "remove":
        this.streak(note, shellOrigin, "removal", "core", mag, 1);
        this.deferImpact(this.dirToCore, IMPACT_MAGNITUDE.normal, "push", now, mag);
        break;

      case "large":
        this.streak(note, shellOrigin, "large", "accent", mag, LARGE_STREAK_SIZE_SCALE);
        this.deferImpact(this.dirToCore, IMPACT_MAGNITUDE.large, "push", now, mag);
        this.targets.addTrauma?.(TRAUMA_LARGE);
        this.targets.post?.swellBloom(BLOOM_SWELL_LARGE);
        break;

      case "revert":
        // No spark: the ring and the dent *are* the visual.
        this.targets.rings.spawn(
          shellOrigin,
          this.targets.colorFor("revert", mag),
          now,
        );
        // "immediately" — the only flavor whose impact is not deferred.
        this.targets.orb.addImpact(
          this.dirToCore,
          IMPACT_MAGNITUDE.dent,
          "dent",
          now,
        );
        this.targets.post?.kickChromaticAberration();
        this.targets.addTrauma?.(TRAUMA_REVERT);
        break;

      case "new":
        // §10.2 — "burst (48) at origin", on the *first* note only. `NoteEvent.visual`
        // is false for the trailing arpeggio notes of a birth, which is exactly that
        // flag, so a birth fires one burst rather than one per arpeggio step.
        if (!note.visual) break;
        this.targets.sparks.spawnBurst(
          shellOrigin,
          this.targets.colorFor("burst", mag),
          mag,
        );
        break;

      case "bot-thud":
        this.targets.sparks.spawnBotPulse(
          shellOrigin,
          this.dirToCore,
          this.targets.colorFor("bot", mag),
          mag,
        );
        this.deferImpact(this.dirToCore, IMPACT_MAGNITUDE.small, "push", now, mag);
        break;

      case "bot-tick":
        this.targets.sparks.spawnBotPulse(
          shellOrigin,
          this.dirToCore,
          this.targets.colorFor("bot", mag),
          // §10.2 — "(smaller, dimmer)". One particle is already the minimum count, so
          // "smaller" has to mean the particle's size, which rides on `magnitude`.
          mag * 0.5,
        );
        break;
    }

    // §9.9 — labels and the ticker are driven by every note, not by flavor. They carry
    // their own thresholds (§9.9), so the director forwards rather than re-decides.
    this.targets.labels?.spawn(edit, shellOrigin, now);
    this.targets.labels?.maybeEmitNotable(edit, now);
  }

  /** The common `streak` column of §10.2. */
  private streak(
    note: NoteEvent,
    shellOrigin: THREE.Vector3,
    colour: EventColor,
    style: StreakStyle,
    magnitude: number,
    sizeScale: number,
  ): void {
    void note;
    this.targets.sparks.spawnStreak(
      shellOrigin,
      this.dirToCore,
      this.targets.colorFor(colour, magnitude),
      magnitude,
      { sizeScale, brightnessScale: STREAK_STYLE_BRIGHTNESS[style] },
    );
  }

  /**
   * §10.2 — "push, at arrival time (`now + duration*0.85`)".
   *
   * The arrival is derived from §9.5's duration through `sparkDuration`, so the impact
   * and the particle it belongs to cannot drift apart.
   */
  private deferImpact(
    dir: THREE.Vector3,
    magnitude: number,
    kind: ImpactKind,
    now: number,
    editMagnitude: number,
  ): void {
    const slot = this.pending.find((p) => !p.active);
    // Full means every slot is holding an impact that has not yet arrived. The oldest
    // is dropped for the new one: a queued impact whose moment has passed is less
    // interesting than one that has just been earned.
    const target = slot ?? this.pending.reduce((a, b) => (a.at <= b.at ? a : b));
    target.active = true;
    target.at = now + sparkDuration(editMagnitude) * SPARK_ARRIVAL_FRACTION;
    target.dir.copy(dir);
    target.magnitude = magnitude;
    target.kind = kind;
  }

  /**
   * Activate every impact whose arrival time has come. Call once per frame.
   *
   * Impacts whose time has passed by more than a frame are still fired rather than
   * skipped: they are already committed, and dropping them would make the orb react to
   * some edits and silently not to others with no way to tell which.
   */
  flush(now: number): number {
    let fired = 0;
    for (const p of this.pending) {
      if (!p.active || p.at > now) continue;
      p.active = false;
      this.targets.orb.addImpact(p.dir, p.magnitude, p.kind, now);
      fired++;
    }
    return fired;
  }

  /** §13.2 — a hidden tab keeps scheduling, so the queue is dropped on return. */
  clear(): void {
    for (const p of this.pending) p.active = false;
  }
}

/** Every flavor §10.2 names, for exhaustiveness checks. */
export const FIRE_FLAVORS: readonly NoteFlavor[] = [
  "add",
  "remove",
  "large",
  "revert",
  "new",
  "bot-thud",
  "bot-tick",
];