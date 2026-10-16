# Human Check Checklist — Sound of Knowledge v2

Items the autonomous agent **cannot** verify: they require ears and eyes.
Every other acceptance criterion in the spec is automated.

This file is the authoritative list. It is populated as the build progresses.

---

## A. First impression (§2.2) — the 60-second walkthrough

- [ ] **A1.** Page opens near-black with a quiet title and a single **Enter** button
      reading "Best with headphones".
- [ ] **A2.** On Enter, a low drone swells in over ~2.5 s; a dim breathing core
      fades up in a vast dark space with drifting dust; camera slowly dollies in.
- [ ] **A3.** Within seconds, comets streak from around you into the core and
      dissolve into it, rippling its surface.
- [ ] **A4.** Each sound comes **from the direction its comet came from**.
- [ ] **A5.** Warm plucks for added text, cool glass bells for removed text, deep
      swells for very large edits.
- [ ] **A6.** A gentle pulse underneath is audible and feels _real_, not random.
- [ ] **A7.** Reverts land as a deep metallic gong with an expanding shockwave ring.
- [ ] **A8.** New pages appear as a rising little arpeggio and a radial star burst.
- [ ] **A9.** Every ~30 s the harmony drifts; mode and colour shift with global
      activity (calm → Aeolian/violet, busy → Lydian/gold).
- [ ] **A10.** Article titles fade in occasionally and are clickable; a ticker shows
      the latest notable edit.

## B. Audio quality

- [ ] **B1.** First 60 seconds feel calm and musical, **never cacophonous**.
- [ ] **B2.** Nothing harsh on headphones at 80 % volume.
- [ ] **B3.** Loudness comfortable at 80 %; **gongs are not startling**.
- [ ] **B4.** No audio glitches over 30 continuous minutes.
- [ ] **B5.** Sound direction matches comet origin (left/right/behind) on headphones.
- [ ] **B6.** Audio and visual feel simultaneous. If Bluetooth desyncs, adjust
      `avSyncMs` (`?debug=1`) and record the value used here: `______ ms`.
- [ ] **B7.** Harmony never sounds random — it always sounds like one piece.
- [ ] **B8.** Silence between events reads as a feature, not a dropout.
- [ ] **B9.** ⚠️ **Aeolian/violet is actually reachable.** `EPS_REF = 15` (calibrated
      at T1.1) puts typical traffic at E ≈ 0.70, and Aeolian needs E < 0.22
      (< ~0.7 edits/s). If the mode never drifts into Aeolian during a normal
      listening session, **raise `EPS_REF` in `engine/config.ts`** — the
      provisional 60 would put typical traffic at E ≈ 0.47. Record the chosen
      value here: `EPS_REF = ____`.

## C. Visual quality

- [ ] **C1.** 60 fps on a mid-range laptop (p95 frame time ≤ 18 ms).
- [ ] **C2.** ≥ 30 fps on a mid-range phone (p95 ≤ 36 ms).
- [ ] **C3.** Mode/colour transitions feel smooth, not abrupt.
- [ ] **C4.** Reduced-motion mode feels calm; no flashing anywhere.
- [ ] **C5.** No full-screen strobing (> 3 Hz) in any state, including bot bursts.
- [x] **C6.** ✅ **No banding; background darkened within a hard floor.** _(T4.4.)_
      Corner-patch luminance std-dev **2.27–2.70** throughout, inside T4.4's (0, 6),
      and no contouring visible in the captures — the grain is dithering correctly.

      The background was **navy rather than near-black**, diagnosed by sweeping the post
      stack: bloom off scored 80.05 against AgX's 80.03 and the vignette off 80.11, so
      neither was responsible — the lift is **tone mapping**, and the fix belongs in the
      palette's `deep` rather than in the curve.

      **It found a floor that is quantisation, not taste.** At L ≈ 0.06 the four modes'
      `deep` colours land on 8-bit triples and lydian and mixolydian land on the
      *identical* (0,1,3) — so the §9.3 harmony drift measured exactly **0** and the
      background stopped following the palette at all, at any threshold. `deep` is
      therefore at **L = 0.10**, where all four are distinct: (1,3,9), (0,4,9),
      (2,3,11), (3,2,12). Recorded in `visual-boot.spec.ts` so the next person to try
      going darker finds it in one place.
      ⚠️ **Related, from T4.4:** with the dust entirely off the background is still
      **navy rather than near-black** — AgX lifting the clear colour, visible in
      `artifacts/shots/t6s-dust-a-off.png`. The grain is doing its job (T4.4's corner
      std-dev passes), so this is a tone-mapping question about how dark "dark" should
      be, not a banding one.
- [ ] **C7.** The orb body is readable — not washed flat against the background.
      _(Regression risk: LEGACY-NOTES §3.2 found `AdditiveBlending` washed the orb
      out, but spec §9.2 mandates additive. Verify and report.)_
- [ ] **C8.** Clicking a label opens the correct article in a new tab.
- [x] **C9.** ✅ **Resolved — the orb now reads as a luminous core.** _(T4.2. Not a
      taste call after all: §9.4's `smoothstep(0.15, 0.85, …)` window only makes sense
      against a [0,1] signal, but §9.4 also mandates Ashima's *signed* `snoise`, so raw
      `fbm` landed near ±0.4 and nearly every fragment mapped to 0. The `smoothstep`
      was a near-total clip, not a contrast curve. Normalising `fbm` to [0,1] first
      took mean centre luminance 13.5 → 30.0 and std-dev 20.3 → 46.5. See
      `DECISIONS.md`.)_
- [x] **C10.** ✅ **Resolved — the weave is gone at every tier.** _(T4.2. Swept
      §9.4's IGN jitter at 3× magnification: 1.0 / 0.5 / 0.35 all show a strong
      diagonal lattice, and **0.0 shows neither the lattice nor any concentric
      banding** — the banding the jitter exists to hide does not occur, because the
      density field varies by more than a `stepLen` across each step. Set to 0;
      the uniform is retained as insurance with a measured reason for being off.)_
- [x] **C11.** ✅ **Resolved — the core has interior structure.** _(T4.4, three
      wrong hypotheses before the right one.)_
      Parked since T2 precisely waiting for §9.8 to land. Once it did, the core was a
      structureless wash, and the diagnosis went:

      1. **Tone mapping** — ACES tested against AgX. It *does* restore separation
         (8.23 % of pixels above luminance 230 against AgX's 0.00 %), but the magnified
         core is a smooth wash either way. **Wrong.**
      2. **Bloom** — intensity 0.9 over a bright orb would both wash the frame and add
         glow over the orb. Disabling it scored 80.05 against 80.03. **Wrong.**
      3. **The orb's own shader** — the actual cause. Transmittance decays by the
         per-step absorption every step, so deep in the volume the accumulated colour
         converges on the emitted one and the fbm structure is cancelled *before*
         anything downstream sees it. Scaling the colour cannot recover detail that is
         already gone.

      Two deviations from §9.4, both chosen by eye and both pinned by tests:
      **absorption 3.2 → 1.2** and **emission 1.0 → 0.55**. The human compared the
      sweep at 3.2 / 2.0 / 1.2 / 0.7 and found 1.2 and 0.7 both better than the spec's
      3.2; 1.2 is the default because the orb still reads as a luminous body there,
      and 0.7 is one `?absorb=` away.
- [x] **C11b.** ✅ **Resolved — the dust reads as dust.** _(T4.4. Decided by eye over a
      six-candidate contact sheet, `shot.ts --dust-sweep`.)_

      §9.7 specifies 30 000 points and a twinkle spanning [0.25, 1.0] but **never says
      what the twinkle multiplies**. At 1.0 the motes render at full strength and the
      scene reads as a starfield — a second subject competing with the orb.

      **Density was the wrong lever.** Sweeping it showed 10 500 motes at alpha 1.0 score
      a corner std-dev *identical* to having no dust at all (0.34): cutting the count
      deletes the depth cue rather than thinning it. Only dimming keeps it.

      **Chosen: base alpha 0.35.** Judged on whether the motes read as depth around the
      orb or as a competing subject. At 0.35 they read as tiny dust particles around the
      orb and the orb stays the subject. Corner std-dev **6.12 → 1.85**, and T4.4's
      acceptance now passes.

      Sweep, for the record: as-specified 6.14 · alpha 0.35 → 2.16 · alpha 0.15 → 0.56
      · density 0.35 → 0.34 (= dust off). Still overridable via `?dustAlpha=` without a
      code change.

      ⚠️ **Separate issue, not fixed:** with dust *entirely off* the background is still
      **navy, not near-black** — AgX lifting the clear colour. Folding this into C6
      (banding / dark gradients) since it is a background question, not a dust one.

## D. Audio listen files

Generated by `npm run audio:check` into `artifacts/audio/` (120 s each, 32-bit
float stereo, ~46 MB):

- [x] **D1.** ✅ **Musical.** _(Re-listened 2026-10-15 on the regenerated render, after
      the `WORKLET_QUEUE_CAP` fix and the bus-gain rebalance.)_ 201 notes, 0 dropped,
      sub 21.0 / bass 15.9 / mid 50.0 / high 8.0 %, RMS −16.4 dBFS, 0 clipped, §8.4
      passes.

      **Noted by ear:** *"some bell sounds are a bit sharper and louder but that's
      okay."* Acceptable as it stands, but it is a symptom — see **B11**.
- [x] **D2.** ✅ **Judged via the soak.** _(Not played as a 120 s file; the human was
      told it was covered by the 600 s soak at the same energy and chose to skip it.
      That verdict is carried over: E ≈ 0.6, same code path, 5× the duration. Recorded
      this way so it is not mistaken for a direct listen.)_ 620 notes, 8.4 % dropped,
      sub 14.9 / bass 10.4 / mid 62.0 / high 8.0 %, RMS −16.8, §8.4 passes.
- [x] **D3.** ✅ **The gaps feel like breathing.** _(Re-listened 2026-10-15.)_ 31.3 % of
      attempted notes are still dropped — 425 of ~1350 — against §8.4's 35 % ceiling,
      unchanged by the rebalance.

      **This is the verdict that could not be given before.** The earlier "reads as
      texture, not breakage" was made on audio that was missing 80–95 % of its notes —
      including the notes that would have filled those gaps and shown whether the gaps
      were breathing or dropouts. Now it is answered on complete audio, and **no cap
      change is warranted**: raising the 35 % ceiling would admit a denser mess for no
      benefit, and lowering it would thin a texture that works.

      E90 reports bass 9.9 % and mid 66.6 %, outside §8.4's *stated* 10–40 % and
      20–55 % ranges, yet `checkMixTargets` passes it — the enforced bounds are softer
      than the printed ones. Logged as **B12**.
- [x] **D4.** ✅ **Listened to in full and liked.** _(Rendered 2026-10-15, 600 s,
      230 MB, after the `WORKLET_QUEUE_CAP` fix and the bus-gain rebalance.)_
      Measured alongside: **spread 2.99 dB** across twenty 30 s buckets,
      **slope +0.10 dB/min**, no silence run, peak −4.79 dBFS, 0 clipped,
      0 non-finite. §8.4 passes on every band (sub 32.5 / bass 23.7 / mid 40.1 /
      high 3.5 / air 0.2 %).

      This is the first D-check judged on audio that was not missing most of its
      notes. Before the fix the same file scored 8.84 dB of bucket spread — variation
      that turned out to be dropped notes, not the piece.

      **It also confirms the pad-forward balance.** The rebalance was chosen from
      band-share arithmetic, not from listening, so the human hearing it and being
      happy with it is the only evidence the numbers pointed the right way.
- [x] **D5.** ✅ **Resolved: the air layer is inaudible at §8.8's own values.**
      Confirmed by ear at the end of T3.5. It was briefly raised +37 dB to chase
      §8.4's 2–8 kHz target, and that raised version _was_ genuinely loud — but
      the four "still hissing" reports that followed described a **cached file**,
      not the render (see D7). The layer is now at §8.8's exact values with no
      deviation, and `audio:check` shows air-on and air-off to be identical to two
      decimal places (rms −21.0 dBFS, `high` 2.40 % vs 2.43 %).
- [x] **D6.** ✅ **Answered: originally a wash — fixed.** The bed was changed
      **spectrally, not by level**: the pad's cutoff coefficient went 2800 → 1400 Hz
      (darkening it so its energy sits below the melody rather than competing with
      it) and `VOICE_GAIN.pluck` 0.26 → 0.31. A level cut was tried first and
      failed — the pad's fundamentals sit at 130–392 Hz, so it is both the thing
      masking the melody and the mix's only real bass source; −4 dB collapsed
      `bass` from 30 % to 7 %. Confirmed by ear: _"it is better"_. This fix
      stands on its own evidence and was not affected by the caching incident.
- [x] **D7.** ✅ **Root cause: macOS Quick Look served a cached render.** Every
      render in this project is exactly **46,080,044 bytes**, so `open`ing
      `artifacts/audio/render-E60.wav` again served a stale preview
      indistinguishable from a fresh one. `afplay`, which re-reads the file,
      showed no hiss at all. Full account in `DECISIONS.md`.

      **Protocol for every future listen of an artefact:**
      - Play with **`afplay`, never `open`** — it does not cache.
      - Or copy to a unique name first: `cp x.wav /tmp/x-$(date +%s).wav`
      - **Give a timestamp** with anything audible. _"Hiss at 2:10"_ is
        debuggable; _"hiss"_ is a 120-second search.
      - A **confirmed no-change result means suspect the input**, not that the fix
        needs to be smaller. That was the tell available throughout and it was
        read the wrong way five times.

## E. Live data

> Most of section E was resolved at **T1.1** by `scripts/probe-stream.ts`
> (see `docs/DECISIONS.md`). What remains is perceptual or device-specific.

- [x] **E1.** Live stream connects — CORS returns `access-control-allow-origin: *`,
      HTTP 200, 0 parse errors over a 120 s capture. **No proxy needed.**
- [x] **E2.** Real throughput measured: Wikipedias + `edit|new` = mean 5.9/s,
      p95 10/s → `EPS_REF = 15`. Bot ratio 18.8 % (spec model 20 % ✓).
- [ ] **E3.** ⏳ **Measured over 20 minutes and the "English is fine" note was wrong.**
      `scripts/probe-reverts.ts` recorded 1 200 s of the real stream: **6 428 edits,
      2 659 distinct summaries, 51 matched**, with three reconnects handled cleanly.
      **English 29 / 1 483 = 1.96 %** (95 % CI 1.25 % – 2.66 %); covered languages
      combined 48 / 2 993 = 1.60 %. §6.2's **3 % model is not supported** — even the
      upper bound sits below it.

      But detection is incomplete, and the residual is now *enumerated*, not suspected.
      A second pass over all 2 659 summaries finds **18** revert-shaped ones the
      patterns miss — **8 of them English**: `Reverting edit(s) by …` ×3 (the `\b` in
      `/^Revert(ed)?\b/` defeats `Reverting`), `Bot: Undo …`, `S-revert:`, `partial
      revert …`, `rv, …`. Also Italian `Annullate` (plural vs `/^Annullata/`),
      French `Bot : Annulation`, Japanese `… による ID`.

      Counting all of them: English **2.49 %** (CI ≈ 1.76 % – 3.22 %), which puts 3 %
      back *inside* the interval. **Both** the model and the patterns are off; the
      patterns are the smaller half.

      The sample also settles the false-positive question that was left open: two of
      the eighteen are *not* reverts — `/* Clarification Regarding Reverted Edits to the
      Hastinapur Article */ Reply`. So un-anchoring `Reverted` demonstrably costs
      false positives; widening by **shape** (`Reverting`, `Bot: Undo`) rather than by
      **position** does not.

      **Decision taken: widen by shape, never by position.** All enumerated classes
      applied as anchored or word-bounded patterns — `/^Reverting\b/`,
      `/^Bot:\s*Undo\b/`, `/^S-revert:/`, `/^rv[.,]/`, `/^partial revert\b/`,
      `/\bUndid \d+ revisions?\b/`, and Italian `Annullat[eo]` behind an optional
      bot-signature template.

      **Replaying all 2 659 summaries of the capture through the new set: 51 → 63
      matched, +23.5 %, and all 12 newly-matched are revert-shaped.** Neither
      Hastinapur false positive matches. English goes 1.96 % → ~2.5 %.

      **Not applied, and why:** Japanese `… による ID` (no pattern exists for the
      language), French `Bot : Annulation des modifications`, and Italian
      `Avviso di annullamento automatico` / `Annullo:` — the last two need
      un-anchored stems, which is exactly what the Hastinapur sample forbids. These
      remain open; 32 % of traffic still has no pattern at all.

      **One existing test case retired.** `"reverting to the previous version of the
      intro"` sat in the negative list, cited as an anchoring example. It *is* a
      revert, and the capture showed the present participle is the commonest revert
      phrasing there is — so it moved to the positives. The anchoring property it
      was guarding is still asserted, on a summary that is genuinely not a revert
      (`"/* Prose */ I am reverting the change I made earlier today"`).
- [ ] **E4.** Bot ratio in the HUD looks plausible on live traffic.
- [ ] **E5.** Article titles seen in the wild match the §6.1 shape, including
      temporary accounts `~YYYY-N` and `server_name` (not just `server_url`).
      _Partly confirmed: the E3 captures show temporary accounts (`~2026-54929-97`,
      `~2026-55118-67`, `~2026-55219-42`) appearing **inside real edit summaries**,
      not only as `server_url`._

## F. Browser / device matrix

- [ ] **F1.** Chrome desktop — full experience. _What CI already covers: the whole
      Playwright suite runs on Chromium (18 tests)._
- [ ] **F2.** Safari 16.4+ desktop — `AudioContext` unlock, `interrupted` handling.
      _**Partial automated coverage:** `crossbrowser.spec.ts` asserts `AudioContext`
      reaches `running` and that `outputLatency` falls back to `baseLatency` (§8.2).
      Runs in CI via the `webkit-smoke` project. **Not yet run** — browsers are not
      installed locally, by choice. The `interrupted` state handling is still
      unverified, and that is the real F2 risk._
- [ ] **F3.** Firefox desktop — `EventSource` in worker, `outputLatency` absence.
      _**Partial automated coverage**, same file, same status. Firefox's lack of
      `outputLatency` is exactly what the fallback assertion targets. `EventSource`
      in a worker is still untested — that is the substantive half of F3 and it
      needs a live-stream test._
- [ ] **F4.** iOS Safari — `Enter`-tap unlock, safe-area HUD, touch drag to look.
- [ ] **F5.** Android Chrome — touch drag, tier detection → low/medium.
- [x] **F6.** ✅ **Verified in CI** — `tests/e2e/reduced-motion.spec.ts`, 5 tests. §9.11's
      two halves both asserted: the rig adds no trauma shake at all, and the ambient
      drift is _reduced rather than removed_ so the camera does not freeze. Covers the
      live mid-session change via `emulateMedia`, mutation-checked (unwiring the
      listener fails exactly one test). Added at T4.2 pause — T4.1 shipped the feature
      with no test, which is the mistake this project has now made and caught three times.

---

## Sign-off

Reviewed by: ____________________ Date: ____________

Outstanding issues:
<!-- free text -->

- [ ] **B11.** ⚠️ **The per-voice balance was tuned against audio that was missing most
      of its notes.** Noted by ear at D1 on the first honest render: *"some bell sounds
      are a bit sharper and louder but that's okay."*

      This is not really about bells. While `WORKLET_QUEUE_CAP` was 8, **80–95 % of notes
      were dropped** and the survivors bunched into the render's final seconds. Any
      balance fitted by ear to that audio was fitted to a piece that was mostly pad.
      Bells are the most exposed by this — they are high-frequency and short, so they
      were masked by the thinned mid before, and now every one of them is present.

      **Left as-is deliberately**, since the verdict was "okay" and the band targets
      pass (E30 high band 8.0 % against a 1–25 % range). Worth revisiting only if a
      later listen finds the bells abrasive rather than present. The lever is the bell
      voice's own gain and partial mix, not the bus gains.

      The general form of this hazard — **a mix tuned against broken renders** — is the
      same shape as the Phase 3 caching incident that produced the listening protocol in
      `DECISIONS.md`.
- [ ] **B12.** §8.4's *stated* band ranges are stricter than the ones enforced.
      `MIX_TARGETS` reports `share.bass 10…40 %` and `share.mid 20…55 %`, but E90 passes
      at bass **9.9 %** and mid **66.6 %** — outside both. Either the enforcement has a
      tolerance the documentation does not mention, or the check is not testing what it
      says. Whichever it is, the printed numbers are currently a false promise: someone
      reading §8.4 would conclude E90 fails when the harness says it passes. Low effort,
      and it is the kind of mismatch that hides a real regression.
      2 % fundamental check on the bell, but the spec's own inharmonic FM ratio
      of 3.99 makes the waveform quasi-periodic and leaves the carrier at a Bessel
      null — measured carrier energy was **3e-7 of the band peak**, so every
      measurement method tried (FFT peak-pick, autocorrelation, carrier energy,
      spectral centroid) either measures a sideband or does not scale with pitch.
      Full evidence in `DECISIONS.md` at T3.1. **Confirm by ear** that
      bell/removal notes move to the expected pitch as an edit grows. If they do
      not, the lever is a _rational_ FM ratio (4.0) — which would change the
      metallic timbre the spec deliberately specifies, so it is a real trade-off,
      not a free fix.
