import * as Tone from "tone";
import type { EditMagnitude } from "./types";

type AudioEngine = {
  init: () => Promise<void>;
  triggerEdit: (magnitude: EditMagnitude, isBot: boolean, isRevert: boolean, sizeDelta: number) => void;
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

  let noteIdx       = 0;
  let nextTrigger   = 0;
  let lastTriggerAt = 0;
  let droneStarted  = false;
  let droneInterval: ReturnType<typeof setInterval> | null = null;

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

  function triggerEdit(
    magnitude: EditMagnitude,
    isBot: boolean,
    isRevert: boolean,
    _sizeDelta: number
  ) {
    if (!initialized) return;
    const now = Tone.now();
    const minGap = isRevert || magnitude === "LARGE"
      ? 0.12
      : magnitude === "MEDIUM"
        ? 0.09
        : 0.06;
    if (now - lastTriggerAt < minGap) return;
    lastTriggerAt = now;
    const t = getNextTriggerTime();

    if (isBot) {
      botSynth.triggerAttackRelease(botNotes[noteIdx % botNotes.length], "32n", t);
      noteIdx++;
      return;
    }

    if (isRevert) {
      // Kuro's dark gong + dissonant chord
      kuroSynth.triggerAttackRelease(kuroNotes[noteIdx % kuroNotes.length], "1n", t);
      noteIdx++;
      return;
    }

    switch (magnitude) {
      case "TINY": {
        // Single harp pluck — like a spirit mote appearing
        harpSynth.triggerAttackRelease(
          harpNotes[noteIdx % harpNotes.length], "16n", t
        );
        break;
      }
      case "SMALL": {
        // Celesta sparkle — 2 notes, slight delay for harp-run feel
        const n1 = celestaNotes[noteIdx % celestaNotes.length];
        const n2 = celestaNotes[(noteIdx + 2) % celestaNotes.length];
        celestaSynth.triggerAttackRelease(n1, "16n", t);
        celestaSynth.triggerAttackRelease(n2, "16n", t + 0.06);
        break;
      }
      case "MEDIUM": {
        // Choir swell — emotional, Ori-like
        const chord = choirChords[noteIdx % choirChords.length];
        choirSynth.triggerAttackRelease(chord, "2n", t);
        // Add a harp arpeggio on top
        chord.forEach((note, i) => {
          harpSynth.triggerAttackRelease(note.replace(/\d/, (d) => String(parseInt(d) + 1)), "16n", t + i * 0.05);
        });
        break;
      }
      case "LARGE": {
        // Full orchestral swell — the forest awakens
        const chord = orchestraChords[noteIdx % orchestraChords.length];
        orchestraSynth.triggerAttackRelease(chord, "1n", t);
        // Harp glissando cascade
        chord.forEach((note, i) => {
          harpSynth.triggerAttackRelease(note, "8n", t + i * 0.08);
          celestaSynth.triggerAttackRelease(
            note.replace(/\d/, (d) => String(parseInt(d) + 1)), "16n", t + i * 0.08 + 0.04
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
