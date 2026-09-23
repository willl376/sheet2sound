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

// scripts/diag-parts.mjs — part/staff structure of Audiveris .mxl exports, with per-part
// measure & note counts (the note counts are the ground truth for merge-loss checks; e.g. a
// fit-to-meter regression once silently dropped 4 piano notes).
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';

for (const p of process.argv.slice(2)) {
  const e = unzipSync(new Uint8Array(readFileSync(p)));
  const k = Object.keys(e).find((n) => /\.(musicxml|xml)$/i.test(n));
  const xml = strFromU8(e[k]);
  const nameById = new Map();
  for (const m of xml.matchAll(/<score-part id="([^"]+)"[^>]*>[\s\S]*?<part-name>([^<]*)<\/part-name>/g)) {
    nameById.set(m[1], m[2].trim());
  }
  const parts = [];
  for (const m of xml.matchAll(/<part id="([^"]+)"[^>]*>([\s\S]*?)<\/part>/g)) {
    parts.push({
      id: m[1],
      name: nameById.get(m[1]) ?? '?',
      measures: (m[2].match(/<measure\b/g) || []).length,
      notes: (m[2].match(/<note\b/g) || []).length,
    });
  }
  const stavesSeen = [...new Set([...xml.matchAll(/<staff>(\d+)<\/staff>/g)].map((m) => m[1]))];
  console.log(JSON.stringify({ file: p.split(/[\\/]/).pop(), parts, staves: stavesSeen }, null, 0));
}