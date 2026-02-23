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

  // Analyzers
  const masterAnalyser = new Tone.Analyser("waveform", 256);
  const fftAnalyser = new Tone.Analyser("fft", 64);

  // Master limiter → output
  const limiter = new Tone.Limiter(-6).toDestination();
  const reverb = new Tone.Reverb({ decay: 2.5, wet: 0.3 }).connect(limiter);
  const masterGain = new Tone.Gain(0.7).connect(reverb);
  masterGain.connect(masterAnalyser);
  masterGain.connect(fftAnalyser);

  // Synths per magnitude
  const tinySynth = new Tone.Synth({
    oscillator: { type: "sine" },
    envelope: { attack: 0.005, decay: 0.1, sustain: 0, release: 0.1 },
    volume: -18,
  }).connect(masterGain);

  const smallSynth = new Tone.Synth({
    oscillator: { type: "triangle" },
    envelope: { attack: 0.01, decay: 0.2, sustain: 0.1, release: 0.3 },
    volume: -14,
  }).connect(masterGain);

  const mediumSynth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "sawtooth" },
    envelope: { attack: 0.02, decay: 0.4, sustain: 0.2, release: 0.5 },
    volume: -10,
  }).connect(masterGain);

  const largeSynth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "square" },
    envelope: { attack: 0.05, decay: 0.8, sustain: 0.3, release: 1.0 },
    volume: -6,
  }).connect(masterGain);

  const revertSynth = new Tone.Synth({
    oscillator: { type: "sawtooth" },
    envelope: { attack: 0.01, decay: 0.6, sustain: 0.1, release: 0.8 },
    volume: -8,
  }).connect(masterGain);

  const botSynth = new Tone.MetalSynth({
    envelope: { attack: 0.001, decay: 0.1, release: 0.1 },
    harmonicity: 5.1,
    modulationIndex: 32,
    resonance: 4000,
    octaves: 1.5,
    volume: -20,
  }).connect(masterGain);

  // Note pools per magnitude
  const tinyNotes = ["C6", "E6", "G6", "B6"];
  const smallNotes = ["C5", "E5", "G5", "A5", "D5"];
  const mediumNotes = [
    ["C4", "E4", "G4"],
    ["D4", "F4", "A4"],
    ["E4", "G4", "B4"],
  ];
  const largeNotes = [
    ["C3", "G3", "C4", "E4"],
    ["D3", "A3", "D4", "F4"],
    ["F3", "C4", "F4", "A4"],
  ];
  const revertNotes = ["C2", "D2", "E2", "F2"];

  let noteIdx = 0;
  let nextTriggerTime = 0;
  let lastLogTime = 0;

  function getNextTriggerTime(): number {
    const now = Tone.now();
    // Always schedule at least 5ms in the future from now, and strictly after previous trigger
    nextTriggerTime = Math.max(now + 0.005, nextTriggerTime + 0.001);
    // Log every second to avoid spam
    if (now - lastLogTime > 1) {
      console.log('Tone.now():', now, 'nextTriggerTime:', nextTriggerTime);
      lastLogTime = now;
    }
    return nextTriggerTime;
  }

  function triggerEdit(
    magnitude: EditMagnitude,
    isBot: boolean,
    isRevert: boolean,
    _sizeDelta: number
  ) {
    if (!initialized) return;

    const triggerTime = getNextTriggerTime();

    if (isBot) {
      // Use shared triggerTime to ensure monotonic scheduling across all synths
      botSynth.triggerAttackRelease("16n", triggerTime);
      return;
    }

    if (isRevert) {
      const note = revertNotes[noteIdx % revertNotes.length];
      revertSynth.triggerAttackRelease(note, "8n", triggerTime);
      noteIdx++;
      return;
    }

    switch (magnitude) {
      case "TINY": {
        const note = tinyNotes[noteIdx % tinyNotes.length];
        tinySynth.triggerAttackRelease(note, "32n", triggerTime);
        break;
      }
      case "SMALL": {
        const note = smallNotes[noteIdx % smallNotes.length];
        smallSynth.triggerAttackRelease(note, "16n", triggerTime);
        break;
      }
      case "MEDIUM": {
        const chord = mediumNotes[noteIdx % mediumNotes.length];
        mediumSynth.triggerAttackRelease(chord, "8n", triggerTime);
        break;
      }
      case "LARGE": {
        const chord = largeNotes[noteIdx % largeNotes.length];
        largeSynth.triggerAttackRelease(chord, "4n", triggerTime);
        break;
      }
    }
    noteIdx++;
  }

  function getAmplitude(): number {
    const buf = masterAnalyser.getValue() as Float32Array;
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += Math.abs(buf[i]);
    return Math.min(1, (sum / buf.length) * 8);
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
    tinySynth.dispose();
    smallSynth.dispose();
    mediumSynth.dispose();
    largeSynth.dispose();
    revertSynth.dispose();
    botSynth.dispose();
    masterGain.dispose();
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
    },
    triggerEdit,
    getAmplitude,
    getLowFreq,
    getHighFreq,
    dispose,
  };

  return engine;
}
