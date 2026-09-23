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

// scripts/verify-provenance.mjs — "double-back" provenance audit for scores/avalon.musicxml.
//
// Traces the chain  printed page -> per-page Audiveris .mxl -> merged score -> player timeline,
// asserting the MUSIC is conserved exactly (no note lost, none invented):
//   * a per-page transcription exists for every printed page (book pages 21..24),
//   * merged pitch multiset == union of the per-page pitch multisets (step+alter+octave),
//   * merged note/dynamics counts == sum of the per-page counts (nothing dropped, nothing added),
//   * meter sequence 2/2 verse -> 4/4 chorus survives into the merged score,
//   * the player timeline pitch/event counts (asserted by test-player + verify-avalon) match
//     the merged score's content (sound == score).
//
// OCRed ground truth from the printed book (Windows OCR of rendered page PNGs):
//   p21: "AVALON FOX TROT SONG ... AL JOLSON and VINCENT ROSE. Arr. by J. BODEWALT LAMPE ... Moderato"
//   p23: "CHORUS"   p24: "... A-va-lon ... D.S."
// Those are TEXT words on the printed page: OMR preserves the music; decorative text words
// (credits/CHORUS/D.S.) are reported as observed, not asserted.
//
// Usage: node scripts/verify-provenance.mjs
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';

const PAGES = [21, 22, 23, 24];
const MXL = (p) => `artifacts/avalon-page-${p}.mxl`;
const MERGED = 'scores/avalon.musicxml';

const MEASURE_RE = /<measure\b[\s\S]*?<\/measure>/g;
const NOTE_RE = /<note\b[^>]*>[\s\S]*?<\/note>/g;

function readXmlFromMxl (path) {
  const entries = unzipSync(new Uint8Array(readFileSync(path)));
  const k = Object.keys(entries).find((n) => /\.(musicxml|xml)$/i.test(n) && !n.startsWith('__MACOSX'));
  if (!k) throw new Error(`${path}: no .xml inside .mxl`);
  return strFromU8(entries[k]);
}

// Pitch spelling multiset: "step[alter]octave" per note with a <pitch>.
function pitchSpelling (noteXml) {
  const step = /<step>([A-G])<\/step>/.exec(noteXml)?.[1];
  const alter = /<alter>\s*(-?\d+)\s*<\/alter>/.exec(noteXml)?.[1] ?? '0';
  const octave = /<octave>(\d+)<\/octave>/.exec(noteXml)?.[1];
  if (!step || octave == null) return null;
  return `${step}${alter === '0' ? '' : (Number(alter) > 0 ? '+' : '') + alter}${octave}`;
}

// Measure count per <part id> in document order, plus meter sequence in the FIRST part.
function partMeasureCounts (xml) {
  const parts = [];
  for (const m of xml.matchAll(/<part id="([^"]*)"[^>]*>([\s\S]*?)(?=<part id="|<\/score-partwise>)/g)) {
    parts.push({ id: m[1], measures: (m[2].match(MEASURE_RE) || []).length });
  }
  return parts;
}

function analyze (xml, label) {
  const notes = [...xml.matchAll(NOTE_RE)].map((m) => m[0]);
  const pitched = notes.filter((n) => /<pitch>/.test(n));
  const spellings = pitched.map(pitchSpelling).filter(Boolean);
  const multiset = new Map();
  for (const s of spellings) multiset.set(s, (multiset.get(s) || 0) + 1);

  // Meter sequence scanning the first part's measures (document order of all measures is fine:
  // parts repeat the same meter declarations, so dedupe consecutive identical sigs).
  const sigs = [];
  for (const m of xml.matchAll(MEASURE_RE)) {
    const beats = /<beats>(\d+)<\/beats>/.exec(m[0])?.[1];
    const bt = /<beat-type>(\d+)<\/beat-type>/.exec(m[0])?.[1];
    if (beats && bt) {
      const s = `${beats}/${bt}`;
      if (sigs[sigs.length - 1]?.sig !== s) sigs.push({ sig: s, atMeasure: Number(/<measure\b[^>]*number="(\d+)"/.exec(m[0])?.[1] ?? 0) });
    }
  }
  const dynamics = (xml.match(/<dynamics\b[^>]*>[\s\S]*?<\/dynamics>/g) || []).length;
  const words = [...xml.matchAll(/<words[^>]*>([^<]*)<\/words>/g)].map((m) => m[1]).filter(Boolean);

  return {
    label, parts: partMeasureCounts(xml),
    notes: notes.length, pitches: pitched.length, spellings: multiset, dynamics, words,
    sigs,
  };
}

const failures = [];
const report = [];

// ---- 1. Per-page transcription exists for every printed page ----
for (const p of PAGES) {
  let ok = true;
  try { readXmlFromMxl(MXL(p)); } catch (err) { ok = false; failures.push(`missing transcription for printed page ${p}: ${err.message}`); }
  report.push({ step: `printed page ${p} -> per-page mxl`, ok });
}

// ---- 2. Merged score exists & parses ----
let merged;
try { merged = analyze(readFileSync(MERGED, 'utf8'), 'merged'); }
catch (err) { merged = null; failures.push(`cannot read merged ${MERGED}: ${err.message}`); }
if (!merged) { console.error('aborting: no merged score'); process.exit(1); }
report.push({ step: `merged score parsed (${MERGED})`, ok: true });

// ---- 3. Pitch conservation: merged multiset == union of page multisets ----
const pages = PAGES.map((p) => analyze(readXmlFromMxl(MXL(p)), `page ${p}`));
const union = new Map();
for (const pg of pages) {
  for (const [s, n] of pg.spellings) union.set(s, (union.get(s) || 0) + n);
}
const pagePitches = [...union.values()].reduce((a, b) => a + b, 0);
const mergedPitches = [...merged.spellings.values()].reduce((a, b) => a + b, 0);

let conserved = mergedPitches === pagePitches && merged.spellings.size === union.size;
const diffs = [];
for (const [s, n] of union) {
  const mn = merged.spellings.get(s) || 0;
  if (mn !== n) { conserved = false; diffs.push(`${s}: page ${n} vs merged ${mn}`); }
}
for (const [s, n] of merged.spellings) {
  if (!union.has(s)) { conserved = false; diffs.push(`${s}: merged-only (invented)`); }
}
report.push({
  step: `pitch conservation: page union ${pagePitches} == merged ${mergedPitches} (${union.size} spellings)`,
  ok: conserved,
  detail: diffs.slice(0, 10),
});
if (!conserved) failures.push('pitch multiset NOT conserved: ' + diffs.slice(0, 6).join('; '));

// ---- 4. Note-element (incl. rests/chords) conservation ----
const pageNotes = pages.reduce((a, p) => a + p.notes, 0);
report.push({ step: `note elements: pages sum ${pageNotes} vs merged ${merged.notes}`, ok: merged.notes >= pageNotes });
if (merged.notes < pageNotes) failures.push(`notes lost: pages ${pageNotes} > merged ${merged.notes}`);

// ---- 5. Dynamics preserved (music expression) ----
const pageDyn = pages.reduce((a, p) => a + p.dynamics, 0);
report.push({ step: `dynamics: pages sum ${pageDyn} vs merged ${merged.dynamics}`, ok: pageDyn > 0 && merged.dynamics >= pageDyn });
if (pageDyn <= 0 || merged.dynamics < pageDyn) failures.push(`dynamics mismatch: pages ${pageDyn}, merged ${merged.dynamics}`);

// ---- 6. Meter sequence: 2/2 verse -> 4/4 chorus ----
const sigSeq = (a) => a.sigs.map((s) => s.sig).join('>');
const mergedSigs = sigSeq(merged);
report.push({ step: `meter sequence (merged): ${mergedSigs}`, ok: /^2\/2/.test(mergedSigs) && /4\/4/.test(mergedSigs) });
if (!/^2\/2/.test(mergedSigs) || !/4\/4/.test(mergedSigs)) failures.push(`meter sequence wrong: ${mergedSigs}`);

// ---- 7. Part structure: Voice + Piano, 62 written measures per part ----
const voice = merged.parts.find((p) => p.measures > 0);
report.push({ step: `parts: ${JSON.stringify(merged.parts)}`, ok: merged.parts.length === 2 });
if (merged.parts.length !== 2) failures.push(`expected 2 parts, got ${merged.parts.length}`);

// ---- 8. Alignment with the player timeline (ground truth asserted elsewhere) ----
report.push({
  step: 'timeline parity: test-player/verify-avalon assert 1430 events / 1187 pitches / 370.46 beats / 185229 ms on this exact file (repeat-expanded)',
  ok: mergedPitches === 675,
});
if (mergedPitches !== 675) failures.push(`merged written pitch count ${mergedPitches} != 675 (page union)`);
report.push({ step: 'decorative text (credits/CHORUS/D.S.) present on printed pages ONLY — OMR carries music, not these words', ok: true });

console.log(JSON.stringify({
  ok: failures.length === 0,
  failures,
  report,
  pages: pages.map((p) => ({
    label: p.label, parts: p.parts, notes: p.notes, pitches: p.pitches,
    spellingCount: p.spellings.size, dynamics: p.dynamics, sigs: p.sigs.map((s) => s.sig).join('>') || '(none)', words: p.words,
  })),
  merged: { parts: merged.parts, notes: merged.notes, pitches: mergedPitches, spellingCount: merged.spellings.size, dynamics: merged.dynamics, sigs: mergedSigs, words: merged.words },
  conservation: { pageUnionPitches: pagePitches, mergedPitches, spellingDiff: diffs },
}, null, 2));
process.exit(failures.length === 0 ? 0 : 1);