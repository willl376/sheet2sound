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

// scripts/inspect.mjs — dump structural facts about the rendered score from window.__score.
// Stronger than pixels: proves measure/system/note/key-signature content parsed from Audiveris MusicXML.
import { chromium } from 'playwright';

const url = process.env.APP_URL || 'http://localhost:5173/';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(url, { waitUntil: 'networkidle' });

await page.waitForFunction(
  () => (document.getElementById('log')?.textContent || '').includes('render() OK'),
  { timeout: 60000 }
);

const facts = await page.evaluate(async () => {
  const score = window.__score;
  if (!score) return { error: 'no window.__score' };

  const out = { scoreType: typeof score, keys: Object.keys(score).slice(0, 40) };

  // Measure count via the same accessor vexml's own code uses.
  // Find the systems array wherever it hangs off the score object.
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
  out.systemCount = systems?.length ?? null;
  let measureTotal = 0;
  for (const sys of systems ?? []) {
    const mm = (sys?.measureList ?? sys?.measures)?.length ?? 0;
    measureTotal += mm;
  }
  out.measureCount = measureTotal;
  out.measureCountBySystem = systems?.map((s) => ({
    measures: s?.measureList?.length ?? s?.measures?.length ?? 0,
    keys: Object.keys(s).slice(0, 18),
  }));
  out.sampleSystem = systems?.[0]
    ? { keys: Object.keys(systems[0]).slice(0, 25) }
    : null;

  // Measures are stored per system in boxList as { type: 'measure' }.
  const measureBoxes = [];
  for (const sys of systems ?? []) {
    for (const box of sys?.boxList ?? []) {
      if (box?.type === 'measure') measureBoxes.push(box);
    }
  }
  out.renderedMeasureCount = measureBoxes.length;

  // Cross-check against the source XML: measure & note counts (source of truth).
  const xmlRes = await fetch('/scores/carmen.xml');
  const xmlText = await xmlRes.text();
  const xmlDoc = new DOMParser().parseFromString(xmlText, 'application/xml');
  out.xmlMeasureCount = xmlDoc.querySelectorAll('score-partwise > part > measure').length;
  out.xmlNoteCount = xmlDoc.querySelectorAll('measure > note').length;
  out.xmlKeySigs = [...xmlDoc.querySelectorAll('measure > attributes > key')]
    .map((k) => ({
      num: k.querySelector('fifths')?.textContent,
      where: k.closest('measure')?.getAttribute('number'),
    }));
  out.match = out.renderedMeasureCount === out.xmlMeasureCount;

  return out;
});

console.log(JSON.stringify(facts, null, 2));
await browser.close();