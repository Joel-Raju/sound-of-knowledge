// @hot-file — ingest worker (spec §5.3, §6).
// STUB for T0.2. Replaced by T1.5 with the IngestCore shell.
//
// `DedicatedWorkerGlobalScope` needs lib.webworker, which conflicts with
// lib.dom (duplicate declarations). The engine is type-checked against lib.dom,
// so the worker scope is reached through a narrow structural type instead.
interface WorkerScope {
  postMessage(data: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (ev: MessageEvent) => void): void;
  terminate(): void;
}

const ctx = self as unknown as WorkerScope;

ctx.addEventListener("message", () => {
  /* no-op until T1.5 */
});

export {};
