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

// scripts/diag-voices.mjs — per-measure voice/backup content audit for a MusicXML file.
// Answers: which measures are overfull vs written meter, which lack <backup> between voices,
// and what each (measure, voice) lane actually contains. Use on merged page exports.
import { readFileSync } from 'node:fs';
import { DOMParser } from 'linkedom';
import { parseMusicXML } from '../src/player.js';

const path = process.argv[2] || 'scores/avalon.musicxml';
const only = (process.argv[3] || '').split(',').map((s) => Number(s)).filter(Boolean);
const xml = readFileSync(path, 'utf8');
const doc = new DOMParser().parseFromString(xml, 'application/xml');
const part = doc.querySelector('part');

let carry = { beats: 2, bt: 2 }; // last declared meter (avalon: 2/2 verse)
let carryDiv = 4;
const rows = [];
let overfull = 0;
let withTicksButNoBackup = 0;

for (const m of part.querySelectorAll('measure')) {
  const no = m.getAttribute('number');
  const divEl = m.querySelector(':scope > attributes > divisions');
  if (divEl) carryDiv = Number(divEl.textContent) || carryDiv;
  const tsEl = m.querySelector(':scope > attributes > time');
  if (tsEl) {
    const b = Number(tsEl.querySelector('beats')?.textContent);
    const bt = Number(tsEl.querySelector('beat-type')?.textContent);
    if (b && bt) carry = { beats: b, bt };
  }
  const writtenQ = carry.beats * (4 / carry.bt); // quarters in the written meter
  const writtenT = writtenQ * carryDiv;

  const backups = [...m.querySelectorAll(':scope > backup')];
  const forwards = [...m.querySelectorAll(':scope > forward')];
  const notes = [...m.querySelectorAll(':scope > note')];

  const byVoice = new Map();
  let posT = 0; // element-order reading position (like our parser)
  let maxEndT = 0;
  for (const n of notes) {
    const v = n.querySelector('voice')?.textContent || '1';
    const d = Number(n.querySelector('duration')?.textContent) || 0;
    const s = n.querySelector('chord') ? posT : posT;
    maxEndT = Math.max(maxEndT, s + d);
    const lane = byVoice.get(v) ?? { notes: 0, sumT: 0, starts: [] };
    lane.notes += 1;
    lane.sumT += d;
    lane.starts.push(s / carryDiv);
    byVoice.set(v, lane);
    posT += d;
  }
  for (const b of backups) posT -= Number(b.querySelector('duration')?.textContent) || 0;
  for (const f of forwards) posT += Number(f.querySelector('duration')?.textContent) || 0;

  const voiceSumT = [...byVoice.values()].reduce((a, l) => a + l.sumT, 0);
  const over = maxEndT > writtenT + 0.001;
  const noBackup = notes.length > 1 && backups.length === 0 && forwards.length === 0;
  if (over) overfull += 1;
  if (over) withTicksButNoBackup += 1;
  if (over || (only.length && only.includes(Number(no)))) {
    const voiceLines = [...byVoice.entries()].map(([v, l]) =>
      `v${v}: ${l.notes}n sum=${(l.sumT / carryDiv).toFixed(2)}q [${l.starts.map((s) => s.toFixed(1)).join(',')}]`).join(' | ');
    rows.push({
      measure: no,
      meter: `${carry.beats}/${carry.bt}`,
      notes: notes.length,
      contentEndQ: +(maxEndT / carryDiv).toFixed(2),
      writtenQ,
      voiceSumQ: +(voiceSumT / carryDiv).toFixed(2),
      backups: backups.length,
      forwards: forwards.length,
      voices: voiceLines,
    });
  }
}

console.log(JSON.stringify({
  totalMeasures: part.querySelectorAll('measure').length,
  overfull: { count: overfull, noBackupThanks: withTicksButNoBackup },
  rows,
}, null, 2));

// Our timeline total for context.
const tl = parseMusicXML(xml, { DOMParser });
console.log(`tl.totalBeats=${tl.totalBeats.toFixed(2)} (=${(tl.totalBeats * 0.5 / 60).toFixed(1)} min @ 120 QPM), written-only would be 4 quarters x 133 ≈ ${(133 * 4).toFixed(0)} beats`);