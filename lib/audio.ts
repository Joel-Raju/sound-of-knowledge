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
  const limiter = new Tone.Limiter(-0.5).toDestination();
  const reverb = new Tone.Reverb({ decay: 8, wet: 0.45, preDelay: 0.1 }).connect(limiter);
  const delay = new Tone.PingPongDelay({ delayTime: "8n", feedback: 0.35, wet: 0.25 }).connect(reverb);
  const chorus = new Tone.Chorus({ frequency: 0.5, delayTime: 2.5, depth: 0.4, wet: 0.2 }).connect(delay);
  const eq = new Tone.EQ3({ low: 2, mid: -1, high: 3 }).connect(chorus);
  
  const masterGain = new Tone.Gain(2.25).connect(eq);
  masterGain.connect(masterAnalyser);
  masterGain.connect(fftAnalyser);

  // ── Synths ───────────────────────────────────────────────────────────────────
  // A dynamic arpeggiator synth
  const arpSynth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "amtriangle", harmonicity: 2.5, modulationType: "sine" },
    envelope: { attack: 0.01, decay: 0.2, sustain: 0, release: 1 },
    volume: -6,
  }).connect(masterGain);

  // Deep pulsing bass
  const bassSynth = new Tone.MonoSynth({
    oscillator: { type: "square" },
    filter: { Q: 2, type: "lowpass", rolloff: -24 },
    envelope: { attack: 0.05, decay: 0.3, sustain: 0.1, release: 1.5 },
    filterEnvelope: { attack: 0.01, decay: 0.2, sustain: 0, release: 1, baseFrequency: 60, octaves: 4 },
    volume: -3,
  }).connect(masterGain);

  // Lush pad for large edits
  const chordSynth = new Tone.PolySynth(Tone.FMSynth, {
    harmonicity: 2.0,
    modulationIndex: 3,
    oscillator: { type: "sine" },
    envelope: { attack: 0.5, decay: 1.0, sustain: 0.5, release: 4 },
    modulation: { type: "triangle" },
    modulationEnvelope: { attack: 0.5, decay: 0.5, sustain: 0.8, release: 2 },
    volume: -5,
  }).connect(masterGain);

  // Sparkly bell synth for standard edits
  const editSynth = new Tone.PolySynth(Tone.FMSynth, {
    harmonicity: 3.5,
    modulationIndex: 5,
    oscillator: { type: "triangle" },
    envelope: { attack: 0.005, decay: 0.4, sustain: 0, release: 1.5 },
    volume: -1,
  }).connect(masterGain);

  // Percussive synth for bot edits
  const botSynth = new Tone.MembraneSynth({
    pitchDecay: 0.02,
    octaves: 4,
    oscillator: { type: "sine" },
    envelope: { attack: 0.001, decay: 0.3, sustain: 0, release: 0.8 },
    volume: 2,
  }).connect(masterGain);

  // Dark gong/bell for reverts
  const revertSynth = new Tone.MetalSynth({
    envelope: { attack: 0.001, decay: 1.4, release: 0.2 },
    harmonicity: 4.1,
    modulationIndex: 32,
    resonance: 4000,
    octaves: 1.5,
    volume: 2,
  }).connect(masterGain);

  // ── Musical Data ─────────────────────────────────────────────────────────────
  // A minor 9 scale / pentatonic blend for a modern atmospheric feel
  const scale = ["A3", "B3", "C4", "E4", "G4", "A4", "B4", "C5", "E5", "G5", "A5", "C6", "E6"];
  const bassNotes = ["A1", "F1", "D1", "G1"];
  const chords = [
    ["A3", "C4", "E4", "G4"], // Am7
    ["F3", "A3", "C4", "E4"], // Fmaj7
    ["D3", "F3", "A3", "C4"], // Dm7
    ["G3", "B3", "D4", "F4"]  // G7
  ];
  
  let eventQueue: WikiEditEvent[] = [];
  let density = 0;
  let tickCount = 0;
  let chordIndex = 0;
  
  let lastSmallEditTime = 0;
  
  // ── Generative Transport Loop ────────────────────────────────────────────────
  const rhythmLoop = new Tone.Loop((time) => {
    // Density decays over time
    density = Math.max(0, density * 0.95);
    
    // Auto-adjust BPM based on density (80 to 130)
    // Directly setting the value prevents overlapping rampTo schedule errors
    const targetBpm = 80 + Math.min(density * 1.5, 50);
    Tone.Transport.bpm.value = targetBpm;

    tickCount++;
    
    // Change underlying harmony every 32 ticks
    if (tickCount % 32 === 0) {
      chordIndex = (chordIndex + 1) % chords.length;
    }
    
    // Bass pulse on the 1 (every 16 ticks if 16n loop)
    if (tickCount % 16 === 0 || (density > 20 && tickCount % 8 === 0 && Math.random() > 0.5)) {
      if (density > 5) {
        const bassNote = bassNotes[chordIndex];
        bassSynth.triggerAttackRelease(bassNote, "8n", time + 0.01);
      }
    }

    // Process queued edits synchronously to the beat
    if (eventQueue.length > 0) {
      // Process up to 3 events per 16th note to prevent overwhelming
      const toProcess = Math.min(eventQueue.length, 3);
      for (let i = 0; i < toProcess; i++) {
        const event = eventQueue.shift()!;
        
        // Debounce TINY and SMALL edits to reduce noise
        if (event.magnitude === "TINY" || event.magnitude === "SMALL") {
           // only allow 1 small edit per 0.15 seconds of Transport time
           if (time - lastSmallEditTime < 0.15) {
             continue; // Skip this small edit
           }
           lastSmallEditTime = time;
        }

        const energy = Math.min(1, Math.log10(Math.abs(event.sizeDelta) + 10) / 4);
        
        // Add a small offset to prevent multiple triggers at the exact same time
        const t = time + (i * 0.04);
        
        if (event.isRevert) {
          revertSynth.triggerAttackRelease("1n", t, 0.6 + energy * 0.4);
        } else if (event.isBot) {
          botSynth.triggerAttackRelease(scale[Math.floor(Math.random() * 5)], "8n", t, 0.4 + energy * 0.4);
        } else {
          // Play chords for large edits
          if (event.magnitude === "LARGE") {
            const chord = chords[chordIndex];
            chordSynth.triggerAttackRelease(chord, "2n", t, 0.5 + energy * 0.3);
          } else {
            // Pick a note from the scale biased by the current chord
            const noteOffset = Math.floor(Math.random() * 4);
            const baseNote = chords[chordIndex][noteOffset] || scale[0];
            // Transpose up one octave
            const playNote = baseNote.replace(/(\d)/, (match) => String(parseInt(match) + 1));
            editSynth.triggerAttackRelease(playNote, "16n", t, 0.3 + energy * 0.4);
          }
        }
      }
    } else {
      // If idle but high density, generative arpeggiator kicks in
      if (density > 10 && Math.random() > 0.4) {
        const arpNote = chords[chordIndex][Math.floor(Math.random() * 4)];
        arpSynth.triggerAttackRelease(arpNote, "16n", time + 0.02, 0.15 + (density / 100));
      }
    }
  }, "16n");

  function triggerEdit(event: WikiEditEvent) {
    if (!initialized) return;
    density += 1;
    eventQueue.push(event);
    
    // Keep queue manageable
    if (eventQueue.length > 50) {
      eventQueue.shift();
    }
  }

  // Analyzers
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
    rhythmLoop.dispose();
    Tone.Transport.stop();
    
    arpSynth.dispose();
    bassSynth.dispose();
    chordSynth.dispose();
    editSynth.dispose();
    botSynth.dispose();
    revertSynth.dispose();
    
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
      Tone.Transport.bpm.value = 80;
      Tone.Transport.start();
      rhythmLoop.start(0);
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
