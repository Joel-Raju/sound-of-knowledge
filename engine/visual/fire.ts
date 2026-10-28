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

/**
 * §10.2 — the minimum interval between comets, in seconds.
 *
 * Measured: the live stream (production build) carries 3.03 notes/s, so a comet per
 * note is one every 330 ms. The human's verdicts, in order: *"the frequency of the
 * comets is too large and it removes the visual enjoyment"* — then, after 2.0 s brought
 * the rate to ~1.0/s — *"reduce it again by half"*.
 *
 * The constant stayed 2.0 s while the **exempt set** shrank: `large` and the bot
 * flavours now share this window with `add`/`remove`, so the total is capped at one
 * comet per window (~0.5/s) plus the exempt ~0.06/s. Only `revert` and `new` — the
 * two rarest, most distinct §10.2 visuals — stay unthrottled.
 */
export const DEFAULT_COMET_INTERVAL_SEC = 2.0;

export class VisualDirector {
  private readonly pending: PendingImpact[] = [];
  /** The pooled colours, so a fire allocates no garbage per note. */
  private readonly dirToCore = new THREE.Vector3();

  /**
   * §10.2 — the minimum interval between comets, in seconds.
   *
   * **Why this exists.** With the energy finally alive, the note rate follows the
   * traffic: measured at 3.03 notes/s on the live stream (production build). With a
   * comet per note, that is a comet every 330 ms — and the human's verdict was blunt:
   * *"the frequency of the comets is too large and it removes the visual enjoyment."*
   *
   * It was invisible until the comets started rendering at all (the `addUpdateRange`
   * fix), which is the usual pattern here: a feature that was broken was also,
   * separately, wrong, and the second problem only became audible once the first was
   * fixed.
   *
   * **Everything except `revert` and `new` shares this window**, `large` and the bot
   * pulses included — at 0.57/s the `large` flavour alone is bigger than the target
   * rate, so no interval could halve the total while it stayed exempt. The throttle is
   * the difference between a piece that reads and a firehose.
   */
  private cometIntervalSec: number;
  /** The render clock of the last routine comet. */
  private lastRoutineCometAt = -Infinity;
  /** Comets actually fired, and routine notes throttled away. */
  private cometsFired = 0;
  private throttled = 0;
  /** How many notes of each §10.2 flavour have been fired. */
  private readonly flavors: Partial<Record<NoteFlavor, number>> = {};

  constructor(
    private readonly targets: FireTargets,
    cometIntervalSec = DEFAULT_COMET_INTERVAL_SEC,
  ) {
    this.cometIntervalSec = cometIntervalSec;
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

  /** §10.2 — the interval between routine comets. See `cometIntervalSec`. */
  setCometInterval(sec: number): void {
    if (Number.isFinite(sec) && sec >= 0) this.cometIntervalSec = sec;
  }

  /**
   * How many comets have actually been fired, and how many routine notes were
   * throttled away.
   *
   * The throttle is the one thing in the visual chain that *removes* events, so it needs
   * to be countable — otherwise "the comets feel right" is not a claim that can be
   * checked.
   */
  get visualCounts(): { comets: number; throttled: number } {
    return { comets: this.cometsFired, throttled: this.throttled };
  }

  /** How many notes of each §10.2 flavour have been fired. */
  get flavorCounts(): Record<string, number> {
    return { ...this.flavors };
  }

  /**
   * §10.2 — may this note have a comet?
   *
   * **This is a selection step, not a change to §10.2.** The fire table still says
   * exactly what a note does when it has a comet; this decides *which notes get to be
   * one*. Keeping the two apart is what lets §10.2's unit tests stay a test of §10.2.
   *
   * **Everything except `revert` and `new` shares one window.** The measured mix
   * (production build, 30 s of the live stream) is `add` 1.20/s, `remove` 0.93/s,
   * `large` 0.57/s, `bot-thud` 0.27/s at 3.03 notes/s — so with `large` unthrottled
   * the punctuation floor alone was ~0.6 comets/s, and no interval setting could take
   * the total below it. Halving the rate again (the human, after seeing ~1.0/s:
   * *"reduce it again by half"*) therefore means the throttle has to reach `large` too.
   *
   * `revert` and `new` stay exempt. At a combined 0.06/s they cost nothing, and
   * §10.2 gives them the piece's two most distinct visuals — a shockwave ring with a
   * chromatic-aberration kick, and a radial burst — which a throttle that might eat
   * them would risk silencing for minutes at a time. `large` keeps its trauma shake
   * and bloom swell whenever it *does* win the window; the cost is that most large
   * edits are sound only.
   */
  shouldHaveComet(note: NoteEvent, now: number): boolean {
    const flavor = note.flavor;
    this.flavors[flavor] = (this.flavors[flavor] ?? 0) + 1;
    if (flavor === "revert" || flavor === "new") {
      this.cometsFired++;
      return true;
    }
    if (now - this.lastRoutineCometAt < this.cometIntervalSec) {
      this.throttled++;
      return false;
    }
    this.lastRoutineCometAt = now;
    this.cometsFired++;
    return true;
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
  fire(note: NoteEvent, shellOrigin: THREE.Vector3, now: number, comet = true): void {
    const { edit, flavor } = note;
    // The burst is radial and has no direction; the streaks all point at the core.
    this.dirToCore.copy(shellOrigin).normalize().multiplyScalar(-1);
    const mag = edit.magnitude;

    // A throttled note has **no comet** — no streak, no ring, no orb impact. It is not a
    // degraded comet; it is simply not a visual event. §9.9's labels and the ticker
    // still run, because they have their own gates and their own cadence.
    if (!comet) {
      this.targets.labels?.spawn(edit, shellOrigin, now);
      this.targets.labels?.maybeEmitNotable(edit, now);
      return;
    }

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