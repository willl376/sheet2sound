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

// scripts/diag-overfull.mjs — per (part, measure): content span vs written meter, in the
// FILE's own units (quarters from <duration>/divisions), i.e. what MuseScore must fit.
// Reports measures whose content exceeds the written span beyond MuseScore's OWN tolerance:
// its MusicXML importer works on a 480-tick-per-quarter grid and forgives up to maxDiff = 3
// internal ticks (importmxmlnoteduration.cpp) => 3/480 = 0.00625 quarters. Anything more is
// a measure MuseScore 3 would grow/warn on ("measure too long" content shifting).
import { readFileSync } from 'node:fs';
import { DOMParser } from 'linkedom';

const path = process.argv[2] || 'scores/avalon.musicxml';
const xml = readFileSync(path, 'utf8');
const doc = new DOMParser().parseFromString(xml, 'application/xml');
const parts = [...doc.documentElement.querySelectorAll(':scope > part')];

const MUSESCORE_MAXDIFF_Q = 3 / 480; // MuseScore-internal tolerance, in quarter-note units

const report = [];
let overfull = 0;
let totalMeasures = 0;

for (let p = 0; p < parts.length; p++) {
  let div = 12;
  let sig = null;
  let curSig = null;
  for (const m of parts[p].querySelectorAll(':scope > measure')) {
    const no = m.getAttribute('number');
    totalMeasures += 1;
    const divEl = m.querySelector(':scope > attributes > divisions');
    if (divEl) div = Number(divEl.textContent) || div;
    const tsEl = m.querySelector(':scope > attributes > time');
    if (tsEl) {
      const b = Number(tsEl.querySelector('beats')?.textContent);
      const bt = Number(tsEl.querySelector('beat-type')?.textContent);
      if (b && bt) curSig = { beats: b, beatType: bt };
      if (!sig) sig = curSig;
    }
    const writtenQ = curSig ? curSig.beats * (4 / curSig.beatType) : null;
    let pos = 0;
    let lastStart = 0;
    let maxEnd = 0;
    const perVoice = new Map();
    for (const el of [...m.querySelectorAll(':scope > *')]) {
      const tag = el.nodeName;
      if (tag === 'backup' || tag === 'forward') {
        const d = Number(el.querySelector('duration')?.textContent) || 0;
        pos = tag === 'backup' ? Math.max(0, pos - d) : pos + d;
        continue;
      }
      if (tag !== 'note') continue;
      const v = el.querySelector('voice')?.textContent || '1';
      const d = Number(el.querySelector('duration')?.textContent) || 0;
      const chord = el.querySelector(':scope > chord') != null;
      const lane = perVoice.get(v) ?? { sum: 0, notes: 0 };
      lane.sum += d; lane.notes += 1; perVoice.set(v, lane);
      const start = chord ? lastStart : pos;
      if (!chord) pos += d;
      lastStart = start;
      maxEnd = Math.max(maxEnd, start + d);
    }
    const over = writtenQ != null && maxEnd / div > writtenQ + MUSESCORE_MAXDIFF_Q;
    if (over) {
      overfull += 1;
      report.push({
        part: p + 1, measure: no, meter: curSig ? `${curSig.beats}/${curSig.beatType}` : '?',
        contentQ: +(maxEnd / div).toFixed(2), writtenQ,
        voices: [...perVoice.entries()].map(([v, l]) => `v${v}:${l.notes}n`).join(' '),
      });
    }
  }
}

console.log(JSON.stringify({ totalMeasures, overfull, report }, null, 2));