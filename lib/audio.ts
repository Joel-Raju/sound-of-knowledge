import * as Tone from "tone";
import type { WikiEditEvent } from "./types";

type AudioEngine = {
  init: () => Promise<void>;
  triggerEdit: (event: WikiEditEvent) => void;
  getAmplitude: () => number;
  getLowFreq: () => number;
  getHighFreq: () => number;
  dispose: () => void;
};

let engine: AudioEngine | null = null;

export function getAudioEngine(): AudioEngine {
  if (engine) return engine;

  let initialized = false;

  // ── Analyzers ────────────────────────────────────────────────────────────────
  const masterAnalyser = new Tone.Analyser("waveform", 256);
  const fftAnalyser    = new Tone.Analyser("fft", 64);

  // ── Master FX chain ──────────────────────────────────────────────────────────
  // Ori's sound: enormous cathedral reverb, gentle shimmer, wide stereo
  const limiter = new Tone.Limiter(-3).toDestination();

  // Long hall reverb — Ori's world feels vast
  const reverb = new Tone.Reverb({ decay: 12, wet: 0.55, preDelay: 0.3 }).connect(limiter);

  // Ping-pong delay for spatial width
  const delay = new Tone.PingPongDelay({ delayTime: "4n", feedback: 0.28, wet: 0.18 }).connect(reverb);

  // Chorus for that shimmering, otherworldly quality
  const chorus = new Tone.Chorus({ frequency: 0.2, delayTime: 4, depth: 0.5, wet: 0.35 }).connect(delay);

  // EQ: boost highs for sparkle, cut harsh mids
  const eq = new Tone.EQ3({ low: 2, mid: -3, high: 4 }).connect(chorus);

  const masterGain = new Tone.Gain(0.5).connect(eq);
  masterGain.connect(masterAnalyser);
  masterGain.connect(fftAnalyser);

  // ── Ambient forest drone ──────────────────────────────────────────────────────
  // Low, breathing pad — like the forest itself is alive
  const droneSynth = new Tone.PolySynth(Tone.FMSynth, {
    harmonicity: 0.25,
    modulationIndex: 1.5,
    oscillator: { type: "sine" },
    envelope: { attack: 6, decay: 2, sustain: 1, release: 8 },
    modulation: { type: "sine" },
    modulationEnvelope: { attack: 4, decay: 0, sustain: 1, release: 6 },
    volume: -22,
  }).connect(masterGain);

  // High shimmer layer — like light through leaves
  const shimmerSynth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "sine" },
    envelope: { attack: 3, decay: 1, sustain: 0.8, release: 5 },
    volume: -28,
  }).connect(masterGain);

  // ── TINY: Harp pluck — single crystalline note ───────────────────────────────
  const harpSynth = new Tone.PolySynth(Tone.FMSynth, {
    harmonicity: 4.5,
    modulationIndex: 6,
    oscillator: { type: "triangle" },
    envelope: { attack: 0.001, decay: 0.5, sustain: 0, release: 2.0 },
    modulation: { type: "sine" },
    modulationEnvelope: { attack: 0.001, decay: 0.2, sustain: 0, release: 0.8 },
    volume: -14,
  }).connect(masterGain);

  // ── SMALL: Celesta / music box — Ori's iconic sparkle ────────────────────────
  const celestaSynth = new Tone.PolySynth(Tone.FMSynth, {
    harmonicity: 6,
    modulationIndex: 12,
    oscillator: { type: "sine" },
    envelope: { attack: 0.002, decay: 0.6, sustain: 0, release: 2.5 },
    modulation: { type: "triangle" },
    modulationEnvelope: { attack: 0.005, decay: 0.15, sustain: 0, release: 1.0 },
    volume: -12,
  }).connect(masterGain);

  // ── MEDIUM: Choir pad — Ori's emotional swell ────────────────────────────────
  const choirSynth = new Tone.PolySynth(Tone.AMSynth, {
    harmonicity: 1.0,
    oscillator: { type: "sine" },
    envelope: { attack: 0.6, decay: 0.8, sustain: 0.6, release: 3.5 },
    modulation: { type: "sine" },
    modulationEnvelope: { attack: 1.0, decay: 0, sustain: 1, release: 2 },
    volume: -9,
  }).connect(masterGain);

  // ── LARGE: Orchestral swell — strings + brass hit ────────────────────────────
  const orchestraSynth = new Tone.PolySynth(Tone.FMSynth, {
    harmonicity: 1.5,
    modulationIndex: 3,
    oscillator: { type: "sawtooth" },
    envelope: { attack: 1.2, decay: 1.5, sustain: 0.7, release: 5 },
    modulation: { type: "sine" },
    modulationEnvelope: { attack: 0.8, decay: 0.5, sustain: 0.8, release: 3 },
    volume: -7,
  }).connect(masterGain);

  // ── REVERT: Dark gong / Kuro's corruption ────────────────────────────────────
  const kuroSynth = new Tone.FMSynth({
    harmonicity: 0.8,
    modulationIndex: 25,
    oscillator: { type: "sine" },
    envelope: { attack: 0.02, decay: 2.5, sustain: 0.1, release: 6 },
    modulation: { type: "square" },
    modulationEnvelope: { attack: 0.01, decay: 1.2, sustain: 0, release: 2 },
    volume: -8,
  }).connect(masterGain);

  // ── BOT: Mechanical crystal ping ─────────────────────────────────────────────
  const botSynth = new Tone.PolySynth(Tone.FMSynth, {
    harmonicity: 8,
    modulationIndex: 20,
    oscillator: { type: "sine" },
    envelope: { attack: 0.001, decay: 0.2, sustain: 0, release: 0.8 },
    modulation: { type: "triangle" },
    modulationEnvelope: { attack: 0.001, decay: 0.08, sustain: 0, release: 0.3 },
    volume: -20,
  }).connect(masterGain);

  droneSynth.maxPolyphony = 24;
  shimmerSynth.maxPolyphony = 24;
  harpSynth.maxPolyphony = 64;
  celestaSynth.maxPolyphony = 64;
  choirSynth.maxPolyphony = 48;
  orchestraSynth.maxPolyphony = 48;
  botSynth.maxPolyphony = 32;

  // ── Note pools — Ori uses A minor pentatonic / modal scales ──────────────────
  // A minor pentatonic: A C D E G — ethereal, ancient, forest-like
  const harpNotes    = ["A5", "C6", "D6", "E6", "G6", "A6", "C7"];
  const celestaNotes = ["A5", "C6", "E6", "G6", "A6", "C7", "E7"];

  // Modal chords — Dorian/Aeolian for that Ori emotional quality
  const choirChords = [
    ["A3", "C4", "E4", "G4"],      // Am7
    ["D3", "F3", "A3", "C4"],      // Dm7
    ["E3", "G3", "B3", "D4"],      // Em7
    ["G3", "B3", "D4", "F4"],      // G7 (tension)
    ["C3", "E3", "G3", "B3"],      // Cmaj7
    ["F3", "A3", "C4", "E4"],      // Fmaj7
  ];
  const orchestraChords = [
    ["A2", "E3", "A3", "C4", "E4", "G4"],   // Am9
    ["D2", "A2", "D3", "F3", "A3", "C4"],   // Dm9
    ["G2", "D3", "G3", "B3", "D4", "F4"],   // G9
    ["C2", "G2", "C3", "E3", "G3", "B3"],   // Cmaj9
    ["F2", "C3", "F3", "A3", "C4", "E4"],   // Fmaj9
  ];
  const kuroNotes = ["A1", "E1", "D1", "G1"];
  const botNotes  = ["A7", "E7", "C7", "G7"];

  let noteIdx = 0;
  let nextTrigger = 0;
  let lastTriggerAt = 0;
  let droneStarted = false;
  let droneInterval: ReturnType<typeof setInterval> | null = null;
  let variationTick = 0;

  function hashEvent(event: WikiEditEvent): number {
    const raw = `${event.id}-${event.title}-${event.timestamp}-${event.sizeDelta}`;
    let hash = 2166136261;
    for (let i = 0; i < raw.length; i++) {
      hash ^= raw.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function rand(seed: number, salt: number): number {
    return ((seed ^ Math.imul(salt, 1103515245)) >>> 0) / 4294967295;
  }

  function getNextTriggerTime(): number {
    const now = Tone.now();
    nextTrigger = Math.max(now + 0.005, nextTrigger + 0.002);
    return nextTrigger;
  }

  function startDrone() {
    if (droneStarted) return;
    droneStarted = true;

    // Start the deep forest drone
    droneSynth.triggerAttack(["A1", "E2", "A2"], Tone.now() + 0.5, 0.08);
    // High shimmer layer
    shimmerSynth.triggerAttack(["A4", "E5"], Tone.now() + 2, 0.04);

    // Slowly evolve the drone — Ori's world breathes
    const droneChords = [
      { bass: ["A1", "E2", "A2"],    shimmer: ["A4", "E5"] },
      { bass: ["D2", "A2", "D3"],    shimmer: ["D5", "A5"] },
      { bass: ["G1", "D2", "G2"],    shimmer: ["G4", "D5"] },
      { bass: ["E2", "B2", "E3"],    shimmer: ["E5", "B5"] },
    ];
    let droneIdx = 0;

    droneInterval = setInterval(() => {
      if (!initialized) return;
      droneIdx = (droneIdx + 1) % droneChords.length;
      const next = droneChords[droneIdx];
      const t = Tone.now() + 3;
      droneSynth.releaseAll(t - 0.05);
      shimmerSynth.releaseAll(t + 0.95);
      droneSynth.triggerAttack(next.bass, t, 0.06);
      shimmerSynth.triggerAttack(next.shimmer, t + 1, 0.03);
    }, 16000);
  }

  function triggerEdit(event: WikiEditEvent) {
    if (!initialized) return;
    variationTick += 1;
    const magnitude = event.magnitude;
    const isBot = event.isBot;
    const isRevert = event.isRevert;
    const seed = hashEvent(event) ^ variationTick;
    const energy = Math.min(1, Math.log10(Math.abs(event.sizeDelta) + 10) / 4);

    const now = Tone.now();
    const minGap = isRevert || magnitude === "LARGE"
      ? 0.12
      : magnitude === "MEDIUM"
        ? 0.09
        : 0.06;
    if (now - lastTriggerAt < minGap) return;
    lastTriggerAt = now;
    const jitteredTime = getNextTriggerTime() + (rand(seed, 3) - 0.5) * 0.02;

    chorus.frequency.rampTo(0.16 + rand(seed, 5) * 0.45, 0.2);
    delay.delayTime.rampTo(0.15 + rand(seed, 7) * 0.35, 0.12);
    reverb.wet.rampTo(0.4 + energy * 0.4 + rand(seed, 11) * 0.12, 0.3);

    if (isBot) {
      botSynth.triggerAttackRelease(botNotes[(noteIdx + Math.floor(rand(seed, 13) * botNotes.length)) % botNotes.length], "32n", jitteredTime, 0.4 + rand(seed, 17) * 0.45);
      noteIdx++;
      return;
    }

    if (isRevert) {
      // Kuro's dark gong + dissonant chord
      kuroSynth.modulationIndex.value = 18 + rand(seed, 19) * 26;
      kuroSynth.triggerAttackRelease(kuroNotes[(noteIdx + Math.floor(rand(seed, 23) * kuroNotes.length)) % kuroNotes.length], "1n", jitteredTime, 0.8 + energy * 0.2);
      noteIdx++;
      return;
    }

    switch (magnitude) {
      case "TINY": {
        const noteOffset = Math.floor(rand(seed, 29) * harpNotes.length);
        harpSynth.triggerAttackRelease(
          harpNotes[(noteIdx + noteOffset) % harpNotes.length],
          rand(seed, 31) > 0.5 ? "16n" : "32n",
          jitteredTime,
          0.45 + rand(seed, 37) * 0.45
        );
        break;
      }
      case "SMALL": {
        const n1 = celestaNotes[(noteIdx + Math.floor(rand(seed, 41) * celestaNotes.length)) % celestaNotes.length];
        const n2 = celestaNotes[(noteIdx + 2 + Math.floor(rand(seed, 43) * 3)) % celestaNotes.length];
        const lag = 0.03 + rand(seed, 47) * 0.07;
        celestaSynth.triggerAttackRelease(n1, "16n", jitteredTime, 0.42 + rand(seed, 53) * 0.4);
        celestaSynth.triggerAttackRelease(n2, rand(seed, 59) > 0.5 ? "16n" : "8n", jitteredTime + lag, 0.38 + rand(seed, 61) * 0.4);
        break;
      }
      case "MEDIUM": {
        const chord = choirChords[(noteIdx + Math.floor(rand(seed, 67) * choirChords.length)) % choirChords.length];
        choirSynth.triggerAttackRelease(chord, rand(seed, 71) > 0.5 ? "2n" : "1n", jitteredTime, 0.52 + energy * 0.35);
        chord.forEach((note, i) => {
          harpSynth.triggerAttackRelease(
            note.replace(/\d/, (d) => String(parseInt(d, 10) + 1)),
            "16n",
            jitteredTime + i * (0.035 + rand(seed, 73 + i) * 0.03),
            0.28 + rand(seed, 79 + i) * 0.3
          );
        });
        break;
      }
      case "LARGE": {
        const chord = orchestraChords[(noteIdx + Math.floor(rand(seed, 89) * orchestraChords.length)) % orchestraChords.length];
        orchestraSynth.triggerAttackRelease(chord, rand(seed, 97) > 0.45 ? "1n" : "2n", jitteredTime, 0.7 + energy * 0.28);
        chord.forEach((note, i) => {
          const step = 0.05 + rand(seed, 101 + i) * 0.06;
          harpSynth.triggerAttackRelease(note, "8n", jitteredTime + i * step, 0.42 + rand(seed, 109 + i) * 0.3);
          celestaSynth.triggerAttackRelease(
            note.replace(/\d/, (d) => String(parseInt(d, 10) + 1)),
            "16n",
            jitteredTime + i * step + 0.03 + rand(seed, 127 + i) * 0.03,
            0.3 + rand(seed, 131 + i) * 0.26
          );
        });
        break;
      }
    }
    noteIdx++;
  }

  function getAmplitude(): number {
    const buf = masterAnalyser.getValue() as Float32Array;
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += Math.abs(buf[i]);
    return Math.min(1, (sum / buf.length) * 7);
  }

  function getLowFreq(): number {
    const buf = fftAnalyser.getValue() as Float32Array;
    const slice = buf.slice(0, 8);
    let sum = 0;
    for (let i = 0; i < slice.length; i++) sum += Math.max(0, (slice[i] + 100) / 100);
    return Math.min(1, sum / slice.length);
  }

  function getHighFreq(): number {
    const buf = fftAnalyser.getValue() as Float32Array;
    const slice = buf.slice(buf.length - 16);
    let sum = 0;
    for (let i = 0; i < slice.length; i++) sum += Math.max(0, (slice[i] + 100) / 100);
    return Math.min(1, sum / slice.length);
  }

  function dispose() {
    if (droneInterval) clearInterval(droneInterval);
    droneSynth.releaseAll();    droneSynth.dispose();
    shimmerSynth.releaseAll();  shimmerSynth.dispose();
    harpSynth.dispose();
    celestaSynth.dispose();
    choirSynth.dispose();
    orchestraSynth.dispose();
    kuroSynth.dispose();
    botSynth.dispose();
    masterGain.dispose();
    eq.dispose();
    chorus.dispose();
    delay.dispose();
    reverb.dispose();
    limiter.dispose();
    masterAnalyser.dispose();
    fftAnalyser.dispose();
    initialized = false;
    engine = null;
  }

  engine = {
    init: async () => {
      if (initialized) return;
      await Tone.start();
      initialized = true;
      startDrone();
    },
    triggerEdit,
    getAmplitude,
    getLowFreq,
    getHighFreq,
    dispose,
  };

  return engine;
}
