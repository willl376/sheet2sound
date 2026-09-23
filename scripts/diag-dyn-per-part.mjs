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

// scripts/diag-dyn-per-part.mjs — dynamics count per part per page (to locate the 4 lost).
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';

const PAGES = [21, 22, 23, 24];
const xmlOf = (p) => {
  const e = unzipSync(new Uint8Array(readFileSync(`artifacts/avalon-page-${p}.mxl`)));
  const k = Object.keys(e).find((n) => /\.(musicxml|xml)$/i.test(n));
  return strFromU8(e[k]);
};

for (const p of PAGES) {
  const x = xmlOf(p);
  for (const pm of x.matchAll(/<part id="([^"]*)"[^>]*>([\s\S]*?)(?=<part id="|<\/score-partwise>)/g)) {
    const dyn = (pm[2].match(/<dynamics/g) || []).length;
    const words = [...pm[2].matchAll(/<words[^>]*>([^<]*)<\/words>/g)].map((m) => m[1]).filter(Boolean);
    console.log(`page ${p} part ${pm[1]}: dynamics=${dyn} words=${JSON.stringify(words.slice(0, 6))}`);
  }
}