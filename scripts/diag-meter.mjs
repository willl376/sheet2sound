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

// scripts/diag-meter.mjs — per-measure time signature audit of a MusicXML file (both parts).
import { readFileSync } from 'node:fs';

const path = process.argv[2] || 'scores/avalon.musicxml';
const xml = readFileSync(path, 'utf8');

const parts = [];
for (const m of xml.matchAll(/<part id="([^"]+)"[^>]*>([\s\S]*?)<\/part>/g)) {
  const measures = [];
  for (const mm of m[2].matchAll(/<measure\b[^>]*\bnumber="([^"]*)"[^>]*>([\s\S]*?)<\/measure>/g)) {
    const t = mm[2].match(/<time\b[^>]*>\s*<beats>([^<]*)<\/beats>\s*<beat-type>([^<]*)<\/beat-type>/);
    measures.push({
      n: mm[1],
      sig: t ? `${t[1]}/${t[2]}` : '-',
    });
  }
  parts.push({ id: m[1], measures });
}

const P0 = parts[0]?.measures ?? [];
const runs = [];
for (const m of P0) {
  const last = runs[runs.length - 1];
  if (last && last.sig === m.sig) last.to = m.n;
  else runs.push({ sig: m.sig, from: m.n, to: m.n });
}

console.log(JSON.stringify({
  file: path.split(/[\\/]/).pop(),
  parts: parts.map((p) => ({ id: p.id, measureCount: p.measures.length })),
  meterRuns: runs,
}, null, 2));