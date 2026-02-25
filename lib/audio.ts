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
  const reverb = new Tone.Reverb({ decay: 12, wet: 0.35, preDelay: 0.25 }).connect(limiter);
  const delay = new Tone.PingPongDelay({ delayTime: "4n", feedback: 0.35, wet: 0.18 }).connect(reverb);
  
  // Stereo widening
  const stereoWidener = new Tone.StereoWidener(0.5).connect(delay);
  
  // Multiband-style processing: high-pass to remove mud, then gentle compression
  const highPass = new Tone.Filter(80, "highpass").connect(stereoWidener);
  
  const sidechainComp = new Tone.Compressor({
    threshold: -12,
    ratio: 2.5,
    attack: 0.02,
    release: 0.3,
    knee: 6
  }).connect(highPass);
  
  const chorus = new Tone.Chorus({ frequency: 0.3, delayTime: 3, depth: 0.4, wet: 0.2 }).connect(sidechainComp);
  
  // Cut the mud (300Hz), boost clarity (3kHz), gentle low shelf
  const eq = new Tone.EQ3({ low: 2, mid: -2, high: 3 }).connect(chorus);
  
  const masterGain = new Tone.Gain(4.5).connect(eq);
  masterGain.connect(masterAnalyser);
  masterGain.connect(fftAnalyser);

  // ── Synths ───────────────────────────────────────────────────────────────────
  // Sweet organ pad
  const organSynth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { 
      type: "fatsine",
      count: 4,
      spread: 18
    },
    envelope: { attack: 1.5, decay: 0.8, sustain: 0.6, release: 8 },
    volume: 6,
  });
  organSynth.maxPolyphony = 8;
  organSynth.connect(masterGain);
  
  // Gentle lowpass for warmth without mud
  const organFilter = new Tone.Filter({
    frequency: 1800,
    type: "lowpass",
    rolloff: -12,
    Q: 0.5
  });
  organSynth.disconnect();
  organSynth.connect(organFilter);
  organFilter.connect(masterGain);

  // Deep bass - clean sine
  const bassSynth = new Tone.MonoSynth({
    oscillator: { type: "sine" },
    envelope: { attack: 0.01, decay: 0.3, sustain: 0.4, release: 4 },
    volume: 6,
  }).connect(masterGain);

  // Sub-bass layer
  const subBassSynth = new Tone.MonoSynth({
    oscillator: { type: "sine" },
    envelope: { attack: 0.05, decay: 0.4, sustain: 0.5, release: 5 },
    volume: 4,
  }).connect(masterGain);

  // Lush pad for large edits
  const padSynth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { 
      type: "fatsine",
      count: 2,
      spread: 8
    },
    envelope: { attack: 2.0, decay: 1.0, sustain: 0.5, release: 8 },
    volume: 0,
  });
  padSynth.maxPolyphony = 6;
  padSynth.connect(masterGain);

  // Sparkly high bell for small edits
  const editSynth = new Tone.PolySynth(Tone.FMSynth, {
    harmonicity: 2.0,
    modulationIndex: 2,
    oscillator: { type: "sine" },
    envelope: { attack: 0.005, decay: 0.5, sustain: 0, release: 2 },
    volume: 5,
  });
  editSynth.maxPolyphony = 12;
  editSynth.connect(masterGain);

  // Percussive synth for bot edits
  const botSynth = new Tone.MembraneSynth({
    pitchDecay: 0.02,
    octaves: 2,
    oscillator: { type: "sine" },
    envelope: { attack: 0.001, decay: 0.15, sustain: 0, release: 0.4 },
    volume: 6,
  }).connect(masterGain);

  // Low gong for reverts
  const revertSynth = new Tone.MetalSynth({
    envelope: { attack: 0.001, decay: 2.0, release: 0.5 },
    harmonicity: 2.0,
    modulationIndex: 10,
    resonance: 800,
    octaves: 1.0,
    volume: 7,
  }).connect(masterGain);

  // ── Musical Data ─────────────────────────────────────────────────────────────
  // Modal harmony: Open 5ths and clusters for that Interstellar organ sound
  // No 3rds - just roots, 5ths, and color tones (2nds/9ths)
  const modalCenters = [
    ["A2", "E3", "B3", "D4"],      // Lydian-ish: A-E-B-D (root, 5th, 9th, 4th)
    ["F2", "C3", "G3", "A3"],      // Lydian: F-C-G-A (root, 5th, 9th, 3rd)
    ["D2", "A2", "E3", "F#3"],     // Lydian: D-A-E-F# (root, 5th, 9th, #4)
    ["G2", "D3", "A3", "B3"],      // Mixolydian-ish: G-D-A-B (root, 5th, 9th, 3rd)
  ];
  
  // Shepard tone layers - same note class across octaves
  const shepardLayers = ["A1", "A2", "A3", "A4", "A5"];
  
  // Bass roots for heartbeat
  const bassRoots = ["A1", "F1", "D1", "G1"];
  
  let eventQueue: WikiEditEvent[] = [];
  let density = 0;
  let tickCount = 0;
  let chordIndex = 0;
  
  let lastSmallEditTime = 0;
  
  // ── Generative Transport Loop ────────────────────────────────────────────────
  const rhythmLoop = new Tone.Loop((time) => {
    // Density decays slowly for sustained atmosphere
    density = Math.max(0, density * 0.92);
    
    // Slow tempo: 60 BPM constant, no ramping
    const targetBpm = 60;
    Tone.Transport.bpm.value = targetBpm;

    tickCount++;
    
    // Change modal center every 16 bars (64 quarter notes = 256 16ths at 60bpm)
    if (tickCount % 256 === 0) {
      chordIndex = (chordIndex + 1) % modalCenters.length;
      // Trigger organ pad on harmonic shift
      const chord = modalCenters[chordIndex];
      organSynth.triggerAttackRelease(chord, "1m", time, 0.7);
    }
    
    // Heartbeat bass on every beat (quarter notes at 60bpm = 1Hz)
    // Double time when density is high
    const beatInterval = density > 15 ? 2 : 4;
    if (tickCount % beatInterval === 0) {
      const bassNote = bassRoots[chordIndex];
      bassSynth.triggerAttackRelease(bassNote, "2n", time, 0.8 + Math.min(density / 20, 0.2));
      
      // Sub-bass layer for weight
      const subNote = bassNote.replace(/(\d)/, (match) => String(parseInt(match) - 1));
      subBassSynth.triggerAttackRelease(subNote, "1n", time, 0.5);
      
      // Filter opens with density
      organFilter.frequency.rampTo(600 + density * 100, 0.5, time);
    }

    // Process queued edits
    if (eventQueue.length > 0) {
      const toProcess = Math.min(eventQueue.length, 2); // Limit for spaciousness
      for (let i = 0; i < toProcess; i++) {
        const event = eventQueue.shift()!;
        
        if (event.magnitude === "TINY" || event.magnitude === "SMALL") {
           if (time - lastSmallEditTime < 0.25) continue;
           lastSmallEditTime = time;
        }

        const energy = Math.min(1, Math.log10(Math.abs(event.sizeDelta) + 10) / 5);
        const t = time + (i * 0.08);
        
        if (event.isRevert) {
          revertSynth.triggerAttackRelease("1n", t, 0.7 + energy * 0.3);
        } else if (event.isBot) {
          botSynth.triggerAttackRelease(bassRoots[0], "8n", t, 0.6 + energy * 0.3);
        } else {
          if (event.magnitude === "LARGE") {
            // Shepard tone effect: trigger multiple octaves
            const baseChord = modalCenters[chordIndex];
            const rootNote = baseChord[0];
            const rootClass = rootNote.replace(/\d/, '');
            
            // Build shepard layers
            const shepardChord = [
              rootClass + "1",
              rootClass + "2", 
              rootClass + "3",
              rootClass + "4"
            ];
            
            // Trigger with staggered envelopes for "infinite rising" illusion
   
            padSynth.triggerAttackRelease(shepardChord, "2n", t, 0.7 + energy * 0.2);
            
            // Add high sparkle
            editSynth.triggerAttackRelease(rootClass + "5", "8n", t + 0.1, 0.6);
          } else {
            // Small edits: single notes from the modal center
            const modalChord = modalCenters[chordIndex];
            const note = modalChord[Math.floor(Math.random() * modalChord.length)];
            // Transpose up an octave for airiness
            const highNote = note.replace(/(\d)/, (match) => String(parseInt(match) + 1));
            editSynth.triggerAttackRelease(highNote, "4n", t, 0.6 + energy * 0.2);
          }
        }
      }
    } else {
      // Idle generative: occasional high bell
      if (density > 5 && Math.random() > 0.85) {
        const modalChord = modalCenters[chordIndex];
        const note = modalChord[Math.floor(Math.random() * modalChord.length)];
        const highNote = note.replace(/(\d)/, (match) => String(parseInt(match) + 2));
        editSynth.triggerAttackRelease(highNote, "4n", time + 0.05, 0.4);
      }
    }
  }, "4n");

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
    
    organSynth.dispose();
    organFilter.dispose();
    bassSynth.dispose();
    subBassSynth.dispose();
    padSynth.dispose();
    editSynth.dispose();
    botSynth.dispose();
    revertSynth.dispose();
    
    masterGain.dispose();
    eq.dispose();
    chorus.dispose();
    sidechainComp.dispose();
    highPass.dispose();
    stereoWidener.dispose();
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
      Tone.Transport.bpm.value = 60;
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
