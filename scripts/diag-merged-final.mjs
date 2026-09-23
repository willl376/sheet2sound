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

// scripts/diag-merged-final.mjs — quick anatomy of a merged .musicxml (parts, counts, meters).
import { readFileSync } from 'node:fs';
import { DOMParser } from 'linkedom';

const xml = readFileSync('scores/avalon.musicxml', 'utf8');
const doc = new DOMParser().parseFromString(xml, 'application/xml');
const root = doc.documentElement;

const names = [...root.querySelectorAll('part-list > score-part')].map((s) =>
  s.querySelector('part-name')?.textContent?.trim() ?? '?');
const parts = [...root.querySelectorAll(':scope > part')];

const out = parts.map((part, p) => {
  let div = 12, sig = null, curSig = null;
  const measures = [...part.querySelectorAll(':scope > measure')];
  const meterChanges = [];
  for (const m of measures) {
    const divEl = m.querySelector(':scope > attributes > divisions');
    if (divEl) div = Number(divEl.textContent) || div;
    const tsEl = m.querySelector(':scope > attributes > time');
    if (tsEl) {
      const b = Number(tsEl.querySelector('beats')?.textContent);
      const bt = Number(tsEl.querySelector('beat-type')?.textContent);
      if (b && bt) {
        curSig = { beats: b, beatType: bt };
        if (!sig) sig = curSig;
        meterChanges.push(`m${m.getAttribute('number')}=${b}/${bt}`);
      }
    }
  }
  const notes = measures.reduce((a, m) => a + (m.querySelectorAll(':scope > note').length), 0);
  return { name: names[p] ?? `P${p + 1}`, measures: measures.length, notes, meterChanges };
});

console.log(JSON.stringify({
  title: root.querySelector('work > work-title')?.textContent ?? null,
  divisions: parts[0]?.querySelector('attributes > divisions')?.textContent ?? null,
  parts: out,
  valid: true,
}, null, 2));