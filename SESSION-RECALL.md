# SESSION-RECALL — sheet2sound

Durable memory snapshot for resuming work later. Project status as of the last session
(**Steps 1–4 all green** + repeat-aware playback + per-measure tempo segments +
**GPL-3.0 licensed + git-initialized + published to GitHub**).
The OpenCode session itself is saved and anchored to this folder
(`sheet2sound — OMR→sound pipeline Steps 1–4 … live tempo`).

## What this project is

Paper sheet music → sound: **scan upload → Audiveris OMR (patched) → MusicXML → vexml/VexFlow 5**
**canvas → Tone.js + MusyngKite SoundFont**, with a human verification stage for OMR corrections
(100% OMR accuracy is impossible; the verify UI is the corrective loop).

## Stack

- `@stringsync/vexml` 1.4.0 (VexFlow 5 under the hood, canvas), `vexflow` 5.0.0, `tone` (Transport-based playback), `fflate`
- Editing: `@stringsync/mdom` 0.4.0 — `EditingSession` + `score.createEditingController(editor, {selection:{}})`
- OMR: Audiveris 5.11 **patched** build (key-signature export fix `738e219`), JDK 25
- Server: Vite dev server + `POST /api/transcribe` middleware plugin (raw body + `?name=`, 64 MiB cap)
- Tests: Playwright headless against `http://localhost:5173`

## Run / verify commands

```sh
npm run dev              # vite on :5173 (no restart needed for src/ changes; HMR applies)
npm run verify           # Step 1: render scores/carmen.xml, canvas non-blank
npm run verify:upload    # Step 2: UI upload carmen.png → Audiveris → render (23 measures)
npm run verify:playback  # Step 3: Play → 238 notes (carmen now repeat-expanded), cursor bar+halos,
                         #        mid-piece measure-lock, repeat-order parity vs vexml sequence,
                         #        LIVE tempo change (60→140 mid-play) applies without Stop
npm run verify:edit      # Step 4: select note → ♯+1 → undo → halve → nav → export .musicxml
npm run verify:omr-demo  # loads /?demo=carmen-omr.musicxml (OMR transcription) and renders
npm run verify:avalon   # /?demo=avalon.musicxml: 62 written measures across 2 parts (Voice + Piano), 2/2→4/4
                        # across pages, repeat m10↔m60 + voltas EXPANDED to 111 occurrences:
                        # 1141 pitched notes, ~370 beats (~3:05 @ 120) — matches vexml's cursor
npm run verify:tempo    # /?demo=tempo-seq.xml: per-measure tempo segments (metronome/sound marks,
                        # back-jump re-apply) fold to 20666.67 ms — EXACT parity with vexml's
                        # getDurationMs(); cursor locks to m2 inside the 60-QPM section mid-play
npm run test:player      # parser unit test vs ground truth (accepts a file arg: scores/avalon.musicxml)
npm run test:player -- scores/tempo-seq.xml  # tempo-segment unit truths (segments/msAt/beatsAt/bpmAt)
npm run inspect          # structural dump (measures, key signatures)
```

## Key files

- `src/main.js` — everything: render, EditingSession wiring, measure-anchored playback cursor,
  Tone.Transport playback (live tempo), per-measure tempo-segment scheduling (`timeline.msAt/beatsAt`),
  Tempo dropdown written-tempo default, `window.__*` hooks for tests
- `src/player.js` — MusicXML → event timeline + **per-measure tempo segments** (vexml TempoMap port:
  `<metronome>` beats `<sound tempo>`, back-jump re-applies marks as written)
- `scripts/verify-*.mjs`, `inspect.mjs`, `test-player.mjs`, `debug-page.mjs`, `debug-upload.mjs`
- `scores/carmen.xml` (demo) + `scores/carmen-omr.musicxml` (real OMR transcription, load at `/?demo=carmen-omr.musicxml`)
- `scores/tempo-seq.xml` — tempo-segment fixture (`/?demo=tempo-seq.xml`): six 4/4 whole-note measures,
  m2 metronome quarter=60 (→60), m3 metronome half=60 (→120 via QUARTERS_PER_UNIT), m4 carries 120,
  m5 measure-level `<sound tempo="180"/>` (→180), m6 carries; forward m2-left / backward m4-right
  replays m2..m4 → 9 occurrences, segments [0,4)120 [4,8)60 [8,12)120 [12,16)120 [16,20)60
  [20,24)120 [24,28)120 [28,32)180 [32,36)180, totalBeats 36, durationMs 20666.67 (linear-120 = 18000)
- `scores/avalon.musicxml` — multi-page OMR result: four Audiveris page exports merged
  (`/?demo=avalon.musicxml`); 62 written measures (27 verse 2/2 + 35 chorus 4/4), Voice + Piano parts kept
  separate, G major; repeat m10↔m60 + voltas → ~370 beats (~3:05 @ 120) expanded playback
- Multi-page OMR tooling: `scripts/omr-avalon.mjs` (per-page Audiveris runner),
  `scripts/run-transcribe.mjs` (one-shot transcribe to file), `scripts/merge-sheets.mjs`
  (multi-PART merge of page .mxl → one musicxml: keeps Voice + Piano parts separate & simultaneous,
  pads short parts with whole-rest bars, normalizes divisions to 12 for MuseScore 3, fit-to-meter
  compresses OMR overfull bars, syncs time-signature changes into every part + per-page meter audit),
  `scripts/diag-parts.mjs`, `scripts/diag-overfull.mjs`, `scripts/analyze-meter.mjs`,
  `scripts/diag-lanes.mjs`, `scripts/diag-repeats.mjs`, `scripts/extract-pdf-pages.mjs`,
  `artifacts/render-pdf-pages.py` (PyMuPDF page→PNG), `artifacts/measure-ink.py`,
  `artifacts/scan-book.py`, `artifacts/ocr.ps1` (Windows OCR via powershell.exe, NOT pwsh)
- Scratch work (PNGs/OCR/page-.mxl) in `%TEMP%\opencode\avalon-work` — outside vite's watch
- `server/transcribe.mjs`, `vite.config.js`, `index.html` (two-column: original scan + score)

## Architecture gotchas (learned the hard way)

1. **vexml's playback sequence paces each measure at its WRITTEN meter** (carmen: 2/4 = 1000 ms/measure)
   **and expands repeats** (carmen's sequence shows a repeat jump at M12→M13; our audio now does too).
   → The cursor is **measure-anchored**: `buildMeasureMap()` maps our beat axis → sequence per-measure
   spans; `cursorMsAt(ourBeats)` = seqStartMs(measure) + frac·width. `verify:playback` asserts a
   mid-piece measure lock (cursor ~4000 ms → sequence measure 4, NOT the end).
1b. **Multi-voice MusicXML** (Audiveris writes melody+accompaniment with `<backup>` per measure):
    the parser must NOT walk `<note>`s blindly — that serialized the voices (4 beats/measure,
    92.5 beats total) and desynced playback from the 2/4 pulse (the user's "tempo not in sync"
    complaint). `src/player.js` now walks every measure child: `<backup>`/`<forward>` move the
    local tick position, chords share the previous start, ties extend per (measure, occ, part,
    voice) lane. Each measure lasts max(content, written meter) → carmen = 60 beats / 30 s @ 120 ✓
    (that's the repeat-EXPANDED length: 30 occurrences × 2 beats; see gotcha 16).
2. **Live tempo = Tone.Transport.** Notes are scheduled ONCE at their written-tempo position
   (`timeline.msAt(startBeats)/1000` seconds — a bare schedule number = seconds, converted to ticks
   at schedule-time bpm, so wall time = that seconds value; see gotcha 17). Changing
   `Tone.Transport.bpm.value` rescales wall-clock from the current moment (MuseScore-style) — no
   Stop+Play, no re-schedule. The dropdown default snaps to the opening bpm of the written tempo map
   (`timeline.tempo`; `syncTempoDropdown`). End-of-piece = a `Transport.schedule` marker at
   `msAt(totalBeats)/1000 + 0.25` → `finishPlayback()`. Stop/cancel = `Transport.stop()`+`cancel()`.
2b. **Note duration is also tempo-aware** — each sounding note lasts `durBeats·(60/bpmAt(start))·0.95`
   seconds (the bpm in force where it starts), so a slow section's notes ring longer; the global
   dropdown override still scales placement via the transport bpm.
3. **Cursor beats invert the tempo map**: `beats = timeline.beatsAt((ticks/PPQ)·(60000/scheduleQpm))`
   with `scheduleQpm` captured at play() (see gotcha 17). At a uniform 120 this reduces exactly to
   `ticks/PPQ`; with tempo marks it keeps bar + halos on the notes being heard in slowed sections.
4. **Playback state machine**: tests assert state (`playing`→`idle`), sampler presence, cursor/halos —
   NOT audio (sandbox can't hear). Audio needs a real browser + click gesture + CDN SoundFont.
5. **Playwright quirk**: `waitForFunction(fn, arg, options)` — options is the 3rd positional arg.
6. **After edits** (`semitone`, `scaleDuration`): `rerenderForEdit()` → `stopPlayback()` first, then
   `score.dispose()` → `render(doc, el)` → `attachController()` (re-creates cursor/playhead, re-affirms
   selection). The same `doc` is reused → session selection survives.
7. **Duration edits are structural** (`note.setDuration` ripples the voice): after the nth structural edit
   call `editor.clearHistory()`, then rerender. Pitch edits stay in undo history.
8. **OMR per-shell env** (PowerShell 5.1, no `&&`): `$env:JAVA_HOME="C:\Program Files\Eclipse Adoptium\jdk-25.0.4.101-hotspot"; $env:PATH="$env:JAVA_HOME\bin;"+$env:PATH`.
9. **Multi-page Audiveris**: run ONE page per job — a multi-page book export aborts if any sheet
   fails ("transcription did not complete successfully"). If a 300 DPI PNG yields `Created scores: []`,
   retry that page as a PDF slice — Audiveris's own rasterizer succeeds where our PNG didn't
   (Avalon page 24). Prefer PNGs generally (pdf-lib slices can drop shared resources).
10. **Per-page meter/divisions** (Avalon pages: divisions 4/12/4/2, chorus re-declares 4/4):
    `parseMusicXML` reads `divisions` AND `time` **per measure** (carry-forward for continuation
    pages that don't re-declare) — the old global-first-value read silently desynced playback on
    merged page exports. `test-player`'s lane check compares **starts** (chords share a start),
    not ends — an end-based check false-positives on whole-measure chords.
11. **TOC page numbers in books lie** — for Avalon the printed numbers on the music pages (3–6)
    were NOT the PDF indices (those were blank; PDF pages 21–24 = printed 3–6, offset +18). Find
    the real pages by OCRing page headers/TOC, never trust user's page recall + book's TOC alone.
12. **Multi-PART MusicXML (the Avalon merge gotcha)** — Audiveris page exports are score-partwise
    with several `<part>`s (Avalon: Voice + Piano; page 23 even had a THIRD part and an EMPTY one).
    Two failures hide here:
    - **Merge**: the old merge dumped every part's measures into ONE part (133 measures instead of
      ~62) → MuseScore 3 played one giant "part" of Voice-then-Piano with overfull/silent bars, and
      our timeline doubled. `merge-sheets.mjs` now maps parts by score-part name (Voice lane =
      first part named Voice, Piano lane = first part named Piano), folds extra voices into the
      primary part as a separate lane via `<backup>` to the bar-line, pads short parts with
      whole-rest measures, and renumbers sequentially so every part has the same ~62 measure numbers.
    - **Parser**: `parseMusicXML` must read all parts SIMULTANEOUSLY (group measures by number,
      reset position to 0 per part per measure — an implicit `<backup>`), or the piano plays serially
      after the melody (same pollution bug in audio alone). Event id = `m<no>-<part>-<n>`, voice gets
      a `#<part>` suffix for display.
13. **Cut-time pacing (2/2 feels like 4/4)** — vexml and our parser pace 2/2 bars at 4 quarter-
    beats (2 s @ 120), but MuseScore 3 reads tempo in the SIGNATURE's beat unit (2/2 = 1 s/bar,
    half-note beats; the sheet has no written metronome so "120" means 120 half-notes). To match the
    user's MuseScore reference, `parseMusicXML` applies a per-measure `beatType/4` scale to
    offsets, durations AND the measure's grid span (2/2 → 0.5, 4/4 & 2/4 → 1.0). Carmen (2/4)
    is byte-identical; Avalon dropped from 568 beats (4:44) to ~203 beats (~1:41), and MuseScore
    and the browser now agree on the bar pulse.
14. **Piano part can miss the meter change** — Audiveris re-declares `<time>` only where it appears
    in the primary part; the Avalon Piano part stayed 2/2 through the 4/4 chorus. `merge-sheets.mjs`
    `syncTimeSignatures()` copies the primary part's time signature into the other parts at the
    same measures (and strips `symbol="cut"` from a synced 4/4).
15. **fit-to-meter tolerance is MuseScore's, not ours** — MuseScore 3's MusicXML importer rescales
    every `<duration>` onto its internal 480-ticks-per-quarter grid (`libmscore/mscore.cpp`:
    `MScore::division = 480`) and forgives up to `maxDiff = 3` of those ticks as a rounding error
    (`importexport/musicxml/importmxmlnoteduration.cpp`). Projected onto our `divisions=12` files
    that band is `3·12/480 = 0.075` file ticks — so at our granularity a fit must leave NOTHING
    over by a whole tick (1 file tick = 40 MuseScore ticks ≫ 3). `fitToMeter` therefore exact-fits
    every overfull bar: scale by `written/content`, round to ≥1, then while content end > written
    keep shaving the current max-end note by the residual and re-measuring (a single one-pass trim
    is wrong — with several voices the overhang can be held by a note that isn't last in document
    order). `scripts/diag-overfull.mjs` audits with the same `3/480` quarter tolerance. **Gotcha
    inside the gotcha**: `matchAll()` results are `RegExpMatchArray` objects (Arrays), so
    `nb.indexOf('<duration>')` on the match *array* returns -1 (it searches elements, not text) —
    always use `nb[0]` (the matched string) for `.indexOf`/`.exec`. This silently corrupted 4 notes
    in 4 fitted piano measures (m5/23/31/33) before it was caught — measure-by-measure note-count
    diffing vs the source pages caught the loss.
16. **RepeatList port (MuseScore source → vexml semantics → our audio)** — `src/player.js` now
    expands repeats/voltas the SAME way vexml's `MeasureSequenceIterator` does (`measureOrderFromJumps`
    is a direct port of `node_modules/@stringsync/vexml/measure-sequence-iterator.ts`, fed by
    `readBarlines`/`measureRepeats`/`jumpsByMeasure` mirroring vexml + our XML): a measure plays once
    per occurrence with its own `occ` index, and `totalBeats`/`durationMs` reflect the expanded
    playback (carmen 46→60 beats @30 s; avalon ~203→~370 beats @~3:05). The `occurrences` array
    (per-occurrence `{index, measure, startBeats, spanBeats}`) feeds `buildMeasureMap` so the cursor
    pairs our expanded order with vexml's per-occurrence step runs — `verify:playback` asserts the
    two orders are byte-identical. Rules the port encodes: repeat bars/voltas are read from the FIRST
    part only (system-authoritative, like vexml); an `<ending>` supersedes a co-located backward
    `<repeat>`; `<ending times="0">` on the LAST ending = "discontinue" (plays once, no back-jump);
    a back-jump re-applies each measure's time signature/divisions "as written" (precomputed
    `ctxByKey`, mirroring how vexml re-applies tempo). Event `id` stays unique (global counter) but
    events for a repeated measure share `measure` — group by `${measure}\u0000${occ}` in any
    per-measure assertion. Neither carmen nor avalon has D.S./D.C./segno/coda `<direction>` markers
    (OMR never captured the printed D.S. text), so only repeat-bar + volta expansion is exercised —
    jump-marker machinery is deferred (matches vexml, which only handles
    repeatstart/repeatend/repeatending).
17. **Per-measure tempo segments (vexml TempoMap port)** — vexml builds one tempo segment per
    expanded measure occurrence and folds beats→ms over them (`msAt`), starting at 120
    (`DEFAULT_TEMPO_BPM`); a measure's mark sets the rate from there on (back-jumps re-apply marks
    as written), null carries. `playbackTempoOf` prefers a `<metronome>` (bpm = `<per-minute>` ??
    that direction's `<sound tempo>` ?? 120, × `QUARTERS_PER_UNIT[<beat-unit>]` — whole 4 … 128th
    0.03125) over a plain `<sound tempo>` (already quarter BPM). `src/player.js` now produces
    `tempoSegments`/`msAt`/`beatsAt`/`bpmAt`/`durationMs` as exact ports; `timeline.tempo` = FIRST
    segment's bpm (dropdown default). Scheduling in `src/main.js`: a bare number in
    `Tone.Transport.schedule(cb, n)` = **seconds** (converted to ticks at schedule-time bpm, so the
    wall time equals that seconds value), hence events go to `timeline.msAt(startBeats)/1000`, the
    end marker to `msAt(totalBeats)/1000 + 0.25`, and note duration uses the bpm **in force where
    the note starts** (`bpmAt`). Cursor follow must invert ticks through the map:
    `beatsAt((ticks/PPQ)·(60000/scheduleQpm))` with scheduleQpm captured at play time — the naive
    `ticks/PPQ` read races ahead in slowed sections (verify-tempo proves it: cursor stays on m2
    inside the 60-QPM section). `verify:tempo` asserts EXACT parity with vexml's own
    `getSequence().getDurationMs()` (20666.67 ms — both maps fold identically). Zero regression on
    carmen/avalon (no marks → msAt = beats·500). Test file: `scores/tempo-seq.xml`.

## Environment facts (paths, tools)

- Dev server: vite on :5173 (background shell). Kill/restart only on `vite.config.js` change:
  `Get-NetTCPConnection -LocalPort 5173`
- **vite watcher ignores `**/artifacts/**`, `**/scores/**`, `**/tmp/**`** — writing large files
  under those roots used to crash the watcher with a file-lock EBUSY.
- No Google Chrome / Edge installed. Sound-capable browser = Playwright Chromium, run **headed**:
  `C:\Users\Wilbur\AppData\Local\ms-playwright\chromium-1243\chrome-win64\chrome.exe <url>`
- User-facing tabs open in that Chromium: `/` (carmen demo), `/?demo=carmen-omr.musicxml`, and
  `/?demo=avalon.musicxml` (the multi-page OMR pipeline result).
- **MuseScore source cloned** for reference (master + 3.x):
  - `C:\Users\Wilbur\MuseScore-src\` — shallow clone of `master` (v5-era), 510.5 MB, 10,095 files.
    Export module: `src/importexport/musicxml/`; real parser under `src/engraving/…`.
  - `C:\Users\Wilbur\MuseScore3-src\` — shallow clone of **branch `3.x`** (MuseScore 3 line), 281.4 MB,
    7,442 files. MusicXML import/export: `importexport\musicxml\` (`importmxmlpass1/2.cpp`,
    `importmxmlnoteduration.cpp`, `importmxmlnotepitch.cpp`, `exportxml.cpp`);
    tempo/playback: `libmscore\tempo.cpp`, `tempotext.cpp`, `rendermidi.cpp`.
- Playwright sample: `scripts/verify-playback.mjs`.

## Open items / next steps (roadmap)

0. ✅ **"Avalon" multi-page OMR pipeline** — pages found (PDF 21–24, printed 3–6), per-page
   Audiveris, multi-part merged to `scores/avalon.musicxml` (Voice+Piano, 62 written measures),
   meter audit (2/2 verse → 4/4 chorus) + per-page divisions parsing + fit-to-meter + time
   signature sync, cut-time pacing matching MuseScore, `test:player` + `verify:avalon`
   green, playing in the headed Chromium. (Old polluted merge was 133 sequential measures → fixed.)
   Fit-to-meter now exact-fits to MuseScore's own import tolerance (3 ticks @ 480 PPQ), so the
   file has zero overfull bars (was 13 normalized / 3 residual +1-tick drift).
1. ✅ **Repeat-aware playback (RepeatList port)** — the audio timeline now expands repeats/voltas
   exactly like vexml's `MeasureSequenceIterator` (the working distilled equivalent of MuseScore 3's
   `RepeatList::unwind()`), so audio, cursor, and MuseScore all play the same expanded order:
   carmen's m5↔m12 + endings replay (46→60 beats), avalon's m10↔m60 + voltas replay (~203→~370 beats,
   ~3:05). `src/player.js` gains `readBarlines`/`measureRepeats`/`jumpsByMeasure`/`measureOrderFromJumps`
   (port of vexml) + per-occurrence `occ` events + `occurrences`; `buildMeasureMap` pairs our
   occurrences with vexml's step runs (parity asserted in `verify:playback`). D.S./D.C./coda markers
   are NOT in the OMR XML (source of the crossover: `C:\Users\Wilbur\MuseScore3-src\libmscore\repeatlist.cpp`),
   so jump-marker machinery is deferred until a file has them.
2. ✅ **MIT/BSD provenance + GPL-3.0 licensing + git init + published** — project is now `GPL-3.0-or-later`
   (LICENSE + README made for-audience clear), all source/scripts carry the standard GPL header
   comment, `dist/` ignored, `verify:omr-demo` wired into package.json; repo initialized
   (commit `76cfde7`), 40 files tracked, clean tree. **Published to GitHub** (Sep 23 2026):
   origin = `https://github.com/willl376/sheet2sound.git`, public, default branch `master`,
   root commit pushed `08be8a5`. Auth = GitHub CLI 2.101.0 (installed via winget to
   `C:\Program Files\GitHub CLI\gh.exe`; call via full path or a fresh shell — PATH not refreshed
   in old shells), logged in as `willl376` via device flow; git protocol = https (GCM).
   NOTE: the earlier Windows Credential Manager GitHub token was stale (401) — use `gh`, not it.
3. ✅ **Per-measure tempo segments** — `src/player.js` ports vexml's TempoMap (`tempoSegments` +
    `msAt`/`beatsAt`/`bpmAt`, `QUARTERS_PER_UNIT`, `playbackTempoOf` precedence: `<metronome>` wins
    over `<sound tempo>`, else 120); `src/main.js` schedules at `timeline.msAt(beats)/1000` and the
    cursor inverts ticks through `beatsAt`. Fixture `scores/tempo-seq.xml` exercises metronome
    beat-units (quarter→60, half→120), measure-level `<sound>`, and a repeat whose back-jump
    re-applies marks — `test:player` (unit) + `verify:tempo` (E2E, EXACT vexml duration parity)
    green; carmen/avalon byte-identical (no marks). `git` commit made; tree clean.
4. ⏳ Multi-engine OMR voting (Clarity-OMR as second opinion) + concurrency safety.
5. ⏳ Persistence (store uploads/exports) + **offline SoundFont packing** (currently CDN-streamed).