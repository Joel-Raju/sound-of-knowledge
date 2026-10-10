// @hot-file — AudioWorkletProcessor entry (spec §5.3, §8.5).
// STUB for T0.2. Replaced by T3.2 with the voice-pool processor.
//
// AudioWorklet *global scope* types (`AudioWorkletProcessor`, `registerProcessor`)
// are NOT in TypeScript's lib.dom — they only exist in the worklet realm. They
// are declared here, minimally, rather than adding lib.webworker, which
// conflicts with lib.dom (duplicate global declarations).
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
  abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    params: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void;

class SokVoicePoolStub extends AudioWorkletProcessor {
  override process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (out && out[0]) out[0].fill(0);
    return true;
  }
}

registerProcessor("sok-voice-pool", SokVoicePoolStub);

export {};
