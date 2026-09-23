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

// scripts/omr-avalon.mjs — transcribe the Avalon pages (high-res PNGs) through real Audiveris,
// one page per job (a multi-page book export aborts if ANY sheet fails), saving each .mxl.
// Usage: node scripts/omr-avalon.mjs <pagePNG>...  (each becomes one .mxl)
import { writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { transcribe } from '../server/transcribe.mjs';

mkdirSync('artifacts', { recursive: true });

const inputs = process.argv.slice(2);
if (inputs.length === 0) {
  console.error('usage: node scripts/omr-avalon.mjs <page1.png> <page2.png> …');
  process.exit(2);
}

const sheets = [];
for (const png of inputs) {
  const pageNo = String(png.match(/page-0*(\d+)\.png/i)?.[1] || sheets.length + 1).padStart(2, '0');
  process.stdout.write(`--- Audiveris: ${png} …\n`);
  const t0 = Date.now();
  try {
    const r = await transcribe(png, { timeoutMs: 300000 });
    const out = `artifacts/avalon-page-${pageNo}.mxl`;
    await writeFile(out, r.mxl);
    sheets.push({ page: Number(pageNo), mxl: out, bytes: r.mxl.length, elapsedMs: Date.now() - t0 });
    process.stdout.write(`  OK  ${out} (${(r.mxl.length / 1024).toFixed(1)} KiB, ${Date.now() - t0} ms)\n`);
  } catch (err) {
    process.stdout.write(`  FAIL: ${String(err.message || err).split('\n').slice(-12).join('\n')}\n`);
  }
}

process.stdout.write('\n' + JSON.stringify({ ok: true, transcribed: sheets.map((s) => s.page), sheets }, null, 2));