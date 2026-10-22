/**
 * Worker ⇄ main-thread message protocol. Spec §6.5.
 *
 * Kept in its own module so the worker bundle and the main thread cannot
 * drift apart: both import these types, and `encode.ts` defines the batch
 * payload they refer to.
 */
import type { BatchMsg } from "./encode";

export type DataMode = "live" | "replay" | "synthetic";

export interface IngestConfig {
  mode: DataMode;
  streamUrl: string;
  replayUrl: string;
  seed: number;
  /** `?rateMul=` — scales the synthetic source's arrival rate. Default 1. */
  rateMul: number;
  source: "wikipedias" | "no-wikidata" | "all";
  langs: string[];
  namespaces: "main" | "all";
  maxPerSec: number;
  batchIntervalMs: number;
}

export const DEFAULT_INGEST_CONFIG: IngestConfig = {
  mode: "live",
  streamUrl: "https://stream.wikimedia.org/v2/stream/recentchange",
  replayUrl: "/replay/sample.ndjson",
  seed: 1,
  rateMul: 1,
  source: "wikipedias",
  langs: [],
  namespaces: "main",
  maxPerSec: 40,
  batchIntervalMs: 50,
};

export type WorkerIn =
  { t: "start"; cfg: IngestConfig } | { t: "config"; cfg: Partial<IngestConfig> } | { t: "stop" };

export type StreamState = "connecting" | "live" | "reconnecting" | "replay" | "error";

export type WorkerOut =
  | BatchMsg
  | {
      t: "stats";
      seen: number;
      accepted: number;
      dropped: number;
      parseErrors: number;
      botAccepted: number;
      revertAccepted: number;
      windowMs: number;
    }
  | { t: "status"; state: StreamState; detail?: string }
  | { t: "tick" };

/** A pull-based event source. Live, replay and synthetic all satisfy this. */
export interface Source {
  /** Advance by `dtMs` and return whatever events arrived in that window. */
  next(dtMs: number): import("../types").NormalizedEdit[];
  dispose?(): void;
}
