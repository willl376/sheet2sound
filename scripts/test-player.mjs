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

// scripts/test-player.mjs — unit test for the MusicXML -> timeline parser, on the
// real Audiveris export. Pass --quick to skip the file read (prints usage).
import { readFileSync } from 'node:fs';
import { DOMParser } from 'linkedom'; // lightweight DOM for Node
import { parseMusicXML, noteNameMap } from '../src/player.js';

const path = process.argv[2] || 'scores/carmen.xml';
const xml = readFileSync(path, 'utf8');

const t0 = Date.now();
const tl = parseMusicXML(xml, { DOMParser });
const parseMs = Date.now() - t0;

const failures = [];
const check = (name, cond, detail = '') => {
  if (!cond) failures.push(name + (detail ? ` — ${detail}` : ''));
};

// Ground truth from the XML itself.
const rawPitches = (xml.match(/<pitch>/g) || []).length;
const rawDurations = (xml.match(/<duration>/g) || []).length;
const xmlMeasureNumbers = new Set(
  [...xml.matchAll(/<measure\b[^>]*\bnumber="([^"]*)"/g)].map((m) => m[1]));
const rawMeasures = xmlMeasureNumbers.size;

const pitchEvents = tl.events.filter((e) => e.midi != null);

check('tempo default 120', tl.tempo === 120, `got ${tl.tempo}`);
check('measure count === XML', new Set(tl.events.map((e) => e.measure)).size === rawMeasures);
check('totalBeats > 0', tl.totalBeats > 0, `got ${tl.totalBeats}`);
check('durationMs > 0', tl.durationMs > 0, `got ${tl.durationMs}`);
check('midi range sane', pitchEvents.every((e) => e.midi >= 21 && e.midi <= 108));
check('every event within [0, totalBeats]', tl.events.every((e) =>
  e.startBeats >= -0.001 && e.startBeats + e.durBeats <= tl.totalBeats + 0.001));
// Multi-voice timeline: within a (measure, voice) lane starts must be non-decreasing.
// Chords share the base note's start exactly; anything starting earlier = a backwards jump
// (e.g. a <backup> the parser failed to honour), which would desync playback.
check('per (measure, voice) lane starts monotonic', (() => {
  const lastStart = new Map();
  for (const e of tl.events) {
    const key = `${e.measure}\u0000${e.voice || '1'}`;
    const l = lastStart.get(key) ?? -Infinity;
    if (e.startBeats < l - 0.001) return false; // chord overlap allowed, backwards jumps not
    lastStart.set(key, Math.max(l, e.startBeats));
  }
  return true;
})());

// Note set sanity for sampler mapping.
const notes = noteNameMap(tl.events);
check('note map non-empty', notes.length > 0 && notes[0].file.endsWith('.mp3'));

// Carmen ground truth: full 2/4 measures with two voices per measure — every measure must
// span exactly 2 beats, and the m5↔m12 repeat + voltas 1/2 must EXPAND (RepeatList port):
// 30 measure occurrences × 2 beats = 60 beats / 30 s, not the 46 beats the old linear
// timeline produced (which ignored the repeat and desynced from vexml's expanded cursor).
if (path.includes('carmen.xml')) {
  check('time sig 2/4', tl.timeSignature?.beats === 2 && tl.timeSignature?.beatType === 4,
    JSON.stringify(tl.timeSignature));
  check('divisions 12', tl.divisions === 12, `got ${tl.divisions}`);
  const repeat = (xml.match(/repeat direction="backward"/g) || []).length;
  check('pitch events expanded past written count (repeat replays m5–m11)',
    pitchEvents.length === rawPitches + (repeat >= 1 ? 59 : 0),
    `${pitchEvents.length} vs ${rawPitches}`);
  check('measure 13 present (the D-major key-change section)',
    tl.events.some((e) => e.measure === '13'));
  check('carmen: every measure occurrence spans ~2 beats (2/4, both voices)', (() => {
    const byOcc = new Map();
    for (const e of tl.events) {
      const a = byOcc.get(`${e.measure}\u0000${e.occ}`) ?? { min: Infinity, max: 0 };
      a.min = Math.min(a.min, e.startBeats);
      a.max = Math.max(a.max, e.startBeats + e.durBeats);
      byOcc.set(`${e.measure}\u0000${e.occ}`, a);
    }
    return [...byOcc.values()].every((a) => (a.max - a.min) > 1.99 && (a.max - a.min) < 2.01);
  })());
  check('carmen: occurrences expanded (repeat m5↔m12 + voltas)', tl.occurrences.length === 30,
    `got ${tl.occurrences?.length}`);
  check('carmen: repeated measures replay with ascending occ', (() => {
    const seen = new Map(); // measure -> [occ...]
    for (const e of tl.events) {
      const list = seen.get(e.measure) ?? [];
      if (!list.includes(e.occ)) list.push(e.occ);
      seen.set(e.measure, list);
    }
    // m5..m11 (the repeat body shared by both passes) must appear twice: occ 0 pass + occ 1 pass.
    return ['5', '6', '7', '8', '9', '10', '11'].every((m) => seen.get(m)?.length === 2);
  })());
  check('carmen: totalBeats === 60 (30 occurrences x 2 beats)', Math.abs(tl.totalBeats - 60) < 0.05,
    `got ${tl.totalBeats}`);
  check('carmen: durationMs === 30000 @ 120 QPM', Math.abs(tl.durationMs - 30000) < 400,
    `got ${tl.durationMs}`);
}

// Tempo-seq ground truth: per-measure tempo segments (vexml TempoMap parity). Six 4/4
// whole-note measures; m2 metronome quarter=60, m3 metronome half=60 (->120 via
// QUARTERS_PER_UNIT), m4 carries 120, m5 measure <sound tempo=180/>, m6 carries 180.
// forward repeat m2-left / backward m4-right replays m2..m4: 9 occurrences,
// segments [0,4)120 [4,8)60 [8,12)120 [12,16)120 [16,20)60 [20,24)120 [24,28)120
//          [28,32)180 [32,36)180, totalBeats 36, durationMs 20666.67.
if (path.includes('tempo-seq.xml')) {
  check('tempo-seq: time sig 4/4', tl.timeSignature?.beats === 4 && tl.timeSignature?.beatType === 4,
    JSON.stringify(tl.timeSignature));
  check('tempo-seq: 9 events (9 occurrences x 1 whole note)',
    tl.events.length === 9 && pitchEvents.length === 9,
    `${tl.events.length} events / ${pitchEvents.length} pitches`);
  check('tempo-seq: 9 occurrences expanded', tl.occurrences?.length === 9,
    `got ${tl.occurrences?.length}`);
  const occMeasures = (tl.occurrences ?? []).map((o) => o.measure).join(',');
  check('tempo-seq: occurrence order m1 m2 m3 m4 m2 m3 m4 m5 m6',
    occMeasures === '1,2,3,4,2,3,4,5,6', `got ${occMeasures}`);
  check('tempo-seq: startBeats 0,4,8,12,16,20,24,28,32',
    tl.events.every((e, i) => Math.abs(e.startBeats - i * 4) < 0.001), 'mismatch');
  check('tempo-seq: totalBeats === 36', Math.abs(tl.totalBeats - 36) < 0.05,
    `got ${tl.totalBeats}`);
  check('tempo-seq: durationMs === 20666.67 (folds marks; linear-120 = 18000)',
    Math.abs(tl.durationMs - 20666.67) < 40, `got ${tl.durationMs}`);
  check('tempo-seq: tempo (dropdown default) = 120 (first segment)',
    tl.tempo === 120, `got ${tl.tempo}`);
  const wantSegs = [[0, 4, 120], [4, 8, 60], [8, 12, 120], [12, 16, 120], [16, 20, 60],
    [20, 24, 120], [24, 28, 120], [28, 32, 180], [32, 36, 180]];
  check('tempo-seq: tempoSegments exact', (() => {
    const segs = (tl.tempoSegments ?? []).map((s) =>
      [+s.startBeat.toFixed(2), +s.endBeat.toFixed(2), s.bpm]);
    return JSON.stringify(segs) === JSON.stringify(wantSegs);
  })(), JSON.stringify((tl.tempoSegments ?? []).map((s) => [+s.startBeat.toFixed(2), +s.endBeat.toFixed(2), s.bpm])));
  const spots = [[0, 0], [2, 1000], [4, 2000], [8, 6000], [10, 7000], [12, 8000],
    [20, 14000], [28, 18000], [30, 18666.67], [36, 20666.67]];
  check('tempo-seq: msAt boundary spot checks', spots.every(([b, ms]) =>
    Math.abs(tl.msAt(b) - ms) < 1.5), spots.map(([b]) => `${b}->${tl.msAt(b)}`).join(' '));
  check('tempo-seq: beatsAt inverts msAt', [[1000, 2], [6000, 8], [20666.67, 36]]
    .every(([ms, b]) => Math.abs(tl.beatsAt(ms) - b) < 0.05), 'mismatch');
  check('tempo-seq: bpmAt carries + back-jump re-applies', (() => {
    const probe = [[0, 120], [5, 60], [9, 120], [13, 120], [17, 60], [25, 120], [29, 180], [35, 180]];
    return probe.every(([b, bpm]) => tl.bpmAt(b) === bpm);
  })(), [0, 5, 9, 13, 17, 25, 29, 35].map((b) => `${b}->${tl.bpmAt(b)}`).join(' '));
}

console.log(JSON.stringify({
  ok: failures.length === 0,
  parseMs,
  tempo: tl.tempo,
  divisions: tl.divisions,
  timeSignature: tl.timeSignature,
  totalBeats: +tl.totalBeats.toFixed(2),
  durationMs: Math.round(tl.durationMs),
  events: tl.events.length,
  pitchEvents: pitchEvents.length,
  rests: tl.events.length - pitchEvents.length,
  distinctMeasures: new Set(tl.events.map((e) => e.measure)).size,
  distinctMidis: new Set(pitchEvents.map((e) => e.midi)).size,
  firstEvent: tl.events[0],
  lastEvent: tl.events[tl.events.length - 1],
  failures,
}, null, 2));

process.exit(failures.length === 0 ? 0 : 1);