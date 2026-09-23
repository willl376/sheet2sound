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

// scripts/verify-omr-demo.mjs — load /?demo=carmen-omr.musicxml headless, confirm it renders
// as a real score (the ?demo= hook regression check + evidence before opening in the user's browser).
import { chromium } from 'playwright';

const url = process.env.APP_URL || 'http://localhost:5173/?demo=carmen-omr.musicxml';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message.slice(0, 300)));

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(
  () => (document.getElementById('log')?.textContent || '').includes('render() OK'),
  null, { timeout: 60000 }
);
await page.waitForTimeout(600); // let the canvas paint + editing controller attach
const res = await page.evaluate(() => {
  const canvas = document.querySelector('#score canvas');
  const ctx = canvas?.getContext('2d');
  let nonTransparent = 0;
  if (ctx) {
    const { width, height } = canvas;
    const img = ctx.getImageData(0, 0, width, height).data;
    for (let i = 3; i < img.length; i += 4 * 37) if (img[i] !== 0) nonTransparent++; // sparse sample
  }
  const seq = window.__score?.getSequence?.();
  return {
    log: document.getElementById('log').textContent.trim(), // may contain several lines
    canvas: canvas ? { w: canvas.width, h: canvas.height } : null,
    nonTransparent,
    measures: seq ? seq.getMeasureCount() : -1,
    hasEditor: !!window.__editor,
    cursorReady: !!window.__cursor,
  };
});
console.log(JSON.stringify({ ok: res.canvas && res.nonTransparent > 50 && res.measures === 23 && consoleErrors.length === 0, ...res, consoleErrors }, null, 2));
await browser.close();