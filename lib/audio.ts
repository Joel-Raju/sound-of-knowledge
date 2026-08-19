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

  // ── Master chain: one long lush reverb is the ambient signature ──────────────
  // signal → EQ3 (smile curve) → Reverb (long) → Limiter → destination
  // Analyzers tap the pre-limiter bus so visuals track the true mix.
  const limiter = new Tone.Limiter(-2).toDestination();
  const reverb = new Tone.Reverb({ decay: 16, wet: 0.55, preDelay: 0.02 }).connect(limiter);
  const eq = new Tone.EQ3({ low: 1, mid: -1, high: 1.5 }).connect(reverb);

  const masterGain = new Tone.Gain(0.7).connect(eq);
  masterGain.connect(masterAnalyser);
  masterGain.connect(fftAnalyser);

  // ── Pad bed: the slow, ever-present atmosphere ───────────────────────────────
  const padFilter = new Tone.Filter({ frequency: 900, type: "lowpass", rolloff: -12, Q: 0.4 });
  padFilter.connect(masterGain);

  const padSynth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "fatsine", count: 3, spread: 14 },
    envelope: { attack: 3.0, decay: 1.0, sustain: 0.7, release: 10 },
    volume: -10,
  });
  padSynth.maxPolyphony = 8;
  padSynth.connect(padFilter);

  // Slow filter LFO — the bed breathes even with no edits
  const padLFO = new Tone.LFO({ frequency: 0.06, min: 500, max: 1500 });
  padLFO.connect(padFilter.frequency);

  // ── Bells: soft FM chimes for small/medium edits (pentatonic = always consonant) ──
  const bellSynth = new Tone.PolySynth(Tone.FMSynth, {
    harmonicity: 1.0,
    modulationIndex: 2,
    oscillator: { type: "sine" },
    envelope: { attack: 0.01, decay: 1.4, sustain: 0, release: 4.5 },
    modulation: { type: "sine" },
    modulationEnvelope: { attack: 0.01, decay: 0.5, sustain: 0.1, release: 2 },
    volume: -8,
  });
  bellSynth.maxPolyphony = 12;
  bellSynth.connect(masterGain);

  // ── Sub swell: felt more than heard, for large edits ─────────────────────────
  const subSynth = new Tone.MonoSynth({
    oscillator: { type: "sine" },
    envelope: { attack: 0.8, decay: 0.5, sustain: 0.6, release: 8 },
    filterEnvelope: { attack: 0.8, decay: 1.0, sustain: 0.5, baseFrequency: 80, octaves: 1.5 },
    volume: -6,
  }).connect(masterGain);

  // ── Pluck: gentle soft plucked string for bot edits ──────────────────────────
  const pluckSynth = new Tone.PluckSynth({
    attackNoise: 0.6,
    dampening: 4200,
    resonance: 0.9,
    volume: -12,
  }).connect(masterGain);

  // ── Revert swell: a soft, low "sinking" tone (undoing) ───────────────────────
  const revertFilter = new Tone.Filter({ frequency: 700, type: "lowpass", rolloff: -12, Q: 0.6 });
  revertFilter.connect(masterGain);
  const revertSynth = new Tone.MonoSynth({
    oscillator: { type: "triangle" },
    envelope: { attack: 1.2, decay: 0.8, sustain: 0.4, release: 7 },
    volume: -7,
  }).connect(revertFilter);

  // ── Musical data ─────────────────────────────────────────────────────────────
  // Modal centers for the pad (root + fifth — open, consonant, no thirds)
  const modalCenters = [
    ["C2", "G2", "D3"],
    ["F2", "C3", "G3"],
    ["D2", "A2", "E3"],
    ["G2", "D3", "A3"],
  ];

  // Pentatonic bell pool across higher octaves — any note combos are consonant
  const bellNotes = [
    "C4", "D4", "E4", "G4", "A4",
    "C5", "D5", "E5", "G5", "A5",
    "C6", "D6", "E6",
  ];
  // Sub roots (one octave below pad root)
  const subRoots = ["C1", "F1", "D1", "G1"];
  // Pluck pitches for bots (mid, soft)
  const pluckPitches = ["C4", "E4", "G4", "A4", "D4"];
  // Revert pitches (low, following modal root)
  const revertPitches = ["C2", "F2", "D2", "G2"];

  const eventQueue: WikiEditEvent[] = [];
  let density = 0;
  let tickCount = 0;
  let chordIndex = 0;
  let lastBellTime = 0;

  // ── Generative transport ─────────────────────────────────────────────────────
  const rhythmLoop = new Tone.Loop((time) => {
    density = Math.max(0, density * 0.94);
    Tone.Transport.bpm.value = 60;
    tickCount++;

    // Change modal center every 32 ticks (~32s) — slow harmonic evolution
    if (tickCount % 32 === 0) {
      chordIndex = (chordIndex + 1) % modalCenters.length;
    }

    // Pad bed: retrigger every 8 ticks with long release → continuous overlap
    if (tickCount % 8 === 0) {
      const chord = modalCenters[chordIndex];
      padSynth.triggerAttackRelease(chord, "1m", time, 0.35);
    }

    // Process queued edits — sparse, let notes breathe
    if (eventQueue.length > 0) {
      const maxNotes = density > 12 ? 2 : 1;
      const toProcess = Math.min(eventQueue.length, maxNotes);
      for (let i = 0; i < toProcess; i++) {
        const event = eventQueue.shift()!;
        const t = time + i * 0.12;
        const energy = Math.min(1, Math.log10(Math.abs(event.sizeDelta) + 10) / 5);

        if (event.isRevert) {
          // Soft sinking swell: low tone with a gently closing lowpass
          revertFilter.frequency.cancelScheduledValues(time);
          revertFilter.frequency.setValueAtTime(800, time);
          revertFilter.frequency.rampTo(220, 3.0, time);
          revertSynth.triggerAttackRelease(revertPitches[chordIndex], "2n", t, 0.5 + energy * 0.3);
        } else if (event.isBot) {
          // Gentle soft pluck — unobtrusive (PluckSynth has no velocity param;
          // loudness is set on the synth volume)
          const note = pluckPitches[Math.floor(Math.random() * pluckPitches.length)];
          pluckSynth.triggerAttack(note, t);
        } else if (event.magnitude === "LARGE") {
          // Felt sub swell (no harsh Shepard); plus a single high bell accent
          subSynth.triggerAttackRelease(subRoots[chordIndex], "1n", t, 0.6 + energy * 0.3);
          const accent = bellNotes[bellNotes.length - 1];
          bellSynth.triggerAttackRelease(accent, "2n", t + 0.15, 0.25);
        } else {
          // Small/medium edits: soft pentatonic bells, throttled for spaciousness
          if (t - lastBellTime < 0.5) continue;
          lastBellTime = t;
          // Higher octave for smaller edits, lower for medium
          const pool = event.magnitude === "MEDIUM" ? bellNotes.slice(0, 8) : bellNotes.slice(5);
          const note = pool[Math.floor(Math.random() * pool.length)];
          bellSynth.triggerAttackRelease(note, "4n", t, 0.4 + energy * 0.25);
        }
      }
    } else if (density > 4 && Math.random() > 0.9) {
      // Idle: a very occasional, soft high bell riding the pad tail
      const note = bellNotes[bellNotes.length - 1 - Math.floor(Math.random() * 3)];
      bellSynth.triggerAttackRelease(note, "4n", time + 0.05, 0.2);
    }
  }, "4n");

  function triggerEdit(event: WikiEditEvent) {
    if (!initialized) return;
    const energy = Math.min(1, Math.log10(Math.abs(event.sizeDelta) + 10) / 5);
    density += 0.5 + energy;
    eventQueue.push(event);
    if (eventQueue.length > 50) eventQueue.shift();
  }

  // ── Analyzers (sane scaling so visuals actually respond) ─────────────────────
  function getAmplitude(): number {
    const buf = masterAnalyser.getValue() as Float32Array;
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    return Math.min(1, Math.tanh(rms * 8));
  }

  function getLowFreq(): number {
    const buf = fftAnalyser.getValue() as Float32Array;
    const slice = buf.slice(0, 8);
    let sum = 0;
    for (let i = 0; i < slice.length; i++) sum += Math.max(0, (slice[i] + 140) / 140);
    return Math.min(1, sum / slice.length);
  }

  function getHighFreq(): number {
    const buf = fftAnalyser.getValue() as Float32Array;
    const slice = buf.slice(buf.length - 16);
    let sum = 0;
    for (let i = 0; i < slice.length; i++) sum += Math.max(0, (slice[i] + 140) / 140);
    return Math.min(1, sum / slice.length);
  }

  function dispose() {
    rhythmLoop.dispose();
    padLFO.dispose();
    Tone.Transport.stop();

    padSynth.dispose();
    padFilter.dispose();
    bellSynth.dispose();
    subSynth.dispose();
    pluckSynth.dispose();
    revertSynth.dispose();
    revertFilter.dispose();

    masterGain.dispose();
    eq.dispose();
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
      padLFO.start(0);
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
