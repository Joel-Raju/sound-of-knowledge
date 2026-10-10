/**
 * Typed event emitter. Spec §5.3 (`engine/bus.ts` — "tiny typed event
 * emitter, no allocation on emit for ≤ 4 listeners").
 *
 * Used for the Engine public event surface (`status`, `stats`, `notable`,
 * `error`) and for internal decoupled wiring (harmony → pad, harmony → palette).
 *
 * Design notes:
 *  - `emit` calls listeners directly. No array copy, no iterator allocation.
 *  - Listeners added/removed during an emit are handled: we iterate by index
 *    over a snapshot-free array and re-check membership is *not* done, so the
 *    documented contract is "do not add or remove listeners inside a handler".
 *    That is the React-idiomatic contract and keeps emit allocation-free.
 *  - Listener counts are small (spec caps the interesting cases at 4), so a
 *    linear array is faster than a Map and allocates nothing.
 */

export type Listener<T> = (payload: T) => void;

/** Unsubscribe handle returned by `on`. */
export type Unsubscribe = () => void;

export class TypedEventBus<Events extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof Events, Array<Listener<never>>>();

  /** Subscribe. Returns an idempotent unsubscribe function. */
  on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): Unsubscribe {
    let arr = this.listeners.get(event);
    if (!arr) {
      arr = [];
      this.listeners.set(event, arr);
    }
    const list = arr as unknown as Array<Listener<Events[K]>>;
    list.push(fn);

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const current = this.listeners.get(event);
      if (!current) return;
      const idx = current.indexOf(fn as unknown as Listener<never>);
      if (idx >= 0) current.splice(idx, 1);
      if (current.length === 0) this.listeners.delete(event);
    };
  }

  /** Subscribe for exactly one emission. */
  once<K extends keyof Events>(event: K, fn: Listener<Events[K]>): Unsubscribe {
    const off = this.on(event, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  /** Fire. Allocation-free; index-based iteration. */
  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const arr = this.listeners.get(event);
    if (!arr || arr.length === 0) return;
    for (let i = 0; i < arr.length; i++) {
      const fn = arr[i];
      if (fn !== undefined) (fn as unknown as Listener<Events[K]>)(payload);
    }
  }

  listenerCount<K extends keyof Events>(event: K): number {
    return this.listeners.get(event)?.length ?? 0;
  }

  /** Remove every listener, for one event or all. */
  clear(event?: keyof Events): void {
    if (event === undefined) this.listeners.clear();
    else this.listeners.delete(event);
  }
}

/** §5.5 engine event payloads. */
export interface EngineEvents {
  status: {
    stream: "connecting" | "live" | "reconnecting" | "replay" | "error";
    detail?: string;
  };
  stats: {
    eps: number;
    accepted: number;
    dropped: number;
    botRatio: number;
    revertRatio: number;
    energy: number;
    mode: import("./types").ModeId;
    keyName: string;
    fps: number;
    tier: import("./types").Tier;
  };
  notable: { edit: import("./types").NormalizedEdit };
  error: {
    code: "webgl" | "audio" | "worklet" | "stream" | "unknown";
    message: string;
  };
}
