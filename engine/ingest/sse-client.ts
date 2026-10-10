/**
 * Resilient EventSource wrapper. Spec §6.6.
 *
 * Runs **inside the worker**. Owns the watchdog, the backoff ladder, and the
 * replay fallback. Every dependency (EventSource factory, timers, clock) is
 * injected so the whole state machine is unit-testable with fake time and no
 * network — which matters, because §13.2 requires tests for the backoff
 * sequence, the 20 s watchdog, and the replay fallback.
 */
import {
  STREAM_BACKOFF_JITTER,
  STREAM_BACKOFF_MS,
  STREAM_FAILURES_BEFORE_REPLAY,
  STREAM_FAIL_WINDOW_MS,
  STREAM_HEALTHY_RESET_MS,
  STREAM_REPLAY_RETRY_MS,
  STREAM_WATCHDOG_MS,
} from "../config";

export type StreamState = "connecting" | "live" | "reconnecting" | "replay" | "error";

export interface SseClientDeps {
  /** Default: `new EventSource(url)`. */
  createEventSource: (url: string) => EventSourceLike;
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (handle: number) => void;
  now: () => number;
}

export interface EventSourceLike {
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  close: () => void;
}

export interface SseClientCallbacks {
  /** Raw `data:` payload; parse errors are the caller's problem. */
  onData: (data: string) => void;
  onStatus: (state: StreamState, detail?: string) => void;
  /**
   * Fired when live delivery has failed enough to warrant the replay
   * fallback (§6.6). The worker switches its source; the client keeps trying
   * to reconnect to live in the background.
   */
  onFallbackToReplay: (detail: string) => void;
}

export class SseClient {
  private es: EventSourceLike | null = null;
  private watchdog = 0;
  private retry = 0;
  private lastMessageAt = 0;
  private failures: number[] = [];
  private inReplay = false;
  private stopped = false;
  private opened = false;

  constructor(
    private readonly url: string,
    private readonly deps: SseClientDeps,
    private readonly cb: SseClientCallbacks,
  ) {}

  get isInReplay(): boolean {
    return this.inReplay;
  }

  get retryCount(): number {
    return this.retry;
  }

  start(): void {
    this.stopped = false;
    this.lastMessageAt = this.deps.now();
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.closeSource();
  }

  private closeSource(): void {
    if (this.es) {
      // §6.6 + LEGACY-NOTES §3.4: EventSource auto-reconnects on error, so a
      // custom backoff loop MUST close it explicitly or you double-connect.
      this.es.close();
      this.es = null;
    }
  }

  private clearTimers(): void {
    if (this.watchdog !== 0) {
      this.deps.clearTimeout(this.watchdog);
      this.watchdog = 0;
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.closeSource();
    this.setStatus("connecting");

    let es: EventSourceLike;
    try {
      es = this.deps.createEventSource(this.url);
    } catch (err) {
      this.onFailure(err instanceof Error ? err.message : "EventSource construction failed");
      return;
    }
    this.es = es;
    this.opened = false;

    es.onopen = () => {
      this.opened = true;
      this.retry = 0;
      this.setStatus("live");
    };

    es.onmessage = (ev) => {
      this.lastMessageAt = this.deps.now();
      this.cb.onData(ev.data);
    };

    es.onerror = () => {
      // `onopen` firing means the connection was healthy at some point; a later
      // error is a mid-stream drop rather than a failure to connect.
      this.onFailure(this.opened ? "connection lost" : "connect failed");
    };

    this.armWatchdog();
  }

  private armWatchdog(): void {
    this.clearTimers();
    this.watchdog = this.deps.setTimeout(() => {
      this.watchdog = 0;
      if (this.stopped) return;
      const idle = this.deps.now() - this.lastMessageAt;
      if (idle >= STREAM_WATCHDOG_MS) {
        this.onFailure(`watchdog: no data for ${Math.round(idle / 1000)}s`);
      } else {
        this.armWatchdog();
      }
    }, STREAM_WATCHDOG_MS);
  }

  /** Backoff delay for attempt `n` (0-based), with ±20 % jitter (§6.6). */
  backoffDelay(attempt: number): number {
    const ladder = STREAM_BACKOFF_MS;
    const base = ladder[Math.min(attempt, ladder.length - 1)]!;
    const j = 1 + (this.deps.now() % 1000) / 1000 - 0.5; // deterministic pseudo-jitter
    return Math.round(base * (1 + j * 2 * STREAM_BACKOFF_JITTER));
  }

  private onFailure(reason: string): void {
    if (this.stopped) return;
    this.closeSource();
    this.clearTimers();

    const now = this.deps.now();
    this.failures.push(now);
    // Only failures inside the window count toward the replay fallback.
    while (this.failures.length > 0 && now - this.failures[0]! > STREAM_FAIL_WINDOW_MS) {
      this.failures.shift();
    }

    // A healthy stretch resets the ladder (§6.6).
    if (now - this.lastMessageAt >= STREAM_HEALTHY_RESET_MS) this.retry = 0;

    if (!this.inReplay && this.failures.length >= STREAM_FAILURES_BEFORE_REPLAY) {
      this.inReplay = true;
      this.cb.onFallbackToReplay("Stream unavailable — replaying a recording");
      // Keep trying to return to live in the background (§6.6).
      this.scheduleRetry();
      return;
    }

    this.setStatus("reconnecting", reason);
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    const delay = this.backoffDelay(this.retry);
    this.retry = Math.min(this.retry + 1, STREAM_BACKOFF_MS.length - 1);
    const inReplay = this.inReplay;
    // While replaying, poll for live recovery at the slower cadence.
    const actual = inReplay ? Math.max(delay, STREAM_REPLAY_RETRY_MS) : delay;
    this.deps.setTimeout(() => {
      if (this.stopped) return;
      if (inReplay && this.inReplay) {
        this.setStatus("replay", "retrying live stream");
      }
      this.connect();
    }, actual);
  }

  private setStatus(state: StreamState, detail?: string): void {
    this.cb.onStatus(state, detail);
  }
}

/** Production dependency wiring: real EventSource, real timers. */
export function defaultSseDeps(): SseClientDeps {
  return {
    createEventSource: (url: string) => new EventSource(url) as unknown as EventSourceLike,
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
    clearTimeout: (h) => globalThis.clearTimeout(h),
    now: () => Date.now(),
  };
}
