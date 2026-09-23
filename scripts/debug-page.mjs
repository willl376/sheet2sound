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
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 500)}`));
page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message.slice(0, 500)));
page.on('requestfailed', (r) => logs.push(`[reqfail] ${r.url()} ${r.failure()?.errorText}`));
await page.goto(process.env.APP_URL || 'http://localhost:5173/', { waitUntil: 'networkidle' }).catch((e) => logs.push('[goto] ' + e.message));
await page.waitForTimeout(4000);
const state = await page.evaluate(() => ({
  log: document.getElementById('log')?.textContent,
  scoreHtml: document.getElementById('score')?.innerHTML.slice(0, 300),
  hasScore: !!window.__score,
}));
console.log(JSON.stringify({ state, logs }, null, 2));
await browser.close();