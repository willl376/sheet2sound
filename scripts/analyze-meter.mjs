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

// scripts/analyze-meter.mjs — per-measure: time signature vs actual content duration.
// Quantifies the "tempo not in sync with the time signature" complaint.
import { readFileSync } from 'node:fs';

const path = process.argv[2] || 'scores/carmen.xml';
const xml = readFileSync(path, 'utf8');
const divisions = Number((xml.match(/<divisions>(\d+)<\/divisions>/) || [, '12'])[1]);
const measures = [...xml.matchAll(/<measure\s[^>]*?(?:number="?([^"\s>]+)"?)?[^>]*>([\s\S]*?)<\/measure>/g)];

const rows = [];
let totalContentQuarters = 0;
for (const m of measures) {
  const body = m[2];
  const durs = [...body.matchAll(/<duration>(\d+)<\/duration>/g)].map((x) => Number(x[1]));
  const span = Math.max(0, ...durs) / divisions;
  const sig = (body.match(/<beats>(\d+)<\/beats>\s*<beat-type>(\d+)<\/beat-type>/) || [])[1]
    ? `${body.match(/<beats>(\d+)<\/beats>/)[1]}/${body.match(/<beat-type>(\d+)<\/beat-type>/)[1]}`
    : '?';
  totalContentQuarters += span;
  rows.push({ m: m[1] || '?', sig, notes: durs.length, spanQuarters: span });
}

console.log('file:', path, '| divisions:', divisions);
console.log(rows.map((r) => `M${r.m.padStart(2)} sig ${r.sig.padStart(3)}  notes ${String(r.notes).padStart(3)}  content ${r.spanQuarters} quarters`).join('\n'));
console.log(`measures: ${measures.length} | total content: ${totalContentQuarters} quarters = ${totalContentQuarters / 2} measures @ 2/4`);