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

// scripts/diag-fold-trace.mjs — trace merge-sheets.mjs's fold branch for page 23's P2
// (second Voice part, 26 pitches) to see exactly why 0 folds happened.
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';

const xmlOf = (p) => {
  const e = unzipSync(new Uint8Array(readFileSync(`artifacts/avalon-page-${p}.mxl`)));
  const k = Object.keys(e).find((n) => /\.(musicxml|xml)$/i.test(n));
  return strFromU8(e[k]);
};

const MEASURE_RE = /<measure\b[\s\S]*?<\/measure>/g;
const NOTE_RE = /<note>[\s\S]*?<\/note>/g;

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

const xml = xmlOf(23);
const names = partNames(xml);
const blocks = partBlocks(xml);
let voiceBlocks = 0;
let pianoBlocks = 0;

for (const b of blocks) {
  const name = names.get(b.id) || '';
  const isPiano = /piano|keyboard|piano/i.test(name);
  const lane = isPiano ? 'Piano' : 'Voice';
  if (lane === 'Voice') voiceBlocks += 1; else pianoBlocks += 1;
  const isFirst = lane === 'Voice' ? voiceBlocks === 1 : pianoBlocks === 1;
  const measures = [...b.xml.matchAll(MEASURE_RE)].map((m) => m[0]);
  console.log(`part ${b.id} name=${JSON.stringify(name)} lane=${lane} first=${isFirst} measures=${measures.length}`);

  if (lane === 'Voice' && !isFirst) {
    // replicate fold branch
    const notesTotal = measures.reduce((a, f) => a + (f.match(/<note>/g) || []).length, 0);
    const noteReCounts = measures.map((f) => (f.match(/<note>/g) || []).length);
    console.log(`  fold branch engaged: notes=${notesTotal}, per-measure=${noteReCounts.join(',')}`);
    const p1 = measures[0];
    const used = new Set([...(p1.match(/<voice>(\d+)<\/voice>/g) || [])].map((m) => m[1]));
    console.log(`  measure0 voices used: ${[...used].join(',')}`);
  }
  if (lane === 'Voice' && isFirst) {
    const noteReCounts = measures.map((f) => (f.match(/<note>/g) || []).length);
    console.log(`  (primary) notes per measure: ${noteReCounts.join(',')}`);
  }
}