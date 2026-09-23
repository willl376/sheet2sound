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

// scripts/diag-piano-loss.mjs — compare per-measure note counts: source Piano parts vs the
// merged Piano part, to locate the 4 missing piano notes (673 source -> 669 merged).
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';

function sourceCounts (page, partId) {
  const entries = unzipSync(new Uint8Array(readFileSync(`artifacts/avalon-page-${page}.mxl`)));
  const k = Object.keys(entries).find((fn) => /\.(musicxml|xml)$/i.test(fn));
  const xml = strFromU8(entries[k]);
  const pm = xml.match(new RegExp(`<part id="${partId}"[^>]*>([\\s\\S]*?)<\\/part>`));
  if (!pm) return null;
  const m = new Map();
  for (const m2 of pm[1].matchAll(/<measure\b[^>]*\bnumber="([^"]*)"[^>]*>([\s\S]*?)<\/measure>/g)) {
    m.set(m2[1], (m2[2].match(/<note\b/g) || []).length);
  }
  return m;
}

const mergedXml = readFileSync('scores/avalon.musicxml', 'utf8');
const pm = mergedXml.match(/<part id="P2"[^>]*>([\s\S]*?)<\/part>/);
const got = new Map();
for (const m2 of pm[1].matchAll(/<measure\b[^>]*\bnumber="([^"]*)"[^>]*>([\s\S]*?)<\/measure>/g)) {
  got.set(m2[1], (m2[2].match(/<note\b/g) || []).length);
}

// Expected mapping: pages are sequential 21 m1..16, 22 m16..28(-ish), 23 m28..45, 24 m45..62
// with the first measure of each new page overlapping the previous page's last. Build a naive
// per-measure-number source total using page 21 P1 numbering as the base reference:
// merged m=1..15 from p21 (m1..15 + overlap), 16..27 from p22, 28..44 from p23, 45..62 from p24.
const p21 = sourceCounts('21', 'P2');
const p22 = sourceCounts('22', 'P2');
const p23 = sourceCounts('23', 'P3');
const p24 = sourceCounts('24', 'P2');

console.log('page21 P2:', [...p21.entries()].map(([k, v]) => `${k}:${v}`).join(' '));
console.log('page22 P2:', [...p22.entries()].map(([k, v]) => `${k}:${v}`).join(' '));
console.log('page23 P3:', [...p23.entries()].map(([k, v]) => `${k}:${v}`).join(' '));
console.log('page24 P2:', [...p24.entries()].map(([k, v]) => `${k}:${v}`).join(' '));
console.log('merged P2:');
for (const [no, c] of [...got.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
  console.log(`  m${no}: ${c}`);
}