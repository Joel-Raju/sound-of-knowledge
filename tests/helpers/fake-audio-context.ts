/**
 * Minimal Web Audio graph recorder.
 *
 * Not a DSP emulator — it records the *topology* (`connect` edges, node
 * creation, parameter automation) so unit tests can assert how the engine is
 * wired without a browser. That matters because the single worst class of bug
 * in this codebase is silent: a node connected to a bus that is itself
 * connected to nothing. It builds, boots, passes every e2e smoke check, and
 * produces complete silence.
 *
 * That exact bug shipped in T3.3 — `buildFxChain` ran *after* the master chain
 * was wired, so the FX chain's `mixBus` (which the pad, drone, air, reverb
 * return and delay all terminate at) was a dangling node. Nothing failed; the
 * continuous layers were simply inaudible.
 */

/** A recorded connection edge. */
export interface Edge {
  from: string;
  to: string;
}

/** A scheduled parameter change, for asserting automation shape. */
export interface ParamEvent {
  kind: "setValueAtTime" | "linearRampToValueAtTime" | "setTargetAtTime" | "cancelScheduledValues";
  value?: number;
  time?: number;
  timeConstant?: number;
}

/** A fake `AudioParam` that keeps a history so tests can inspect it. */
export class FakeParam {
  value = 0;
  readonly events: ParamEvent[] = [];

  setValueAtTime(value: number, time: number): this {
    this.value = value;
    this.events.push({ kind: "setValueAtTime", value, time });
    return this;
  }

  linearRampToValueAtTime(value: number, time: number): this {
    this.value = value;
    this.events.push({ kind: "linearRampToValueAtTime", value, time });
    return this;
  }

  setTargetAtTime(value: number, startTime: number, timeConstant: number): this {
    this.value = value;
    this.events.push({ kind: "setTargetAtTime", value, time: startTime, timeConstant });
    return this;
  }

  cancelScheduledValues(time: number): this {
    this.events.push({ kind: "cancelScheduledValues", time });
    return this;
  }

  /** Every value written, in order, for one-off assertions. */
  get values(): number[] {
    return this.events.filter((e) => e.value !== undefined).map((e) => e.value as number);
  }
}

/** Base for every recorded node. */
export class FakeNode {
  /** Unique, stable, human-readable name so failures are readable. */
  readonly name: string;
  /** Every node this one is connected *from* (i.e. its outgoing edges). */
  readonly outgoing = new Set<FakeNode>();
  /** Every node connected into this one. */
  readonly incoming = new Set<FakeNode>();
  disconnected = false;

  constructor(
    readonly kind: string,
    name: string,
  ) {
    this.name = name;
  }

  connect(dest: FakeNode): FakeNode {
    this.outgoing.add(dest);
    dest.incoming.add(this);
    return dest;
  }

  disconnect(dest?: FakeNode): void {
    if (dest) {
      this.outgoing.delete(dest);
      dest.incoming.delete(this);
    } else {
      for (const d of this.outgoing) d.incoming.delete(this);
      this.outgoing.clear();
      this.disconnected = true;
    }
  }

  /** Depth-first reachability from this node, names included. */
  reachable(): Set<string> {
    const seen = new Set<string>();
    const stack: FakeNode[] = [this];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (seen.has(n.name)) continue;
      seen.add(n.name);
      for (const d of n.outgoing) stack.push(d);
    }
    return seen;
  }
}

export class FakeGain extends FakeNode {
  readonly gain = new FakeParam();
  constructor(name: string) {
    super("gain", name);
  }
}

export class FakeOscillator extends FakeNode {
  frequency = new FakeParam();
  detune = new FakeParam();
  type = "sine";
  started = false;
  stoppedAt: number | null = null;
  startedAt = 0;
  onended: (() => void) | null = null;

  constructor(name: string) {
    super("oscillator", name);
  }

  start(t = 0): void {
    this.started = true;
    this.startedAt = t;
  }

  stop(t = 0): void {
    if (this.stoppedAt === null) this.stoppedAt = t;
  }
}

export class FakeBufferSource extends FakeNode {
  buffer: unknown = null;
  loop = false;
  onended: (() => void) | null = null;

  constructor(name: string) {
    super("bufferSource", name);
  }

  start(t = 0): void {
    void t;
  }

  stop(): void {
    /* noop */
  }
}

export class FakeBiquad extends FakeNode {
  type = "lowpass";
  frequency = new FakeParam();
  Q = new FakeParam();
  gain = new FakeParam();
  detune = new FakeParam();

  constructor(name: string) {
    super("biquad", name);
  }
}

export class FakeDelay extends FakeNode {
  delayTime = new FakeParam();

  constructor(name: string) {
    super("delay", name);
  }
}

export class FakeConvolver extends FakeNode {
  buffer: unknown = null;
  normalize = false;

  constructor(name: string) {
    super("convolver", name);
  }
}

export class FakeCompressor extends FakeNode {
  threshold = new FakeParam();
  knee = new FakeParam();
  ratio = new FakeParam();
  attack = new FakeParam();
  release = new FakeParam();

  constructor(name: string) {
    super("compressor", name);
  }
}

export class FakeWaveShaper extends FakeNode {
  curve: Float32Array | null = null;
  oversample = "none";

  constructor(name: string) {
    super("waveShaper", name);
  }
}

export class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  smoothingTimeConstant = 0;
  frequencyBinCount = 1024;
  /** Overwritten by tests that need real numbers. */
  getFloatFrequencyData = (arr: Float32Array): void => {
    arr.fill(-100);
  };
  getFloatTimeDomainData = (arr: Float32Array): void => {
    arr.fill(0);
  };

  constructor(name: string) {
    super("analyser", name);
  }
}

export class FakePanner extends FakeNode {
  panningModel = "equalpower";
  distanceModel = "inverse";
  refDistance = 1;
  rolloffFactor = 1;
  maxDistance = 10000;
  coneInnerAngle = 360;
  positionX = new FakeParam();
  positionY = new FakeParam();
  positionZ = new FakeParam();
  orientationX = new FakeParam();
  orientationY = new FakeParam();
  orientationZ = new FakeParam();

  constructor(name: string) {
    super("panner", name);
  }
}

class FakeBuffer {
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {}
  private readonly data: Float32Array[] = [];
  copyToChannel(src: Float32Array, ch: number): void {
    this.data[ch] = src;
  }
  getChannelData(ch: number): Float32Array {
    return this.data[ch] ?? new Float32Array(this.length);
  }
}

/** Port stand-in; records messages so tests can assert what the engine posted. */
export class FakePort {
  readonly posted: unknown[] = [];
  postMessage(msg: unknown): void {
    this.posted.push(msg);
  }
}

export class FakeAudioWorkletNode extends FakeNode {
  readonly port = new FakePort();
  constructor(name: string) {
    super("worklet", name);
  }
}

/**
 * Records a graph and answers the `createX` factory calls `AudioEngine` makes.
 *
 * `currentTime` is a plain number the test advances by hand, which keeps every
 * assertion about automation deterministic.
 */
export class FakeAudioContext {
  currentTime = 0;
  readonly sampleRate: number;
  readonly nodes: FakeNode[] = [];
  readonly destination: FakeGain;
  readonly listener: Record<string, unknown>;
  readonly audioWorklet = { addModule: async (_url: string): Promise<void> => {} };
  /** Buffers handed to `createBuffer`, in order. */
  readonly buffers: FakeBuffer[] = [];

  private counter = 0;

  constructor(opts: { sampleRate?: number } = {}) {
    this.sampleRate = opts.sampleRate ?? 48000;
    this.destination = this.register(new FakeGain("destination"));
    this.listener = {
      positionX: new FakeParam(),
      positionY: new FakeParam(),
      positionZ: new FakeParam(),
      forwardX: new FakeParam(),
      forwardY: new FakeParam(),
      forwardZ: new FakeParam(),
    };
  }

  private register<T extends FakeNode>(node: T): T {
    this.nodes.push(node);
    return node;
  }

  private name(prefix: string): string {
    return `${prefix}#${this.counter++}`;
  }

  createGain(): FakeGain {
    return this.register(new FakeGain(this.name("gain")));
  }

  createOscillator(): FakeOscillator {
    return this.register(new FakeOscillator(this.name("osc")));
  }

  createBiquadFilter(): FakeBiquad {
    return this.register(new FakeBiquad(this.name("biquad")));
  }

  createDelay(maxDelay: number): FakeDelay {
    void maxDelay;
    return this.register(new FakeDelay(this.name("delay")));
  }

  createConvolver(): FakeConvolver {
    return this.register(new FakeConvolver(this.name("convolver")));
  }

  createDynamicsCompressor(): FakeCompressor {
    return this.register(new FakeCompressor(this.name("comp")));
  }

  createWaveShaper(): FakeWaveShaper {
    return this.register(new FakeWaveShaper(this.name("clip")));
  }

  createAnalyser(): FakeAnalyser {
    return this.register(new FakeAnalyser(this.name("analyser")));
  }

  createPanner(): FakePanner {
    return this.register(new FakePanner(this.name("panner")));
  }

  createBufferSource(): FakeBufferSource {
    return this.register(new FakeBufferSource(this.name("bufsrc")));
  }

  createBuffer(channels: number, length: number, sampleRate: number): FakeBuffer {
    const buf = new FakeBuffer(channels, length, sampleRate);
    this.buffers.push(buf);
    return buf;
  }

  async close(): Promise<void> {
    /* noop */
  }

  /** All recorded edges, for readable failure messages. */
  get edges(): Edge[] {
    const out: Edge[] = [];
    for (const n of this.nodes) {
      for (const d of n.outgoing) out.push({ from: n.name, to: d.name });
    }
    return out;
  }

  nodesOfType(kind: string): FakeNode[] {
    return this.nodes.filter((n) => n.kind === kind);
  }

  /** Typed views — `nodesOfType` returns the base class, these narrow it. */
  gains(): FakeGain[] {
    return this.nodesOfType("gain") as FakeGain[];
  }
  nonDestinationGains(): FakeGain[] {
    return this.gains().filter((g) => g.name !== "destination");
  }
  oscillators(): FakeOscillator[] {
    return this.nodesOfType("oscillator") as FakeOscillator[];
  }
  panners(): FakePanner[] {
    return this.nodesOfType("panner") as FakePanner[];
  }
  convolvers(): FakeConvolver[] {
    return this.nodesOfType("convolver") as FakeConvolver[];
  }
  compressors(): FakeCompressor[] {
    return this.nodesOfType("compressor") as FakeCompressor[];
  }
  shapers(): FakeWaveShaper[] {
    return this.nodesOfType("waveShaper") as FakeWaveShaper[];
  }
  analysers(): FakeAnalyser[] {
    return this.nodesOfType("analyser") as FakeAnalyser[];
  }
  delayNodes(): FakeDelay[] {
    return this.nodesOfType("delay") as FakeDelay[];
  }
  biquads(): FakeBiquad[] {
    return this.nodesOfType("biquad") as FakeBiquad[];
  }
  bufferSources(): FakeBufferSource[] {
    return this.nodesOfType("bufferSource") as FakeBufferSource[];
  }
}

/**
 * Install the globals `AudioEngine.init` needs (`AudioWorkletNode`, and a
 * Web-Audio constructor surface for the typed `ctx`). Returns a teardown.
 *
 * `AudioEngine` accepts a `BaseAudioContext`; in Node that type is satisfied
 * by `globalThis`, and the fake supplies the members actually called.
 */
export function installFakeAudioGlobals(sampleRate = 48000): {
  ctx: FakeAudioContext;
  restore: () => void;
} {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = new Map<string, unknown>();
  const ctx = new FakeAudioContext({ sampleRate });

  const workletCtor = function (this: unknown) {
    return new FakeAudioWorkletNode("worklet");
  } as unknown as new () => FakeAudioWorkletNode;

  const overrides: Record<string, unknown> = {
    AudioWorkletNode: workletCtor,
    // `init()` feature-detects `ctx.audioWorklet`; the fake has it.
  };

  for (const [k, v] of Object.entries(overrides)) {
    saved.set(k, g[k]);
    g[k] = v;
  }

  return {
    ctx,
    restore: () => {
      for (const [k, v] of saved) {
        if (v === undefined) delete g[k];
        else g[k] = v;
      }
    },
  };
}
