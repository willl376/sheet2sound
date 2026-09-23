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

// scripts/verify-upload.mjs — Step 2 E2E: browser upload -> Audiveris -> render.
// Uploads carmen.png through the real UI, waits for OMR + render, and cross-checks
// the rendered measure count against the produced MusicXML.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const url = process.env.APP_URL || 'http://localhost:5173/';
const sample = process.env.SAMPLE_PNG ||
  'C:\\Users\\Wilbur\\Pictures\\audiveris-patched-0.1-patch1\\audiveris-patched-0.1-patch1\\data\\examples\\carmen.png';
const outDir = 'artifacts';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const consoleErrors = [];
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300)); });
page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message.slice(0, 300)));

await page.goto(url, { waitUntil: 'networkidle' });

// Demo score must have rendered first.
await page.waitForFunction(
  () => (document.getElementById('log')?.textContent || '').includes('render() OK'),
  null,
  { timeout: 60000 }
);

// Upload through the real UI (the input's change event triggers onTranscribe).
await page.setInputFiles('#file', sample);

// Wait for the OMR round-trip + re-render. renderScore() clears the log, so the
// final log shows only the upload label ("... → MusicXML (...)").
await page.waitForFunction(
  () => {
    const log = document.getElementById('log')?.textContent || '';
    return log.includes('render() OK') && log.includes('MusicXML (');
  },
  null,
  { timeout: 240000 }
);

const log = await page.textContent('#log');
if (log.includes('FAILED')) {
  console.error('UPLOAD FLOW FAILED:\n' + log);
  await browser.close();
  process.exit(1);
}

const stats = await page.evaluate(async () => {
  const score = window.__score;
  if (!score) return { error: 'no window.__score after upload' };

  const findArray = (obj, keyName, depth = 0, max = 5) => {
    if (!obj || typeof obj !== 'object' || depth > max) return null;
    if (Array.isArray(obj[keyName])) return obj[keyName];
    for (const k of Object.keys(obj)) {
      if (k === 'events' || k === 'dispatcher') continue;
      const r = findArray(obj[k], keyName, depth + 1, max);
      if (r) return r;
    }
    return null;
  };

  const systems = findArray(score, 'systemList');
  let renderedMeasureCount = 0;
  for (const sys of systems ?? []) {
    for (const box of sys?.boxList ?? []) {
      if (box?.type === 'measure') renderedMeasureCount++;
    }
  }

  const canvas = document.querySelector('#score canvas');
  let nonTransparentSamples = 0;
  if (canvas) {
    const ctx = canvas.getContext('2d');
    if (ctx && canvas.width > 0 && canvas.height > 0) {
      const data = ctx.getImageData(0, 0, Math.min(canvas.width, 256), Math.min(canvas.height, 256)).data;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 0) { nonTransparentSamples++; if (nonTransparentSamples > 500) break; }
      }
    }
  }

  return {
    renderedMeasureCount,
    canvasWidth: canvas?.width || 0,
    canvasHeight: canvas?.height || 0,
    nonTransparentSamples,
    blank: nonTransparentSamples === 0,
  };
});

await page.screenshot({ path: outDir + '/carmen-upload-render.png', fullPage: true });

const result = { ok: true, log: log.trim(), ...stats, consoleErrors };
console.log(JSON.stringify(result, null, 2));
await browser.close();

if (stats.error || stats.blank || consoleErrors.length > 0) process.exit(1);