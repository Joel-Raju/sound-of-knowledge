// @hot-file — ingest worker entry. Spec §5.3, §6.
// Bundled by esbuild to `public/engine/ingest.worker.js` and loaded with
// `new Worker('/engine/ingest.worker.js')`.
//
// This file is a thin shell: it owns the worker globals and wires them to
// `IngestCore`, which contains no worker references and is unit-tested in Node.
// That split is deliberate — the interesting logic must be testable without a
// browser.

import { IngestCore } from "./ingest-core";
import { SseClient, defaultSseDeps, type StreamState } from "./sse-client";
import { normalize } from "./normalize";
import { SyntheticSource } from "./synthetic";
import { ReplaySource } from "./replay";
import { mulberry32 } from "../util/random";
import { BATCH_INTERVAL_MS } from "../config";
import type { IngestConfig, Source, WorkerIn, WorkerOut } from "./protocol";

interface WorkerScope {
  postMessage(data: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (ev: MessageEvent) => void): void;
}

const ctx = self as unknown as WorkerScope;
const post = (msg: WorkerOut, transfer?: Transferable[]): void => ctx.postMessage(msg, transfer);

let core: IngestCore | null = null;
let sse: SseClient | null = null;
let config: IngestConfig | null = null;
let currentMode: IngestConfig["mode"] | null = null;

function setStatus(state: StreamState, detail?: string): void {
  post(detail === undefined ? { t: "status", state } : { t: "status", state, detail });
}

/** Live path: SSE → parse → normalize → filter → dedupe → sample. */
function startLive(cfg: IngestConfig): void {
  stopSse();
  currentMode = "live";
  sse = new SseClient(cfg.streamUrl, defaultSseDeps(), {
    onData: (data) => core?.feedRawData(data, normalize),
    onStatus: (state, detail) => {
      // A recovered live connection ends the replay fallback (§6.6).
      if (state === "live" && currentMode === "replay") {
        currentMode = "live";
        void switchToSyntheticOrReplay(cfg); // no-op while live resumes
      }
      setStatus(state, detail);
    },
    onFallbackToReplay: (detail) => {
      setStatus("replay", detail);
      void startReplay(cfg, true);
    },
  });
  sse.start();
}

function stopSse(): void {
  sse?.stop();
  sse = null;
}

/** Replay path (§6.7): reads the bundled NDJSON and loops it forever. */
async function startReplay(cfg: IngestConfig, isFallback = false): Promise<void> {
  stopSse();
  currentMode = "replay";
  try {
    const text = await fetch(cfg.replayUrl).then((r) => (r.ok ? r.text() : ""));
    const src: Source = ReplaySource.fromText(text, cfg.replayUrl);
    core?.setSource(src);
    if (!isFallback) setStatus("replay", "Replaying a bundled recording");
  } catch {
    // No recording available — fall back to the deterministic synthetic stream
    // so the experience still works offline (§3.2: no backend required).
    core?.setSource(new SyntheticSource({ seed: cfg.seed, rateMul: cfg.rateMul }));
    setStatus("replay", "No recording available — using synthetic stream");
  }
}

/** Synthetic path (§6.7) — also the offline default. */
function startSynthetic(cfg: IngestConfig): void {
  stopSse();
  currentMode = "synthetic";
  core?.setSource(new SyntheticSource({ seed: cfg.seed, rateMul: cfg.rateMul }));
  setStatus("live", "Synthetic stream");
}

async function switchToSyntheticOrReplay(cfg: IngestConfig): Promise<void> {
  if (currentMode === "synthetic") return;
  await startReplay(cfg);
}

async function applyMode(cfg: IngestConfig): Promise<void> {
  switch (cfg.mode) {
    case "live":
      await startReplay(cfg); // load the fallback first, so we are never mute
      startLive(cfg);
      break;
    case "replay":
      await startReplay(cfg);
      break;
    case "synthetic":
      startSynthetic(cfg);
      break;
  }
}

ctx.addEventListener("message", (ev: MessageEvent) => {
  const msg = ev.data as WorkerIn | undefined;
  if (!msg || typeof msg.t !== "string") return;

  switch (msg.t) {
    case "start": {
      config = msg.cfg;
      core = new IngestCore(
        {
          now: () => Date.now(),
          setInterval: (fn, ms) => globalThis.setInterval(fn, ms) as unknown as number,
          clearInterval: (h) => globalThis.clearInterval(h),
          emit: (m) => {
            // Transfer the numeric buffer so the batch is zero-copy (§6.5).
            if (m.t === "batch") post(m, [m.num.buffer]);
            else post(m);
          },
        },
        mulberry32(config.seed),
      );
      core.start({ ...msg.cfg, batchIntervalMs: msg.cfg.batchIntervalMs || BATCH_INTERVAL_MS });
      void applyMode(msg.cfg);
      break;
    }
    case "config": {
      if (!core || !config) return;
      config = { ...config, ...msg.cfg };
      core.applyConfig(msg.cfg);
      if (msg.cfg.mode !== undefined) void applyMode(config);
      break;
    }
    case "stop": {
      stopSse();
      core?.stop();
      core = null;
      break;
    }
  }
});

export {};
