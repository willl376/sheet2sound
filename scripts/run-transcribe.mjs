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

// scripts/run-transcribe.mjs — one-shot Audiveris transcription to a file.
// Usage: node scripts/run-transcribe.mjs <input.png|pdf> [output.mxl]
import { writeFile } from 'node:fs/promises';
import { transcribe } from '../server/transcribe.mjs';

const input = process.argv[2];
const out = process.argv[3] || 'artifacts/cli-run.mxl';
if (!input) { console.error('usage: node scripts/run-transcribe.mjs <input> [output.mxl]'); process.exit(2); }

const t0 = Date.now();
const r = await transcribe(input, { timeoutMs: 300000 });
await writeFile(out, r.mxl);
console.log(JSON.stringify({
  ok: true,
  bytes: r.mxl.length,
  exitCode: r.exitCode,
  elapsedMs: Date.now() - t0,
  out,
  logTail: r.log.split('\n').slice(-6),
}, null, 2));