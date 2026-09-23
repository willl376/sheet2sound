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