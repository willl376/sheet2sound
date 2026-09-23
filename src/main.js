// sheet2sound — paper sheet music to sound (Audiveris OMR -> MusicXML -> vexml/VexFlow -> Tone.js).
// Copyright (C) 2026 The sheet2sound contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

// sheet2sound — frontend.
// Step 1: prove Audiveris -> vexml/VexFlow seam (renders scores/carmen.xml on load).
// Step 2: upload a scan/PDF -> Audiveris (via /api/transcribe) -> render the resulting .mxl.
// Step 3: playback — MusicXML -> note timeline -> Tone.js Sampler (SoundFont).
// Step 4: human verification — click/select a transcribed note, audit pitch & duration
//         against the original scan, fix, audition, and export the corrected score.
import { MDOMParser, MusicXMLSerializer } from '@stringsync/mdom';
import { render, EditingSession } from '@stringsync/vexml';
import * as Tone from 'tone';
import { unzipSync } from 'fflate';
import { parseMusicXML, noteNameMap } from './player.js';

// Complete 88-note acoustic grand piano SoundFont (MusyngKite, flat-named files).
const SOUNDFONT = 'https://gleitz.github.io/midi-js-soundfonts/MusyngKite/acoustic_grand_piano-mp3/';

// Value names, coarsest to finest (MusicXML note-type values).
const TYPE_BEATS = {
  whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25, '32nd': 0.125,
  '64th': 0.0625, '128th': 0.03125,
};
const TYPE_ORDER = Object.keys(TYPE_BEATS);

const scoreEl = document.getElementById('score');
const logEl = document.getElementById('log');
const statusEl = document.getElementById('playStatus');
const originalEl = document.getElementById('original');
const origNoteEl = document.getElementById('origNote');
const inspectorBody = document.getElementById('inspectorBody');
const report = (msg) => { logEl.textContent += msg + '\n'; };

window.addEventListener('error', (e) => report('page error: ' + e.message));
window.addEventListener('unhandledrejection', (e) => report('unhandled rejection: ' + e.reason));

let score = null;          // vexml Score
let editing = null;        // EditingController (input + selection overlay)
let editor = null;         // EditingSession (owns the editable document + history)
let doc = null;            // mdom MDocument
let fileNameBase = 'verified';
let busy = false;

const player = {
  timeline: null,          // parsed note timeline (src/player.js output)
  sampler: null,           // lazy Tone.Sampler
  state: 'idle',           // 'idle' | 'playing'
  timer: null,
};
window.__player = player;
window.__editCount = 0;    // incremented on every applied edit (for tests)

// Transport timeline is placed at 120 qpm (0.5 s per quarter); changing Transport.bpm rescales
// wall-clock playback live. Cursor beats come from ticks/PPQ so they stay musical at any tempo.
const REF_SEC_PER_BEAT = 0.5; // 60 / 120 — timeline placement reference
window.__Tone = Tone;
window.__transportBpm = () => Tone.Transport.bpm.value;

// Playback cursor: a position on the score's timeline (vexml CursorController) driven from
// the audio clock, with a red playhead bar and amber halos on the notes currently sounding.
let cursor = null;         // vexml CursorController (disposed with its score)
let playhead = null;       // built-in vertical-bar CursorView
let cursorRaf = 0;
const lit = new Set();     // rendered elements currently halo-lit
window.__haloCount = () => lit.size;

// Measure-anchored mapping from OUR beat axis to the sequence's ms axis. vexml's sequence paces
// each measure at its WRITTEN meter (2/4 -> 2 beats) and expands repeats, while the actual content
// (and our audio, derived from <duration> sums) may differ. Mapping position per measure keeps the
// cursor on the correct notes regardless: cursorMs = seqStartMs(measure) + frac * seqWidthMs(measure),
// where frac is our content beat within the measure. Rebuilds on every render (sequence + events).
// Since both timelines expand repeats the same way (MeasureSequenceIterator over part 0's barlines),
// our per-occurrence list pairs 1:1 with the sequence's per-occurrence step runs.
let measureMap = { map: [], starts: [] };

function buildMeasureMap () {
  const seq = score?.getSequence?.();
  if (!seq || !player.timeline?.events) { measureMap = { map: [], starts: [] }; return; }

  // Sequence per-occurrence spans: maximal runs of steps with the same measureIndex, in
  // playback order. A repeated measure yields one run per pass.
  const occRuns = [];
  for (const s of seq.getSteps()) {
    const last = occRuns[occRuns.length - 1];
    if (last && last.measureIndex === s.measureIndex) {
      last.endMs = Math.max(last.endMs, s.endMs);
    } else {
      occRuns.push({ measureIndex: s.measureIndex, startMs: s.startMs, endMs: s.endMs });
    }
  }

  const occurrences = player.timeline.occurrences ?? [];
  const starts = occurrences.map((o) => o.startBeats);

  // Pair our occurrence k with the next sequence run with the same measure index. When the
  // run list is empty or lengths drift (a content-less fill measure has no steps), glide on
  // the previous run's span so the cursor keeps moving along the sequence axis anyway.
  const map = [];
  let r = 0;
  let prevRun = null;
  for (const occ of occurrences) {
    let run = null;
    while (r < occRuns.length) {
      if (occRuns[r].measureIndex === occ.index) { run = occRuns[r]; r++; break; }
      r++; // a run whose measure we don't expect (drift) — skip it
    }
    run = run ?? prevRun ?? occRuns[r] ?? null;
    if (run) prevRun = run;
    map.push(run
      ? { seqStartMs: run.startMs, seqWidthMs: Math.max(run.endMs - run.startMs, 1) }
      : { seqStartMs: 0, seqWidthMs: Math.max(seq.getDurationMs(), 1) });
  }
  measureMap = { map, starts };
}

function cursorMsAt (ourBeats) {
  const { map, starts } = measureMap;
  if (!map.length) return 0;
  let k = map.length - 1;
  for (let i = 0; i < starts.length; i++) {
    if (ourBeats < starts[i]) { k = i - 1; break; }
  }
  k = Math.max(0, k);
  const span = (starts[k + 1] ?? player.timeline.totalBeats) - starts[k];
  const frac = Math.max(0, Math.min(1, (ourBeats - starts[k]) / Math.max(span, 1e-9)));
  const m = map[k];
  return m.seqStartMs + frac * m.seqWidthMs;
}

// --- Rendering + editing session ---

function serialize () {
  return new MusicXMLSerializer().serializeToString(doc);
}
window.__serialize = () => serialize();

function updateInspector () {
  const n = editor?.getFocus?.() ?? null;
  if (!n) { inspectorBody.innerHTML = '<span class="sub">— none — click a note in the score, or use ◀ ▶</span>'; return; }

  const measure = n.part.measures.find((m) => m.notes.includes(n));
  const measureNo = measure ? n.part.measures.indexOf(measure) + 1 : '?';
  const p = n.isRest ? null : n.pitch;
  const alter = p ? (p.alter ?? 0) : 0;
  const accidental = alter > 0 ? '♯'.repeat(alter) : alter < 0 ? '♭'.repeat(-alter) : '';
  const rows = [
    ['Measure', String(measureNo)],
    ['Voice', n.voice],
    ['Kind', n.isRest ? 'rest' : 'note'],
    ['Pitch', p ? `${p.step}${accidental}${p.octave}` : '—'],
    ['Midi', p ? String(((p.octave + 1) * 12) + ({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[p.step] ?? 0) + alter) : '—'],
    ['Duration', n.type ? `${n.type}${'.'.repeat(n.dots ?? 0)}` : (n.isGrace ? 'grace' : '—')],
    ['Divisions', n.duration != null ? String(n.duration) : '—'],
  ];
  inspectorBody.innerHTML = '<table>' + rows.map(([k, v]) =>
    `<tr><td>${k}</td><td><code>${v}</code></td></tr>`).join('') + '</table>';
}

async function attachController () {
  editing = score.createEditingController(editor, { selection: {} });

  // Playback cursor over this score's timeline: red bar + amber halo on sounding notes.
  // Disposed with the score (both render paths below recreate it).
  playhead = score.createPlayhead({ color: '#d32f2f', widthPx: 3 });
  cursor = score.createCursor();
  cursor.sync(playhead);
  cursor.follow();          // auto-scroll the bar into view during playback
  cursor.events.on('change', (e) => {
    for (const n of lit) {
      if (!e.highlighted.includes(n)) n.halo.off();
    }
    lit.clear();
    for (const n of e.highlighted) {
      n.halo.on('#ffca28');
      lit.add(n);
    }
  });
  cursor.events.on('dispose', () => { cursor = null; playhead = null; lit.clear(); });
  window.__cursor = cursor;
  buildMeasureMap(); // map OUR beat axis onto the sequence's measure spans

  // Re-affirm the retained selection so the halo overlay redraws on this new score.
  const focus = editor?.getFocus?.();
  if (focus) {
    try { editor.select(focus); } catch { /* selection may be stale — fine */ }
  }
}

async function renderScore (musicXMLText, label, opts = {}) {
  const t0 = performance.now();
  logEl.textContent = '';
  stopPlayback();

  player.timeline = parseMusicXML(musicXMLText);
  syncTempoDropdown(); // honor a written <sound tempo> like MuseScore (dropdown default)
  statusEl.textContent = `${player.timeline.events.length} notes · ${(player.timeline.durationMs / 1000).toFixed(1)} s @ ${selectedTempo()} QPM`;

  doc = new MDOMParser().parseFromString(musicXMLText);
  editor = new EditingSession(doc);
  editor.events.on('selectionchange', updateInspector);
  if (opts.original) showOriginal(opts.original);
  if (opts.fileNameBase) fileNameBase = opts.fileNameBase;
  document.getElementById('btnExport').disabled = false;

  score?.dispose?.();
  score = await render(doc, scoreEl);
  await attachController();

  report(`render() OK in ${(performance.now() - t0).toFixed(0)} ms — ${label}`);
  window.__score = score;
  window.__editor = editor;
  window.__doc = doc;
  updateInspector();
  return score;
}

// Re-render the SAME editable document after an edit (session selection survives).
async function rerenderForEdit () {
  stopPlayback(); // an edit mid-play disposes the cursor with the old score
  try {
    player.timeline = parseMusicXML(serialize());
    syncTempoDropdown();
  } catch (err) {
    report('timeline refresh failed: ' + err.message);
  }
  score?.dispose?.();
  score = await render(doc, scoreEl);
  await attachController();
  window.__score = score;
  window.__editCount += 1;
  updateInspector();
}

function showOriginal (file) {
  originalEl.src = URL.createObjectURL(file);
  originalEl.hidden = false;
  origNoteEl.textContent = `${file.name} (${file.size.toLocaleString()} bytes)`;
}

// --- MusicXML loading ---

async function unzipMxl (blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const files = unzipSync(bytes);
  const entry = Object.keys(files)
    .find((name) => /\.(musicxml|xml)$/i.test(name) && !name.startsWith('__MACOSX'));
  if (!entry) throw new Error('.mxl contains no .musicxml/.xml entry');
  const bytesOut = files[entry];
  return typeof bytesOut === 'string' ? bytesOut : new TextDecoder().decode(bytesOut);
}

async function onTranscribe (files) {
  if (busy) return; // ignore double-fire (input change + button click)
  const file = files[0];
  if (!file) return;
  busy = true;
  logEl.textContent = '';
  report(`selected ${file.name} (${file.size.toLocaleString()} bytes)`);

  const ext = '.' + (file.name.split('.').pop() || '').toLowerCase();
  const base = file.name.replace(/\.[^.]+$/, '');

  try {
    if (ext === '.mxl') {
      // Direct .mxl upload: unzip client-side, no OMR.
      const xml = await unzipMxl(file);
      await renderScore(xml, `${file.name} (unzipped, ${(xml.length / 1024).toFixed(1)} KiB)`,
        { fileNameBase: base });
    } else if (ext === '.musicxml' || ext === '.xml') {
      await renderScore(await file.text(), file.name, { fileNameBase: base });
    } else {
      // Scan/PDF: POST raw bytes to the vite plugin, which runs Audiveris.
      report(`POST /api/transcribe?name=${encodeURIComponent(file.name)} (Audiveris OMR, up to ~3 min)…`);
      const btn = document.getElementById('btnTranscribe');
      btn.disabled = true;
      try {
        const res = await fetch(`/api/transcribe?name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          body: file,
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
        }
        const elapsed = res.headers.get('X-Elapsed-Ms');
        const auditLog = res.headers.get('X-Audiveris-Log-B64');
        report(`Audiveris OK in ${elapsed} ms (exit ${res.headers.get('X-Audiveris-Exit')})`);
        const xml = await unzipMxl(await res.blob());
        await renderScore(xml, `${file.name} → MusicXML (${(xml.length / 1024).toFixed(1)} KiB)`,
          { original: file, fileNameBase: base });
        if (auditLog) window.__auditLog = auditLog;
      } finally {
        btn.disabled = false;
      }
    }
  } catch (err) {
    report('FAILED: ' + (err?.message || err));
  } finally {
    busy = false;
  }
}

// --- Pitch helpers (for verification edits) ---

const STEP_BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function pitchToMidi (p) {
  return ((p.octave + 1) * 12) + (STEP_BASE[p.step] ?? 0) + (p.alter ?? 0);
}
// Friendly spelling: keep the current step letter when the target fits within ±1
// accidental; otherwise fall back to the natural (preferred) spelling per pc.
function midiToPitch (midi, preferStep) {
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  if (preferStep && STEP_BASE[preferStep] != null) {
    let alter = pc - STEP_BASE[preferStep];
    if (alter > 2) alter -= 12;
    if (alter < -2) alter += 12;
    if (alter >= -1 && alter <= 1) return { step: preferStep, octave, alter };
  }
  const pairs = [['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0]];
  const [step, alter] = pairs[pc];
  return { step, octave, alter };
}

// Closest (type, dots) representation of a beat count, coarsest-first.
function bestRepr (beats) {
  for (const type of TYPE_ORDER) {
    for (let dots = 0; dots <= 2; dots++) {
      const v = TYPE_BEATS[type] * (2 - 2 ** -dots);
      if (Math.abs(v - beats) < 1e-9) return { type, dots };
    }
  }
  return null;
}
function noteBeats (n) {
  if (n.type == null) return null;
  return TYPE_BEATS[n.type] * (2 - 2 ** -(n.dots ?? 0));
}

// --- Verification edits ---

function semitone (delta) {
  const n = editor?.getFocus?.();
  if (!n || n.isRest) { report('select a pitched note first'); return; }
  const spec = midiToPitch(pitchToMidi(n.pitch) + delta, n.pitch.step);
  if (editor.setPitch(spec)) rerenderForEdit();
}

function scaleDuration (factor) {
  const n = editor?.getFocus?.();
  if (!n || n.type == null || n.isGrace) { report('select a note with a duration first'); return; }
  const beats = noteBeats(n) * factor;
  const spec = bestRepr(beats);
  if (!spec) { report(`no representation for ${beats} beats`); return; }
  n.setDuration(spec);      // structural edit: ripples the voice, keeps siblings anchored
  editor.clearHistory();    // structural edits live outside the pitch-edit history
  rerenderForEdit();
}

async function audition () {
  const n = editor?.getFocus?.();
  if (!n || n.isRest) { report('select a pitched note first'); return; }
  try { await Tone.start(); } catch { /* best effort */ }
  const sampler = await ensureSampler();
  try {
    sampler.triggerAttackRelease(
      Tone.Frequency(pitchToMidi(n.pitch), 'midi').toNote(), 0.6, Tone.now() + 0.02,
      undefined, 1);
  } catch (err) {
    report('audition warning: ' + err.message);
  }
}

function exportXML () {
  const xmlStr = serialize();
  window.__exportStr = xmlStr;   // for tests
  const blob = new Blob([xmlStr], { type: 'application/vnd.recordare.musicxml+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${fileNameBase || 'verified'}.musicxml`;
  a.click();
  report(`exported ${fileNameBase}.musicxml (${blob.size.toLocaleString()} bytes)`);
}

// --- Playback ---

function selectedTempo () {
  return Number(document.getElementById('tempo').value) || 120;
}

// Honor a written <sound tempo> like MuseScore: if the file declares one (60–180), snap the
// dropdown to the nearest option; otherwise leave the user's choice alone.
function syncTempoDropdown () {
  const written = player.timeline?.tempo;
  const el = document.getElementById('tempo');
  if (written && written >= 60 && written <= 180) {
    const opts = [...el.options].map((o) => Number(o.value));
    const nearest = opts.reduce((best, o) => Math.abs(o - written) < Math.abs(best - written) ? o : best, opts[0]);
    el.value = String(nearest);
  }
}

async function ensureSampler () {
  if (player.sampler) return player.sampler;
  const notes = noteNameMap(player.timeline.events);
  const urls = Object.fromEntries(notes.map((n) => [n.name, n.file]));
  const sampler = new Tone.Sampler({
    urls,
    baseUrl: SOUNDFONT,
    release: 1.0,
  }).toDestination();
  player.sampler = sampler;

  // Wait until the SoundFont samples are decoded (bounded wait — never hang).
  const isLoaded = () => !!sampler.loaded || !!sampler.buffers?.loaded;
  if (!isLoaded()) {
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 6000); // proceed anyway after 6s
      const prev = sampler.onload;
      sampler.onload = () => { clearTimeout(t); prev?.(); resolve(); };
    });
  }
  return sampler;
}

async function play () {
  if (player.state === 'playing' || !player.timeline?.events?.length) return;
  try { await Tone.start(); } catch { /* audio context may be unavailable; still schedule */ }

  // Flip state first so UI/tests observe 'playing' while samples load.
  player.state = 'playing';
  document.getElementById('btnPlay').textContent = '▶ Loading…';

  const sampler = await ensureSampler();

  const qpm = selectedTempo();
  // Schedule once at MUSICAL position (timeline placed at 120 qpm). Changing Transport.bpm later
  // rescales wall-clock playback from the current moment — live tempo changes, no Stop+Play.
  Tone.Transport.stop();
  Tone.Transport.cancel();
  Tone.Transport.bpm.value = qpm;

  let scheduled = 0;
  try {
    for (const e of player.timeline.events) {
      if (e.midi == null || e.rest) continue;
      const note = Tone.Frequency(e.midi, 'midi').toNote();
      const dur = Math.max(e.durBeats * (60 / qpm) * 0.95, 0.05);
      Tone.Transport.schedule((time) => {
        try { sampler.triggerAttackRelease(note, dur, time, undefined, e.velocity); } catch { /* noop */ }
      }, e.startBeats * REF_SEC_PER_BEAT);
      scheduled++;
    }
    // End-of-piece marker (cleared by stopPlayback/next play via Transport.cancel()).
    Tone.Transport.schedule(() => finishPlayback(), player.timeline.totalBeats * REF_SEC_PER_BEAT + 0.25);
    Tone.Transport.start();
  } catch (err) {
    // SoundFont samples may not have downloaded (e.g. sandboxed/offline env).
    report('playback warning: ' + err.message);
    stopPlayback();
    statusEl.textContent = 'audio unavailable here — ' + err.message;
    return;
  }

  statusEl.textContent = `playing ${scheduled} notes @ ${qpm} QPM`;
  startCursorFollow();
}

// Transport reached the end marker (or was told to finish) — flip state without tearing down.
function finishPlayback () {
  player.state = 'idle';
  cancelAnimationFrame(cursorRaf);
  Tone.Transport.stop();
  document.getElementById('btnPlay').textContent = '▶ Play';
  statusEl.textContent = 'done';
}

// Drive the cursor from the transport clock every frame: musical quarter-beats = ticks/PPQ
// (tempo-independent — live bpm changes keep bar + halos on exactly the notes being heard).
function startCursorFollow () {
  cancelAnimationFrame(cursorRaf);
  const tick = () => {
    if (player.state !== 'playing' || !cursor) return;
    const beats = Math.max(0, Tone.Transport.ticks / Tone.Transport.PPQ);
    cursor.seekMs(cursorMsAt(Math.min(beats, player.timeline.totalBeats)));
    cursorRaf = requestAnimationFrame(tick);
  };
  cursorRaf = requestAnimationFrame(tick);
}

async function stopPlayback () {
  cancelAnimationFrame(cursorRaf);
  clearTimeout(player.timer);
  if (player.sampler) {
    try { await player.sampler.releaseAll(); } catch { /* noop */ }
  }
  player.state = 'idle';
  document.getElementById('btnPlay').textContent = '▶ Play';
  // Park the cursor at the start and clear any sounding-note halos (seek emits synchronously,
  // so clear afterwards to also unlight whatever lit up at beat 0).
  if (cursor) cursor.seekBeats(0);
  for (const n of lit) n.halo.off();
  lit.clear();
}

// --- Wiring ---

const fileInput = document.getElementById('file');
document.getElementById('btnTranscribe').addEventListener('click', () => onTranscribe(fileInput.files));
fileInput.addEventListener('change', () => onTranscribe(fileInput.files));

document.getElementById('btnPlay').addEventListener('click', play);
document.getElementById('btnStop').addEventListener('click', () => { stopPlayback(); statusEl.textContent = 'stopped'; });
document.getElementById('tempo').addEventListener('change', () => {
  const qpm = selectedTempo();
  if (player.state === 'playing') {
    Tone.Transport.bpm.value = qpm; // live rescale, MuseScore-style — no Stop+Play
    statusEl.textContent = `playing @ ${qpm} QPM`;
  } else {
    statusEl.textContent = `tempo ${qpm} QPM (applied at ▶ Play)`;
  }
});

const nav = (dir) => {
  try { editor?.move?.(dir); } catch (err) { report(`nav ${dir}: ${err.message}`); }
};
document.getElementById('btnPrev').addEventListener('click', () => nav('previous'));
document.getElementById('btnNext').addEventListener('click', () => nav('next'));
document.getElementById('btnHigher').addEventListener('click', () => nav('higher'));
document.getElementById('btnLower').addEventListener('click', () => nav('lower'));
document.getElementById('btnSharp').addEventListener('click', () => semitone(1));
document.getElementById('btnFlat').addEventListener('click', () => semitone(-1));
document.getElementById('btnDouble').addEventListener('click', () => scaleDuration(2));
document.getElementById('btnHalve').addEventListener('click', () => scaleDuration(0.5));
document.getElementById('btnAudition').addEventListener('click', audition);
document.getElementById('btnUndo').addEventListener('click', () => { if (editor?.undo()) rerenderForEdit(); });
document.getElementById('btnRedo').addEventListener('click', () => { if (editor?.redo()) rerenderForEdit(); });
document.getElementById('btnExport').addEventListener('click', exportXML);

// Demo on load: the fixed Audiveris export of Carmen. `?demo=<file>` (in scores/) swaps the score,
// e.g. /?demo=carmen-omr.musicxml to load an OMR transcription saved to scores/.
(async () => {
  try {
    const demo = (new URLSearchParams(location.search).get('demo') || '').replace(/[^\w.-]/g, '');
    const path = demo ? 'scores/' + demo : 'scores/carmen.xml';
    const label = demo ? `${path} (OMR demo)` : 'scores/carmen.xml (demo)';
    const res = await fetch('/' + path);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    await renderScore(await res.text(), label);
  } catch (err) {
    report('demo load FAILED: ' + (err?.stack || err));
  }
})();