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

// scripts/diag-legacy-utils.mjs — replicate merge-sheets.mjs part/lane assignment (and the
// "first" tracking) per page, so we can see exactly why the page 23 second Voice part is
// NOT folded (and why page 24's voice isn't lost, etc.).
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';

const PAGES = [21, 22, 23, 24];
const xmlOf = (p) => {
  const e = unzipSync(new Uint8Array(readFileSync(`artifacts/avalon-page-${p}.mxl`)));
  const k = Object.keys(e).find((n) => /\.(musicxml|xml)$/i.test(n));
  return strFromU8(e[k]);
};

const MEASURE_RE = /<measure\b[\s\S]*?<\/measure>/g;

// Same part-splitting as merge-sheets.mjs.
function partBlocks (xml) {
  const blocks = [];
  const re = /<part id="([^"]*)"[^>]*>/g;
  let m;
  while ((m = re.exec(xml))) {
    const id = m[1];
    const from = m.index + m[0].length;
    const next = xml.slice(from).search(/<part id="/);
    const endTag = xml.indexOf('</part>', from);
    let to = next >= 0 ? from + next : endTag;
    if (to < 0) to = xml.length;
    blocks.push({ id, xml: xml.slice(from, to) });
  }
  return blocks;
}

function partNames (xml) {
  const names = new Map();
  for (const m of xml.matchAll(/<score-part id="([^"]+)"[^>]*>[\s\S]*?<part-name>([^<]*)<\/part-name>/g)) {
    names.set(m[1], m[2].trim());
  }
  return names;
}

let voiceBlocks = 0;
let pianoBlocks = 0;
for (const p of PAGES) {
  const xml = xmlOf(p);
  const names = partNames(xml);
  for (const b of partBlocks(xml)) {
    const name = names.get(b.id) || '';
    const isPiano = /piano|keyboard|piano/i.test(name);
    const lane = isPiano ? 'Piano' : 'Voice';
    if (lane === 'Voice') voiceBlocks += 1; else pianoBlocks += 1;
    const isFirst = lane === 'Voice' ? voiceBlocks === 1 : pianoBlocks === 1;
    const measures = (b.xml.match(MEASURE_RE) || []).length;
    const notes = (b.xml.match(/<note\b/g) || []).length;
    const pitches = (b.xml.match(/<pitch>/g) || []).length;
    console.log(`page ${p} part ${b.id} name=${JSON.stringify(name)} lane=${lane} isFirst=${isFirst} measures=${measures} notes=${notes} pitches=${pitches}`);
  }
}