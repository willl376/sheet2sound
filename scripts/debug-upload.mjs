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

import { chromium } from 'playwright';
const sample = process.env.SAMPLE_PNG ||
  'C:\\Users\\Wilbur\\Pictures\\audiveris-patched-0.1-patch1\\audiveris-patched-0.1-patch1\\data\\examples\\carmen.png';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 400)}`));
page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message.slice(0, 400)));
page.on('requestfailed', (r) => logs.push(`[reqfail] ${r.url().slice(0,120)} ${r.failure()?.errorText}`));
page.on('response', (r) => { if (r.url().includes('/api/')) logs.push(`[response] ${r.status()} ${r.url().slice(0,120)}`); });

await page.goto(process.env.APP_URL || 'http://localhost:5173/', { waitUntil: 'networkidle' });
// wait for demo
await page.waitForFunction(() => (document.getElementById('log')?.textContent || '').includes('render() OK'));

await page.setInputFiles('#file', sample);
logs.push('--- clicked/uploaded file, waiting 60s ---');
await page.waitForTimeout(60000);

const state = await page.evaluate(() => ({
  log: document.getElementById('log')?.textContent,
  scoreHtmlLen: document.getElementById('score')?.innerHTML.length,
  hasScore: !!window.__score,
  btnDisabled: document.getElementById('btnTranscribe')?.disabled,
}));
console.log(JSON.stringify({ state, logs }, null, 2));
await browser.close();