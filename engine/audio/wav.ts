/**
 * 32-bit float stereo WAV writer. Spec §13.3.
 *
 * The `audio:check` artefacts exist so a *human* can listen to what the mix
 * actually sounds like. 32-bit float rather than 16-bit PCM is deliberate: the
 * soft clipper's whole point is to shape near-full-scale detail, and 16-bit
 * quantisation would erase the difference between a mix at −2 dBFS and one at
 * −1 dBFS — exactly the range the thresholds live in.
 */

export interface WavData {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
}

/** Interleave to the WAV channel order (L, R, L, R, …). */
export function interleave(left: Float32Array, right: Float32Array): Float32Array {
  const n = Math.min(left.length, right.length);
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    out[i * 2] = left[i]!;
    out[i * 2 + 1] = right[i]!;
  }
  return out;
}

/**
 * Encode 32-bit float stereo WAV (format tag 3).
 *
 * The data chunk is *not* padded: 32-bit samples are already word-aligned, and
 * adding a pad byte would make strict decoders reject the file.
 */
export function encodeWav(data: WavData): Uint8Array {
  const frames = Math.min(data.left.length, data.right.length);
  const interleaved = interleave(data.left, data.right);
  const dataBytes = frames * 2 * 4;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const ascii = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true); // chunk size
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 3, true); // WAVE_FORMAT_IEEE_FLOAT
  view.setUint16(22, 2, true); // stereo
  view.setUint32(24, data.sampleRate, true);
  view.setUint32(28, data.sampleRate * 2 * 4, true); // byte rate
  view.setUint16(32, 2 * 4, true); // block align
  view.setUint16(34, 32, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);

  const out = new Uint8Array(buffer);
  // Float samples must be written as little-endian IEEE-754, which is what
  // every platform's typed-array view gives us here.
  new Uint8Array(out.buffer, 44).set(new Uint8Array(interleaved.buffer, 0, dataBytes));
  return out;
}
