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

// scripts/diag-repeats.mjs — dump the repeat/ending/barline structure per measure of a score,
// from the FIRST part (the system-authoritative lane, matching vexml), plus intended D.S./coda text.
import { readFileSync } from 'node:fs';

const path = process.argv[2] || 'scores/carmen.xml';
const xml = readFileSync(path, 'utf8');

const parts = [...xml.matchAll(/<part\b[^>]*>([\s\S]*?)<\/part>/g)].map((m) => m[1]);
const first = parts[0] ?? xml;
const measures = [...first.matchAll(/<measure\b[^>]*>([\s\S]*?)<\/measure>/g)];
const out = [];
for (const [i, m] of measures.entries()) {
  const num = /<measure\b[^>]*number="([^"]*)"/.exec(m[0])?.[1] ?? String(i + 1);
  const body = m[1];
  const barlines = [...body.matchAll(/<barline\b[^>]*>([\s\S]*?)<\/barline>/g)]
    .map((b) => {
      const inner = b[1];
      const repeat = /<repeat\b([^>]*)(?:\/>|>)/.exec(inner);
      const ending = /<ending\b([^>]*)(?:\/>|>)/.exec(inner);
      return {
        repeat: repeat ? repeat[1].trim() : null,
        ending: ending ? ending[1].trim() : null,
      };
    })
    .filter((b) => b.repeat || b.ending);
  // Text directions that mention repeat-related words (D.S. / D.C. / segno / coda / fine / "To Coda")
  const words = [...body.matchAll(/<words[^>]*>([^<]*)<\/words>/g)]
    .map((w) => w[1].trim())
    .filter((w) => /\b(?:D\.?\s*S\.?|D\.?\s*C\.?|segno|coda|fine|To Coda|al Coda|Dal Segno|Da Capo)\b/i.test(w));
  if (barlines.length || words.length) {
    out.push({ measure: num, index: i, barlines, words });
  }
}
console.log(JSON.stringify(out, null, 2));