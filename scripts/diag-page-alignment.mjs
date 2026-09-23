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

// scripts/diag-page-alignment.mjs — Settle 675 (page union) vs 649 (merged) pitches:
// per-page part names + per-measure pitch counts, then a sequential alignment of page
// measures onto merged measure numbers, so any REAL drop stands out from benign
// page-boundary overlap double-counting.
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';

const PAGES = [21, 22, 23, 24];
const xmlOf = (p) => {
  const e = unzipSync(new Uint8Array(readFileSync(`artifacts/avalon-page-${p}.mxl`)));
  const k = Object.keys(e).find((n) => /\.(musicxml|xml)$/i.test(n));
  return strFromU8(e[k]);
};

function perMeasure (xml) {
  const parts = [];
  for (const m of xml.matchAll(/<part id="([^"]*)"[^>]*>([\s\S]*?)(?=<part id="|<\/score-partwise>)/g)) {
    const meas = [];
    for (const mm of m[2].matchAll(/<measure\b[^>]*\bnumber="([^"]*)"[^>]*>([\s\S]*?)<\/measure>/g)) {
      meas.push({
        no: mm[1],
        notes: (mm[2].match(/<note\b/g) || []).length,
        pitches: (mm[2].match(/<pitch>/g) || []).length,
      });
    }
    parts.push({ id: m[1], meas });
  }
  return parts;
}

for (const p of PAGES) {
  const x = xmlOf(p);
  const names = [...x.matchAll(/<score-part id="([^"]+)"[^>]*>[\s\S]*?<part-name>([^<]*)<\/part-name>/g)]
    .map((m) => `${m[1]}=${m[2].trim()}`).join(', ');
  console.log(`\n=== page ${p}  parts: ${names}`);
  for (const pt of perMeasure(x)) {
    console.log(`  part ${pt.id}: measures=${pt.meas.length} pitches=${pt.meas.reduce((a, m) => a + m.pitches, 0)}`);
    console.log('    ' + pt.meas.map((m) => `${m.no}:${m.pitches}`).join(' '));
  }
}

// Align pages* onto merged measure numbers (diag-piano-loss mapping):
//   merged 1..15  <- page 21 P1 mea1..15   (page 22 P1 mea1 overlaps p21 mea15)
//   merged 16..27 <- page 22 P1 mea2..13
//   merged 28..44 <- page 23 P1 mea??..??  (chorus resume; page 23 re-declares 4/4)
//   merged 45..62 <- page 24 P1
const merged = readFileSync('scores/avalon.musicxml', 'utf8');
const mPart = perMeasure(merged).find((pt) => pt.id === 'P1');
console.log('\n=== merged P1 per-measure pitches ===');
console.log(('    ' + mPart.meas.map((m) => `${m.no}:${m.pitches}`).join(' ')));