/**
 * Is `equalpower`'s azimuth INVERTED relative to `HRTF`?
 *
 * The elevation probe showed, for a source at +X with the listener facing -Z:
 *   HRTF        -> right channel (L/R level diff -11 dB, i.e. R louder)
 *   equalpower  -> L/R level diff -324 dB, i.e. the RIGHT channel is SILENT
 *
 * That would mean the **low tier** (which the spec assigns `equalpower`) pans
 * everything to the wrong side — and the low tier is exactly phones and low-end
 * devices.
 *
 * Measured directly, with a signal that is unambiguous.
 */
import { chromium } from "@playwright/test";

const main = async (): Promise<void> => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  for (const model of ["HRTF", "equalpower"]) {
    console.log(`\n=== ${model} ===`);
    for (const [name, pos] of [
      ["+X (right of the listener)", [10, 0, 0]],
      ["-X (left of the listener)", [-10, 0, 0]],
      ["+Z (behind the listener)", [0, 0, 10]],
      ["-Z (in front of the listener)", [0, 0, -10]],
    ] as Array<[string, [number, number, number]]>) {
      const r = (await page.evaluate(
        `(() => {
        const ctx = new OfflineAudioContext(2, 44100, 44100);
        const L = ctx.listener;
        const p = [0,0,0], f = [0,0,-1];
        if (L.positionX) {
          L.positionX.setValueAtTime(0, 0);
          L.positionY.setValueAtTime(0, 0);
          L.positionZ.setValueAtTime(0, 0);
          L.forwardX.setValueAtTime(0, 0);
          L.forwardY.setValueAtTime(0, 0);
          L.forwardZ.setValueAtTime(-1, 0);
          L.upX.setValueAtTime(0, 0);
          L.upY.setValueAtTime(1, 0);
          L.upZ.setValueAtTime(0, 0);
        } else {
          L.setPosition(0, 0, 0);
          L.setOrientation(0, 0, -1, 0, 1, 0);
        }
        const osc = ctx.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.value = 300;
        const pan = ctx.createPanner();
        pan.panningModel = "${model}";
        pan.positionX.value = ${pos[0]};
        pan.positionY.value = ${pos[1]};
        pan.positionZ.value = ${pos[2]};
        osc.connect(pan); pan.connect(ctx.destination);
        osc.start(0); osc.stop(1);
        return ctx.startRendering().then((buf) => {
          const l = buf.getChannelData(0), r = buf.getChannelData(1);
          let sl = 0, sr = 0;
          for (let i = 0; i < l.length; i++) { sl += l[i]*l[i]; sr += r[i]*r[i]; }
          return { rmsL: Math.sqrt(sl/l.length), rmsR: Math.sqrt(sr/r.length) };
        });
      })()`,
      )) as { rmsL: number; rmsR: number };
      const db = (v: number): number => (v > 0 ? 20 * Math.log10(v) : -999);
      const diff = db(r.rmsL) - db(r.rmsR);
      const side =
        Math.abs(diff) > 40
          ? "one channel SILENT"
          : diff > 3
            ? "LEFT"
            : diff < -3
              ? "RIGHT"
              : "CENTRED";
      console.log(
        `  ${name.padEnd(26)} L=${db(r.rmsL).toFixed(1)} dB  R=${db(r.rmsR).toFixed(1)} dB  ` +
          `diff=${diff.toFixed(1)} dB  -> ${side}`,
      );
    }
  }
  await browser.close();
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
