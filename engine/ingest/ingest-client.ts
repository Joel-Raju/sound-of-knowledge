/**
 * Main-thread wrapper around the ingest worker. Spec §6.8.
 *
 * Owns the `Worker` lifecycle, forwards config, decodes batches, and re-emits
 * them as typed callbacks. Also handles §14.1 worker-crash recovery: restart
 * once with the current config, then surface a `stream` error.
 */
import { decodeBatch, type BatchMsg } from "./encode";
import type { IngestConfig, StreamState, WorkerOut } from "./protocol";
import type { NormalizedEdit } from "../types";

export interface IngestStats {
  seen: number;
  accepted: number;
  dropped: number;
  parseErrors: number;
  botAccepted: number;
  revertAccepted: number;
  windowMs: number;
}

export interface IngestClientHandlers {
  onBatch: (edits: NormalizedEdit[]) => void;
  onStats: (stats: IngestStats) => void;
  onStatus: (state: StreamState, detail?: string) => void;
  onTick: () => void;
  onError: (message: string) => void;
}

export interface IngestClientOptions {
  url?: string;
  config: IngestConfig;
  handlers: IngestClientHandlers;
}

export class IngestClient {
  private worker: Worker | null = null;
  private cfg: IngestConfig;
  private readonly handlers: IngestClientHandlers;
  private readonly url: string;
  private restarted = false;
  private disposed = false;

  constructor(opts: IngestClientOptions) {
    this.cfg = opts.config;
    this.handlers = opts.handlers;
    this.url = opts.url ?? "/engine/ingest.worker.js";
  }

  start(): void {
    this.spawn();
  }

  private spawn(): void {
    if (this.disposed) return;
    try {
      const w = new Worker(this.url);
      this.worker = w;
      w.onmessage = (ev: MessageEvent) => this.handle(ev.data as WorkerOut);
      w.onerror = (ev: ErrorEvent) => this.onWorkerError(ev.message || "worker error");
      w.postMessage({ t: "start", cfg: this.cfg });
    } catch (err) {
      this.handlers.onError(
        `Could not start ingest worker at ${this.url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** §14.1 — restart once on crash; a second failure becomes a stream error. */
  private onWorkerError(message: string): void {
    this.worker?.terminate();
    this.worker = null;
    if (this.disposed) return;
    if (!this.restarted) {
      this.restarted = true;
      this.handlers.onStatus("reconnecting", "ingest worker restarted");
      this.spawn();
      return;
    }
    this.handlers.onStatus("error", "ingest worker failed twice");
    this.handlers.onError(message);
  }

  private handle(msg: WorkerOut): void {
    switch (msg.t) {
      case "batch": {
        const batch = msg as BatchMsg;
        this.handlers.onBatch(decodeBatch(batch));
        break;
      }
      case "stats":
        this.handlers.onStats(msg);
        break;
      case "status":
        this.handlers.onStatus(msg.state, msg.detail);
        break;
      case "tick":
        this.handlers.onTick();
        break;
    }
  }

  /** Forward a settings change to the worker (spec §6.5 `config` message). */
  setConfig(patch: Partial<IngestConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
    this.worker?.postMessage({ t: "config", cfg: patch });
  }

  getConfig(): Readonly<IngestConfig> {
    return this.cfg;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker?.postMessage({ t: "stop" });
    this.worker?.terminate();
    this.worker = null;
  }
}
