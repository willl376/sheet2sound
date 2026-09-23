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

// scripts/diag-lanes.mjs — report (measure, voice) lane violations in a parse.
import { readFileSync } from 'node:fs';
import { DOMParser } from 'linkedom';
import { parseMusicXML } from '../src/player.js';

const path = process.argv[2] || 'scores/avalon.musicxml';
const tl = parseMusicXML(readFileSync(path, 'utf8'), { DOMParser });

const lastEnd = new Map();
let hits = 0;
for (const e of tl.events) {
  const key = `${e.measure}\u0000${e.voice || '1'}`;
  const l = lastEnd.get(key) ?? -Infinity;
  if (e.startBeats < l - 0.5) {
    console.log(`VIOLATION m${e.measure} v${e.voice} start=${e.startBeats.toFixed(3)} prevEnd=${l.toFixed(3)} midi=${e.midi} dur=${e.durBeats}` +
      `  [${e.midi == null ? 'REST' : ''}]`);
    if (++hits > 25) break;
  }
  lastEnd.set(key, Math.max(l, e.startBeats + e.durBeats));
}

// Also dump per-measure span vs written 4q for the first few pages to see content stretches.
console.log('\n--- measures whose span exceeds 4 quarters (first 20) ---');
const byMeasure = new Map();
for (const e of tl.events) {
  const a = byMeasure.get(e.measure) ?? { min: Infinity, max: 0 };
  a.min = Math.min(a.min, e.startBeats);
  a.max = Math.max(a.max, e.startBeats + e.durBeats);
  byMeasure.set(e.measure, a);
}
let shown = 0;
for (const [m, a] of [...byMeasure.entries()].sort((x, y) => x[0] - y[0])) {
  const span = a.max - a.min;
  if (span > 4.001 || span < 3.999) {
    console.log(`m${m} span=${span.toFixed(2)}q events=${tl.events.filter((e) => e.measure === m).length}`);
    if (++shown > 40) break;
  }
}
console.log(`totalBeats=${tl.totalBeats.toFixed(2)}`);