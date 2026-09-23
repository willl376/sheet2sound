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

// scripts/diag-page23-parts.mjs — inspect page 23's three parts.
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';

const e = unzipSync(new Uint8Array(readFileSync('artifacts/avalon-page-23.mxl')));
const k = Object.keys(e).find((n) => /\.(musicxml|xml)$/i.test(n));
const xml = strFromU8(e[k]);

for (const pid of ['P1', 'P2', 'P3']) {
  const start = xml.indexOf(`<part id="${pid}"`);
  const end = xml.indexOf('</part>', start);
  const seg = start >= 0 ? xml.slice(start, end) : '';
  const notes = [...seg.matchAll(/<note>[\s\S]*?<\/note>/g)].map((m) => {
    const s = m[0].match(/<step>(\w)<\/step>/);
    const o = m[0].match(/<octave>(\d+)<\/octave>/);
    const d = m[0].match(/<duration>(\d+)<\/duration>/);
    const v = m[0].match(/<voice>(\d+)<\/voice>/);
    return `${s ? s[1] : '·'}${o ? o[1] : ''}x${d ? d[1] : '·'}v${v ? v[1] : '·'}`;
  });
  const measures = [...seg.matchAll(/<measure /g)].length;
  const divs = seg.match(/<divisions>(\d+)<\/divisions>/)?.[1] ?? '-';
  console.log(`${pid} measures=${measures} notes=${notes.length} divisions=${divs}`);
  console.log(`   first 10: ${notes.slice(0, 10).join(' ')}`);
  console.log(`   last 6:   ${notes.slice(-6).join(' ')}`);
}