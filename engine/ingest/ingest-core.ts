/**
 * Ingest orchestration, independent of any worker globals. Spec §5.1, §6.5, §7.7.
 *
 * Owns the real-time loop: pull from the `Source`, normalise is already done
 * (sources emit `NormalizedEdit`), filter, dedupe, **sample**, batch, and emit.
 * Also emits the 25 ms heartbeat that drives the music scheduler — deliberately
 * *not* a main-thread `setInterval`, which browsers throttle to ≥1 Hz in
 * background tabs and would freeze the music when the user switches away
 * (spec §7.7, §8.13).
 *
 * No worker globals here, so the whole thing is unit-testable with a fake clock.
 */
import { DEDUPE_CAPACITY, STATS_INTERVAL_MS, TICK_SEC, STREAM_URL } from "../config";
import { ImportanceSampler } from "./sampler";
import { passes, type FilterConfig } from "./filters";
import { IdDedupeRing } from "../util/ring-buffer";
import { encodeBatch } from "./encode";
import type { NormalizedEdit } from "../types";
import type { IngestConfig, Source, StreamState, WorkerOut } from "./protocol";
import { DEFAULT_INGEST_CONFIG } from "./protocol";

export interface IngestCoreDeps {
  now: () => number;
  setInterval: (fn: () => void, ms: number) => number;
  clearInterval: (h: number) => void;
  emit: (msg: WorkerOut) => void;
}

export interface IngestCounters {
  seen: number;
  accepted: number;
  dropped: number;
  parseErrors: number;
  botAccepted: number;
  revertAccepted: number;
}

export class IngestCore {
  private config: IngestConfig = { ...DEFAULT_INGEST_CONFIG };
  private source: Source | null = null;
  private sampler: ImportanceSampler;
  private dedupe = new IdDedupeRing(DEDUPE_CAPACITY);
  private filters: FilterConfig;

  private batchTimer = 0;
  private statsTimer = 0;
  private tickTimer = 0;

  private lastBatchAt = 0;
  private lastStatsAt = 0;
  private ticks = 0;

  /** Pool reused across batches so steady-state batching does not allocate a
   *  fresh array 20×/s. Cleared (length = 0) rather than reallocated. */
  private acceptedWindow: NormalizedEdit[] = [];

  private readonly counters: IngestCounters = {
    seen: 0,
    accepted: 0,
    dropped: 0,
    parseErrors: 0,
    botAccepted: 0,
    revertAccepted: 0,
  };

  private running = false;

  constructor(
    private readonly deps: IngestCoreDeps,
    private readonly rng: () => number,
  ) {
    this.sampler = new ImportanceSampler(this.config.maxPerSec, this.rng);
    this.filters = {
      source: this.config.source,
      langs: this.config.langs,
      namespaces: this.config.namespaces,
    };
  }

  get countersSnapshot(): Readonly<IngestCounters> {
    return this.counters;
  }

  get tickCount(): number {
    return this.ticks;
  }

  get isRunning(): boolean {
    return this.running;
  }

  setStatus(state: StreamState, detail?: string): void {
    this.deps.emit(detail === undefined ? { t: "status", state } : { t: "status", state, detail });
  }

  /**
   * Swap the event source. Called by the worker when switching between
   * live / replay / synthetic (§6.6, §6.7).
   */
  setSource(source: Source | null): void {
    this.source?.dispose?.();
    this.source = source;
  }

  /** Feed one raw `data:` payload from the SSE client (live path only). */
  feedRawData(
    data: string,
    normalizeFn: (raw: unknown, stats: { parseErrors: number }) => NormalizedEdit | null,
  ): void {
    let obj: unknown;
    try {
      obj = JSON.parse(data);
    } catch {
      this.counters.parseErrors++;
      return;
    }
    this.ingestRaw([obj], normalizeFn);
  }

  start(cfg: Partial<IngestConfig>): void {
    this.applyConfig(cfg);
    if (this.running) return;
    this.running = true;

    const now = this.deps.now();
    this.lastBatchAt = now;
    this.lastStatsAt = now;

    this.batchTimer = this.deps.setInterval(() => this.onBatchTimer(), this.config.batchIntervalMs);
    this.statsTimer = this.deps.setInterval(() => this.emitStats(), STATS_INTERVAL_MS);
    this.tickTimer = this.deps.setInterval(() => this.onTick(), TICK_SEC * 1000);
  }

  stop(): void {
    this.running = false;
    if (this.batchTimer !== 0) this.deps.clearInterval(this.batchTimer);
    if (this.statsTimer !== 0) this.deps.clearInterval(this.statsTimer);
    if (this.tickTimer !== 0) this.deps.clearInterval(this.tickTimer);
    this.batchTimer = 0;
    this.statsTimer = 0;
    this.tickTimer = 0;
    this.source?.dispose?.();
    this.source = null;
  }

  /** §6.5 — partial config update; the ingest worker forwards user settings. */
  applyConfig(patch: Partial<IngestConfig>): void {
    this.config = { ...this.config, ...patch };
    this.filters = {
      source: this.config.source,
      langs: this.config.langs,
      namespaces: this.config.namespaces,
    };
    this.sampler.setMaxPerSec(this.config.maxPerSec);
  }

  getConfig(): Readonly<IngestConfig> {
    return this.config;
  }

  /**
   * The 25 ms heartbeat that drives the scheduler (§7.7).
   *
   * Because this lives in the worker, it keeps firing in a background tab,
   * which is what lets audio and the scheduler continue while the renderer is
   * paused (§8.13).
   */
  private onTick(): void {
    this.ticks++;
    this.deps.emit({ t: "tick" });
  }

  /** Pull from the source, then filter → dedupe → accumulate. */
  pump(dtMs: number): void {
    if (!this.source) return;
    const events = this.source.next(dtMs);
    for (let i = 0; i < events.length; i++) {
      this.counters.seen++;
      this.ingestNormalized(events[i]!);
    }
  }

  /** Live path: parse raw SSE objects, then hand the survivors to the pipeline. */
  private ingestRaw(
    raws: readonly unknown[],
    normalizeFn: (raw: unknown, stats: { parseErrors: number }) => NormalizedEdit | null,
  ): void {
    for (let i = 0; i < raws.length; i++) {
      this.counters.seen++;
      const stats = { parseErrors: this.counters.parseErrors };
      const edit = normalizeFn(raws[i], stats);
      this.counters.parseErrors = stats.parseErrors;
      if (edit) this.ingestNormalized(edit);
    }
  }

  /** Filter + dedupe + accumulate already-normalised edits. */
  private ingestNormalized(edit: NormalizedEdit): void {
    // Dedupe before the filter: a reconnect can redeliver anything (§6.3).
    if (this.dedupe.seenOrAdd(edit.id)) {
      this.counters.dropped++;
      return;
    }
    if (!passes(edit, this.filters)) return;

    this.counters.accepted++;
    if (edit.actor === "bot") this.counters.botAccepted++;
    if (edit.kind === "revert") this.counters.revertAccepted++;
    this.acceptedWindow.push(edit);
  }

  /**
   * The 50 ms batch tick: pull from the source, refill the token bucket for
   * the elapsed time, sample, and emit one transferable batch. §6.4 + §6.5.
   *
   * Pulling happens here rather than on a separate timer so that source
   * progress and bucket refill always agree on elapsed time — otherwise the
   * replay/synthetic sources would drift out of sync with the batch window.
   */
  private onBatchTimer(): void {
    const now = this.deps.now();
    const dtMs = Math.max(0, now - this.lastBatchAt);
    this.lastBatchAt = now;
    if (dtMs > 0) this.pump(dtMs);

    const dtSec = dtMs / 1000;
    this.sampler.refill(dtSec);

    const selected = this.sampler.select(this.acceptedWindow);
    if (selected.length > 0) {
      this.deps.emit(encodeBatch(selected));
    }
    this.acceptedWindow.length = 0; // reuse, never reallocate
  }

  private emitStats(): void {
    const now = this.deps.now();
    this.deps.emit({
      t: "stats",
      seen: this.counters.seen,
      accepted: this.counters.accepted,
      dropped: this.counters.dropped,
      parseErrors: this.counters.parseErrors,
      botAccepted: this.counters.botAccepted,
      revertAccepted: this.counters.revertAccepted,
      windowMs: now - this.lastStatsAt,
    });
    this.lastStatsAt = now;
  }
}

/** Default config for a browser session. */
export function defaultIngestConfig(over: Partial<IngestConfig> = {}): IngestConfig {
  return { ...DEFAULT_INGEST_CONFIG, streamUrl: STREAM_URL, ...over };
}
