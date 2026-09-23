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

// scripts/verify.mjs — headless smoke test for sheet2sound Step 1.
// Loads the app, renders scores/carmen.xml via vexml/VexFlow, asserts the SVG
// score exists, and saves a full-page screenshot to artifacts/.
//
// Requires: playwright + chromium (npm i -D playwright; npx playwright install chromium)
// Usage:    node scripts/verify.mjs   (vite dev server must be running on :5173)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const url = process.env.APP_URL || 'http://localhost:5173/';
const outDir = 'artifacts';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 400));
});
page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message.slice(0, 400)));

await page.goto(url, { waitUntil: 'networkidle' });

// Render either succeeds (log line 'render() OK') or reports a failure.
await page.waitForFunction(
  () => {
    const log = document.getElementById('log')?.textContent || '';
    return log.includes('render() OK') || log.includes('FAILED');
  },
  { timeout: 60000 }
);

const log = await page.textContent('#log');

if (log.includes('FAILED')) {
  console.error('RENDER FAILED:\n' + log);
  await browser.close();
  process.exit(1);
}

const stats = await page.evaluate(() => {
  const root = document.getElementById('score');
  const canvas = root?.querySelector('.vexml-canvas canvas, canvas');

  // Sample the canvas pixels to prove something was actually drawn.
  let nonTransparentSamples = 0;
  if (canvas) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    if (ctx && w > 0 && h > 0) {
      const data = ctx.getImageData(0, 0, Math.min(w, 256), Math.min(h, 256)).data;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 0) {
          nonTransparentSamples++;
          if (nonTransparentSamples > 500) break;
        }
      }
    }
  }

  return {
    hasCanvas: !!canvas,
    canvasWidth: canvas?.width || 0,
    canvasHeight: canvas?.height || 0,
    nonTransparentSamples,
    blank: canvas ? nonTransparentSamples === 0 : true,
  };
});

await page.screenshot({ path: outDir + '/carmen-render.png', fullPage: true });

const result = { ok: true, log: log.trim(), ...stats, consoleErrors };
console.log(JSON.stringify(result, null, 2));

await browser.close();

if (!stats.hasCanvas || stats.blank || consoleErrors.length > 0) {
  process.exit(1);
}