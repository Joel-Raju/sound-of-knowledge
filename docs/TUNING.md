# Tuning — Sound of Knowledge v2

> **Status: stub.** Populated during the build; finalised in tasks **T3.5** (audio
> mix) and **T6.3** (performance). Every number below must point at a named
> constant in `engine/config.ts` (spec §1.1.9) — no magic numbers in feature code.

## How to tune

1. Change the named constant in `engine/config.ts`.
2. Re-run the verification harness: `npm run audio:check` (audio) or
   `npm run test:e2e` (visual).
3. Record the change and its measured effect below.
4. Listen/look — if the change is audible or visible, add it to
   `docs/HUMAN-CHECKLIST.md` for confirmation.

## A. Musical constants (spec §7.1) — live in `engine/config.ts`

| Constant           | Value           | Effect                                                                            |
| ------------------ | --------------- | --------------------------------------------------------------------------------- |
| `BPM`              | 68              | Grid speed; all rhythmic feel                                                     |
| `STEP_SEC`         | 0.2206 s        | 16th-note length at 68 BPM                                                        |
| Chord length       | 4 bars ≈ 14.1 s | Harmony drift rate                                                                |
| Key change cadence | 32 bars ≈ 113 s | How often the key walks                                                           |
| `EPS_REF`          | 60              | **UNVERIFIED** — no Wikimedia network in build env (`DECISIONS.md`). Recalibrate. |
| `BOT_REF`          | 8               | Bot-energy normalisation                                                          |

## B. Voice gains (spec §8.6) — tuned at T3.5

| Voice | Spec gain | Final | Notes |
| ----- | --------- | ----- | ----- |
| bell  | 0.30      | —     |       |
| pluck | 0.35      | —     |       |
| sub   | 0.55      | —     |       |
| gong  | 0.12      | —     |       |
| thud  | 0.80      | —     |       |
| tick  | 0.25      | —     |       |

## C. Mix chain (spec §8.3, §8.7) — tuned at T3.5

| Node                 | Spec            | Final | Notes |
| -------------------- | --------------- | ----- | ----- |
| reverbSend           | 0.30            | —     |       |
| delaySend            | 0.12            | —     |       |
| padReverbSend        | 0.45            | —     |       |
| compressor threshold | −10 dB          | —     |       |
| masterGain           | `0.9 × volume²` | —     |       |
| pad duck depth       | 0.65            | —     |       |

### Measured mix results (§8.4 thresholds)

| Metric                    | Target    | E≈0.3 | E≈0.6 | E≈0.9 |
| ------------------------- | --------- | ----- | ----- | ----- |
| Peak dBFS                 | ≤ −1.0    | —     | —     | —     |
| RMS dBFS                  | −24 … −16 | —     | —     | —     |
| Crest dB                  | 10 … 22   | —     | —     | —     |
| sub band share            | 8–30 %    | —     | —     | —     |
| bass band share           | 10–30 %   | —     | —     | —     |
| mid band share            | 25–50 %   | —     | —     | —     |
| high band share           | 5–25 %    | —     | —     | —     |
| air band share            | ≤ 8 %     | —     | —     | —     |
| dropped/attempted @ E 0.9 | ≤ 0.35    | —     | —     | —     |

## D. Performance measurements (spec §12) — recorded at T6.3

| Budget                | Target       | Measured |
| --------------------- | ------------ | -------- |
| DSP real-time factor  | ≥ 10×        | —        |
| Worker bundle (gzip)  | < 40 KB      | —        |
| Worklet bundle (gzip) | < 40 KB      | —        |
| First-load JS (gzip)  | ≤ 450 KB     | —        |
| Scheduler tick        | ≤ 1 ms       | —        |
| Ingest per batch      | ≤ 2 ms       | —        |
| Heap growth over soak | < 0.5 MB/min | —        |

## E. Visual tuning (spec §9)

| Parameter             | Where                  | Final |
| --------------------- | ---------------------- | ----- |
| bloom intensity       | `visual/post.ts`       | —     |
| CA kick decay τ       | `visual/post.ts`       | —     |
| grain opacity         | `visual/post.ts`       | —     |
| camera orbit yaw rate | `visual/camera-rig.ts` | —     |
| trauma decay          | `visual/camera-rig.ts` | —     |

## Deviations from spec tuning values

_(none yet)_
