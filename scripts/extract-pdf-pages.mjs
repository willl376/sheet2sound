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

// scripts/extract-pdf-pages.mjs — copy selected pages out of a PDF into a new PDF.
// Usage: node scripts/extract-pdf-pages.mjs <input.pdf> <output.pdf> <pages>
//   pages = comma/range list, 1-based, e.g. "3,4,5,6" or "3-6" or "3,5-6"
import { readFileSync, writeFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';

const [input, output, pagesArg] = process.argv.slice(2);
if (!input || !output || !pagesArg) {
  console.error('usage: node scripts/extract-pdf-pages.mjs <input.pdf> <output.pdf> <pages: 3-6|1,3,5-6>');
  process.exit(2);
}

// "3-6" or "1,3,5-6" -> flat 1-based list
const wanted = [];
for (const part of pagesArg.split(',')) {
  const m = part.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) throw new Error('bad page spec: ' + part);
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  for (let p = a; p <= b; p++) wanted.push(p);
}

const src = await PDFDocument.load(readFileSync(input), { ignoreEncryption: true });
const total = src.getPageCount();
for (const p of wanted) {
  if (p < 1 || p > total) throw new Error(`page ${p} out of range (PDF has ${total} pages)`);
}

const out = await PDFDocument.create();
const copied = await out.copyPages(src, wanted.map((p) => p - 1));
copied.forEach((pg) => out.addPage(pg));
const bytes = await out.save();
writeFileSync(output, bytes);

console.log(JSON.stringify({
  ok: true,
  input,
  totalPages: total,
  extracted: wanted,
  output,
  bytes: bytes.length,
  sizeKb: Math.round(bytes.length / 1024),
}, null, 2));