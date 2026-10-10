# Tuning — Sound of Knowledge v2

> Every number below points at a named constant in `engine/config.ts`
> (spec §1.1.9) — no magic numbers in feature code. Section A/B/C were
> finalised in **T3.5**; section D in **T6.3**.

## How to tune

1. Change the named constant in `engine/config.ts`.
2. Re-run the verification harness: `npm run audio:check` (audio) or
   `npm run test:e2e` (visual).
3. Record the change and its measured effect below.
4. Listen/look — if the change is audible or visible, add it to
   `docs/HUMAN-CHECKLIST.md` for confirmation.

## A. Musical constants (spec §7.1)

| Constant           | Value           | Effect                                                                            |
| ------------------ | --------------- | --------------------------------------------------------------------------------- |
| `BPM`              | 68              | Grid speed; all rhythmic feel                                                     |
| `STEP_SEC`         | 0.2206 s        | 16th-note length at 68 BPM                                                        |
| Chord length       | 4 bars ≈ 14.1 s | Harmony drift rate                                                                |
| Key change cadence | 32 bars ≈ 113 s | How often the key walks                                                           |
| `EPS_REF`          | 15              | Calibrated at T1.1 against a real 180 s capture (post-normalise p95 ≈ 10 edits/s) |
| `BOT_REF`          | 8               | Bot-energy normalisation                                                          |

## B. Voice gains (spec §8.6) — tuned at T3.5

| Voice | Spec gain | Final | Notes                                                                                                |
| ----- | --------- | ----- | ---------------------------------------------------------------------------------------------------- |
| bell  | 0.30      | 0.30  | Unchanged — the melody must stay audible above the pad bed                                           |
| pluck | 0.35      | 0.26  | −2.6 dB. 98 pluck notes per 30 s made it the mid-band majority (97 % of note energy is 250 Hz–2 kHz) |
| sub   | 0.55      | 0.55  | Unchanged — the only _musical_ source of the 20–80 Hz band                                           |
| gong  | 0.12      | 0.12  | Unchanged                                                                                            |
| thud  | 0.80      | 0.80  | Unchanged                                                                                            |
| tick  | 0.25      | 0.25  | Unchanged                                                                                            |

**Voice slot lifetime — `MELODIC_DUR_TAU`: spec §8.6 `dur = 5τ`, final `3.5`.**
At `5τ` the residual tail is `e⁻⁵` = 0.7 % (−43 dBFS), yet the slot stayed held for
the whole duration — a silent tail blocking a live voice. `3.5τ` leaves the
envelope at 3 %, below the continuous pad, and cut the E 0.9 drop rate from
42.7 % to 38.3 %. See `DECISIONS.md` (T3.5).

## C. Mix chain (spec §8.3, §8.7) — tuned at T3.5

| Node                 | Spec            | Final  | Notes                                                                                         |
| -------------------- | --------------- | ------ | --------------------------------------------------------------------------------------------- |
| `REVERB_SEND`        | 0.30            | 0.30   | Unchanged — tested 0.10; moved `mid` by < 1 point                                             |
| `DELAY_SEND`         | 0.12            | 0.12   | Unchanged                                                                                     |
| `PAD_REVERB_SEND`    | 0.45            | 0.45   | Unchanged                                                                                     |
| compressor threshold | −10 dB          | −10 dB | Unchanged                                                                                     |
| `MASTER_BASE_GAIN`   | `0.9 × volume²` | 0.9    | Unchanged; default `volume` lowered 0.8 → 0.7 instead (§8.7 fixes the taper, not the default) |
| pad duck depth       | 0.65            | 0.65   | Unchanged                                                                                     |

### Continuous layers (spec §8.8) — the big changes

| Constant           | Spec  | Final | Notes                                                              |
| ------------------ | ----- | ----- | ------------------------------------------------------------------ |
| `PAD_OSC_SAW_GAIN` | 0.030 | 0.028 | Near-spec; the pad had to give up bass, which was the failing band |
| `PAD_OSC_TRI_GAIN` | 0.040 | 0.038 | Near-spec                                                          |
| `DRONE_SUB_GAIN`   | 0.100 | 0.060 | −4.4 dB. Owned 47 % of the mix's sub band on its own               |
| `DRONE_ROOT_GAIN`  | 0.040 | 0.024 | −4.4 dB. 130–246 Hz, the main bass contributor                     |
| `AIR_GAIN_MIN`     | 0.004 | 0.30  | **+37 dB** — see below                                             |
| `AIR_GAIN_MAX`     | 0.020 | 0.55  | **+29 dB**, and the energy curve flattened from 5× to 1.8×         |

**Why air had to change so much.** The spectrum was measured directly
(`scripts/probe-bands.ts` renders the mix with layers isolated). Findings:

- The **notes alone** are 97.5 % mid-band. Plucks span midi 64–88 (329–1308 Hz)
  and bells start at midi 76 (659 Hz), so essentially every melodic note lands
  in 250–2000 Hz.
- The **pad** is lowpassed at `500 + 2800·E` ≈ 2.2 kHz at E 0.6. A sawtooth's
  20th partial at that cutoff is ≈ −26 dB, so raising the cutoff to 5 kHz moved
  the high band by 0.3 points — there was nothing up there to reveal.
- Therefore the **air layer is the only source of 2–8 kHz energy**, exactly as
  §8.8 intends. At the spec's level it contributed 0.01 of the mix's power.
  Reaching §8.4's 5–25 % high band required roughly 20× its gain. `AIR_GAIN_MIN`
  is the single largest deviation in the rewrite.

The final curve is deliberately flatter than §8.8's 5× ratio: at the spec's
ratio the E 0.9 render put **30 %** of the mix above 2 kHz.

**Air level in absolute terms:** pink noise RMS is 0.196, so at E 0.6 the air
path sits ≈ 25 dB below the mix — audible as a texture, not as a hiss.

### Sub voice frequency — `SUB_MAX_PER_BAR`, `SUB_MAX_CONCURRENT`

Spec §7.7 gives 2 per bar and 3 concurrent; final **3** and **5**. With the
original values the notes carried **0.0 %** of the sub and bass bands, so §8.4's
8–30 % / 10–30 % targets had to be met by the accompaniment alone — which then
required a pad roughly 3× louder in power than the melody, inverting the
hierarchy the whole app is built on. Letting the `sub` voice carry real low
frequency is both cheaper and more musical: it is what the spec intends a "large
edit" to sound like.

### Measured mix results (§8.4 thresholds)

120 s renders, `npm run audio:check`, `rateMul` from `ε = (1 + 15)^E − 1`:

| Metric                    | Target    | E≈0.3   | E≈0.6   | E≈0.9    |
| ------------------------- | --------- | ------- | ------- | -------- |
| Peak dBFS                 | ≤ −1.0    | −7.1 ✓  | −7.6 ✓  | −7.7 ✓   |
| RMS dBFS                  | −24 … −16 | −21.8 ✓ | −21.5 ✓ | −21.6 ✓  |
| Crest dB                  | 10 … 22   | 14.7 ✓  | 13.9 ✓  | 13.9 ✓   |
| sub band share            | 8–30 %    | 29.1 ✓  | 25.7 ✓  | 24.3 ✓   |
| bass band share           | 10–30 %   | 27.9 ✓  | 23.2 ✓  | 21.1 ✓   |
| mid band share            | 25–50 %   | 34.6 ✓  | 38.6 ✓  | 38.4 ✓   |
| high band share           | 5–25 %    | 7.8 ✓   | 11.8 ✓  | 15.3 ✓   |
| air band share            | ≤ 8 %     | 0.5 ✓   | 0.7 ✓   | 0.9 ✓    |
| dropped/attempted @ E 0.9 | ≤ 35 %    | 0.0 % ✓ | 8.4 % ✓ | 31.3 % ✓ |
| clipped samples           | 0         | 0 ✓     | 0 ✓     | 0 ✓      |

Notes scheduled: 201 / 620 / 935. Peak concurrent voices 12 / 16 / 16 against a
16-slot pool. Zero `NaN`/`Infinity` in every render.

**Reproducibility.** All _decisions_ are seeded and reproduce exactly (note
times, voice counts). Measured dB values drift ~0.05 % between runs because
Chromium's offline renderer is not bit-exact — well inside every margin here,
but a report is reproducible, not identical.

### Listening notes

The three WAVs in `artifacts/audio/` are the human deliverable for this task
(120 s each, 32-bit float stereo). Per `docs/HUMAN-CHECKLIST.md` item **A1**,
the judgement that cannot be automated is whether the pad sits _under_ the
events rather than drowning them — the numbers only prove the band shares, not
the balance you hear.

## D. Performance measurements (spec §12) — recorded at T3.5, finalised at T6.3

| Budget                | Target       | Measured  |
| --------------------- | ------------ | --------- |
| DSP real-time factor  | ≥ 10×        | **10.8×** |
| Worker bundle (gzip)  | < 40 KB      | **7 KB**  |
| Worklet bundle (gzip) | < 40 KB      | **3 KB**  |
| First-load JS (gzip)  | ≤ 450 KB     | at T6.3   |
| Scheduler tick        | ≤ 1 ms       | at T2.3   |
| Ingest per batch      | ≤ 2 ms       | at T1.5   |
| Heap growth over soak | < 0.5 MB/min | at T6.3   |

## E. Visual tuning (spec §9)

Recorded at T4.2–T4.5 and T6.3.

| Parameter             | Where                  | Final |
| --------------------- | ---------------------- | ----- |
| bloom intensity       | `visual/post.ts`       | —     |
| CA kick decay τ       | `visual/post.ts`       | —     |
| grain opacity         | `visual/post.ts`       | —     |
| camera orbit yaw rate | `visual/camera-rig.ts` | —     |
| trauma decay          | `visual/camera-rig.ts` | —     |

## Deviations from spec tuning values

Full rationale in `docs/DECISIONS.md` (search "T3.5"). Summary:

| Constant               | Spec          | Final         | Reason                                                                         |
| ---------------------- | ------------- | ------------- | ------------------------------------------------------------------------------ |
| `AIR_GAIN_MIN/MAX`     | 0.004 / 0.020 | 0.30 / 0.55   | Only source of 2–8 kHz energy; spec level cannot reach §8.4's 5–25 % high band |
| `SUB_MAX_PER_BAR`      | 2             | 3             | Notes carried 0 % sub/bass at the spec value                                   |
| `SUB_MAX_CONCURRENT`   | 3             | 5             | Same                                                                           |
| `MELODIC_DUR_TAU`      | 5             | 3.5           | `5τ` holds a voice slot for an inaudible tail; 42.7 % → 38.3 % drops           |
| `VOICE_GAIN.pluck`     | 0.35          | 0.26          | Plucks were 97.5 % mid-band                                                    |
| `DRONE_SUB_GAIN`       | 0.10          | 0.060         | Owned 47 % of the sub band alone                                               |
| `DRONE_ROOT_GAIN`      | 0.04          | 0.024         | Main bass contributor; bass band was over 30 % at all energies                 |
| default `volume`       | 0.8           | 0.7           | E 0.3 render sat at −15.5 dBFS RMS, above the −16 limit                        |
| `PAD_OSC_SAW/TRI_GAIN` | 0.030 / 0.040 | 0.028 / 0.038 | Minor; traded bass for mid                                                     |
