/**
 * Does "ABOVE" produce a different signal from "FRONT"?
 *
 * The human hears left/right separation but "not much with above and below". Two
 * possible causes, and they are very different:
 *
 *  1. **The engine produces nothing different.** Then elevation is genuinely absent
 *     and the feature does not exist.
 *  2. **The engine produces something different that stereo cannot convey.** Then the
 *     feature exists and the *medium* cannot express it.
 *
 * The difference matters: (1) is a bug and (2) is a fact about two-channel audio.
 *
 * A source directly ahead and a source directly overhead have nearly the same
 * **azimuth** in the listener's frame, and in a 2-channel file only azimuth produces an
 * interaural level difference. Front/back and elevation are not separable in stereo —
 * that is a property of the medium, not of the code.
 *
 * So this compares the rendered signals themselves: are ABOVE and FRONT the same
 * waveform?
 */
import { chromium } from "@playwright/test";

const main = async (): Promise<void> => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const render = async (
    model: string,
    pos: [number, number, number],
    wave: "sine" | "noise" | "saw" | "bell",
  ): Promise<Float32Array[]> => {
    const res = (await page.evaluate(
      `(() => {
        const ctx = new OfflineAudioContext(2, 44100, 44100);
        const L = ctx.listener;
        const p = [0,0,0], f = [0,0,-1];
        if (L.positionX) {
          L.positionX.setValueAtTime(p[0], 0);
          L.positionY.setValueAtTime(p[1], 0);
          L.positionZ.setValueAtTime(p[2], 0);
          L.forwardX.setValueAtTime(f[0], 0);
          L.forwardY.setValueAtTime(f[1], 0);
          L.forwardZ.setValueAtTime(f[2], 0);
          L.upX.setValueAtTime(0, 0);
          L.upY.setValueAtTime(1, 0);
          L.upZ.setValueAtTime(0, 0);
        } else {
          L.setPosition(p[0], p[1], p[2]);
          L.setOrientation(f[0], f[1], f[2], 0, 1, 0);
        }
        const src = ctx.createBufferSource();
        const len = 44100;
        const buf = ctx.createBuffer(1, len, 44100);
        const ch = buf.getChannelData(0);
        if ("${wave}" === "noise") {
          for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
        } else if ("${wave}" === "saw") {
          for (let i = 0; i < len; i++) ch[i] = (((i * 440) % 44100) / 44100) * 2 - 1;
        } else if ("${wave}" === "bell") {
          // A bell-like tone: a harmonic stack with a long exponential decay, which is
          // what §7's plucks and bells actually sound like. HRTF's elevation cue is
          // spectral, so a signal with content to shape is the fair test.
          const parts = [1, 2.0, 2.76, 5.4, 8.93];
          for (let i = 0; i < len; i++) {
            const t = i / 44100;
            const env = Math.exp(-t * 2.2);
            let v = 0;
            for (let k = 0; k < parts.length; k++) {
              v += (Math.sin(2 * Math.PI * 440 * parts[k] * t) / (k + 1.6));
            }
            ch[i] = v * env * 0.2;
          }
        } else {
          for (let i = 0; i < len; i++) ch[i] = Math.sin((2 * Math.PI * 440 * i) / 44100);
        }
        src.buffer = buf;
        const pan = ctx.createPanner();
        pan.panningModel = "${model}";
        pan.positionX.value = ${pos[0]};
        pan.positionY.value = ${pos[1]};
        pan.positionZ.value = ${pos[2]};
        src.connect(pan); pan.connect(ctx.destination);
        src.start(0);
        return ctx.startRendering().then((buf2) => {
          return { l: Array.from(buf2.getChannelData(0)), r: Array.from(buf2.getChannelData(1)) };
        });
      })()`,
    )) as { l: number[]; r: number[] };
    return [Float32Array.from(res.l), Float32Array.from(res.r)];
  };

  /** Normalised cross-correlation of two signals. 1 = identical. */
  const corr = (a: Float32Array, b: Float32Array): number => {
    let num = 0;
    let da = 0;
    let db = 0;
    for (let i = 0; i < a.length; i++) {
      num += a[i]! * b[i]!;
      da += a[i]! * a[i]!;
      db += b[i]! * b[i]!;
    }
    return num / (Math.sqrt(da) * Math.sqrt(db) || 1);
  };

  const rms = (a: Float32Array): number => {
    let s = 0;
    for (const v of a) s += v * v;
    return Math.sqrt(s / a.length);
  };
  const db = (v: number): number => (v > 0 ? 20 * Math.log10(v) : -999);

  for (const wave of ["sine", "saw", "bell"] as const) {
    for (const model of ["HRTF", "equalpower"]) {
      console.log(`\n=== ${model}, source = ${wave} ===`);
      const front = await render(model, [0, 0, -10], wave);
      const above = await render(model, [0, 10, 0], wave);
      const below = await render(model, [0, -10, 0], wave);
      const right = await render(model, [10, 0, 0], wave);

      const cases: Array<[string, Float32Array[], Float32Array[]]> = [
        ["ABOVE vs FRONT", above, front],
        ["BELOW vs FRONT", below, front],
        ["RIGHT vs FRONT", right, front],
      ];
      for (const [name, x, f] of cases) {
        console.log(
          `  ${name.padEnd(16)} corr(L)=${corr(x[0]!, f[0]!).toFixed(4)}  ` +
            `corr(R)=${corr(x[1]!, f[1]!).toFixed(4)}  ` +
            `L/R level diff=${db(rms(x[0]!)) - db(rms(x[1]!))} dB`,
        );
      }
    }
  }
  await browser.close();
};

/**
 * Goertzel algorithm — the magnitude of one frequency in a signal. Clean and cheap, and
 * it needs no FFT implementation.
 */
const _goertzel = (sig: Float32Array, freq: number): number => {
  const n = Math.min(sig.length, 44100);
  const w = (2 * Math.PI * freq) / 44100;
  const coeff = 2 * Math.cos(w);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    s0 = sig[i]! + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / n;
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
