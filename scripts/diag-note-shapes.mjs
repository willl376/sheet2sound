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

// scripts/diag-note-shapes.mjs — dump the first <note ...> element of every part on every
// page (and which regexes match it), to confirm why merge-sheets' fold drops page 23 P2.
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';

const PAGES = [21, 22, 23, 24];
const xmlOf = (p) => {
  const e = unzipSync(new Uint8Array(readFileSync(`artifacts/avalon-page-${p}.mxl`)));
  const k = Object.keys(e).find((n) => /\.(musicxml|xml)$/i.test(n));
  return strFromU8(e[k]);
};

const BARE = /<note>[\s\S]*?<\/note>/g;
const ATTR = /<note\b[^>]*>[\s\S]*?<\/note>/g;

for (const p of PAGES) {
  const x = xmlOf(p);
  for (const pm of x.matchAll(/<part id="([^"]*)"[^>]*>([\s\S]*?)(?=<part id="|<\/score-partwise>)/g)) {
    const id = pm[1];
    const body = pm[2];
    const firstNote = body.match(/<note\b[^>]*>/)?.[0] ?? '(no notes)';
    const bareN = (body.match(BARE) || []).length;
    const attrN = (body.match(ATTR) || []).length;
    const pitches = (body.match(/<pitch>/g) || []).length;
    console.log(`page ${p} part ${id}: pitches=${pitches} bareNoteMatches=${bareN} attrNoteMatches=${attrN} firstNote=${JSON.stringify(firstNote.slice(0, 40))}`);
  }
}