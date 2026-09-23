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

// scripts/diag-compare-merges.mjs — compare committed scores/avalon.musicxml against a
// freshly re-merged file (same 4 page mxl inputs): per-part pitches, whole-file pitch
// multiset, and the per-measure pitch profile of the Voice part (to see the chorus gap).
import { readFileSync } from 'node:fs';

const A = readFileSync('scores/avalon.musicxml', 'utf8');
const B = readFileSync(process.argv[2] || `${process.env.TEMP}\\opencode\\avalonwork\\fresh-merge.musicxml`, 'utf8');

const NOTE_RE = /<note\b[^>]*>[\s\S]*?<\/note>/g;
const MEASURE_RE = /<measure\b[^>]*>[\s\S]*?<\/measure>/g;

function pitchOf (n) {
  const step = /<step>([A-G])<\/step>/.exec(n)?.[1];
  const alter = /<alter>\s*(-?\d+)\s*<\/alter>/.exec(n)?.[1] ?? '0';
  const oct = /<octave>(\d+)<\/octave>/.exec(n)?.[1];
  return step && oct != null ? `${step}${Number(alter) ? (Number(alter) > 0 ? '#' : 'b') + Math.abs(alter) : ''}${oct}` : null;
}

function analyze (xml) {
  const parts = [];
  for (const pm of xml.matchAll(/<part id="([^"]*)"[^>]*>([\s\S]*?)(?=<part id="|<\/score-partwise>)/g)) {
    const measures = [...pm[2].matchAll(MEASURE_RE)].map((m) => m[0]);
    const pitchProfile = new Map();
    measures.forEach((mm, i) => {
      const num = Number(/<measure\b[^>]*number="(\d+)"/.exec(mm)?.[1] ?? i + 1);
      pitchProfile.set(num, [...mm.matchAll(NOTE_RE)].filter((n) => /<pitch>/.test(n[0])).length);
    });
    const notes = [...pm[2].matchAll(NOTE_RE)].map((m) => m[0]);
    const spellings = notes.map(pitchOf).filter(Boolean);
    const ms = new Map();
    for (const s of spellings) ms.set(s, (ms.get(s) || 0) + 1);
    parts.push({ id: pm[1], measures: measures.length, pitches: spellings.length, ms, pitchProfile });
  }
  const allNotes = [...xml.matchAll(NOTE_RE)].map((m) => m[0]);
  const allSpell = allNotes.map(pitchOf).filter(Boolean);
  const allMs = new Map();
  for (const s of allSpell) allMs.set(s, (allMs.get(s) || 0) + 1);
  const rests = allNotes.filter((n) => /<rest>/.test(n)).length;
  return { parts, allMs, totalPitches: allSpell.length, totalNotes: allNotes.length, rests };
}

const a = analyze(A);
const b = analyze(B);
console.log(JSON.stringify({
  committed: { totalNotes: a.totalNotes, totalPitches: a.totalPitches, rests: a.rests, parts: a.parts.map((p) => ({ id: p.id, measures: p.measures, pitches: p.pitches })) },
  fresh: { totalNotes: b.totalNotes, totalPitches: b.totalPitches, rests: b.rests, parts: b.parts.map((p) => ({ id: p.id, measures: p.measures, pitches: p.pitches })) },
  multisetDiff: (() => {
    const out = [];
    const keys = new Set([...a.allMs.keys(), ...b.allMs.keys()]);
    for (const k of keys) if ((a.allMs.get(k) || 0) !== (b.allMs.get(k) || 0)) out.push(`${k}: committed ${a.allMs.get(k) || 0} vs fresh ${b.allMs.get(k) || 0}`);
    return out.slice(0, 30);
  })(),
  committedVoicePitchProfile: [...a.parts[0].pitchProfile.entries()].map(([k, v]) => `${k}:${v}`).join(' '),
  freshVoicePitchProfile: [...b.parts[0].pitchProfile.entries()].map(([k, v]) => `${k}:${v}`).join(' '),
}, null, 2));