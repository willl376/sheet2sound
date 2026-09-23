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

// scripts/omr-carmen.mjs — run the REAL OMR path (POST carmen.png ↔ Audiveris) and save the
// transcription as scores/carmen-omr.musicxml so the UI can load it via /?demo=carmen-omr.musicxml.
import { readFileSync, writeFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';

const url = process.env.APP_URL || 'http://localhost:5173/api/transcribe?name=carmen.png';
const pngPath = process.env.CARMEN_PNG
  || 'C:/Users/Wilbur/Pictures/audiveris-patched-0.1-patch1/audiveris-patched-0.1-patch1/data/examples/carmen.png';

const body = readFileSync(pngPath);
process.stdout.write(`POST ${url} (${body.length} bytes) …\n`);
const res = await fetch(url, { method: 'POST', body });
if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
const elapsed = res.headers.get('X-Elapsed-Ms');
process.stdout.write(`Audiveris OK in ${elapsed} ms (exit ${res.headers.get('X-Audiveris-Exit')})\n`);

const bytes = new Uint8Array(await res.arrayBuffer());
const entries = unzipSync(bytes);
const xmlEntry = Object.keys(entries).find((k) => k.endsWith('.xml'));
if (!xmlEntry) throw new Error('No .xml inside the returned .mxl: ' + Object.keys(entries).join(', '));
const xml = strFromU8(entries[xmlEntry]);
const measures = (xml.match(/<measure\s/g) || []).length;

const out = 'scores/carmen-omr.musicxml';
writeFileSync(out, xml);
process.stdout.write(`wrote ${out} (${(xml.length / 1024).toFixed(1)} KiB, ${measures} measures)\n`);