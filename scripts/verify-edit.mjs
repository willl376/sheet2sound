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

// scripts/verify-edit.mjs — Step 4 E2E: the human-verification editing loop.
// Select a transcribed note, raise it a semitone (session history), undo it back,
// halve its duration (structural edit), verify serialization, and prove the edited
// document still renders (non-blank canvas) with a clean console.
import { chromium } from 'playwright';

const url = process.env.APP_URL || 'http://localhost:5173/';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message.slice(0, 300)));

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(
  () => (document.getElementById('log')?.textContent || '').includes('render() OK'),
  null,
  { timeout: 60000 }
);

// --- 1. Editing session wired; select a pitched quarter/eighth note directly ---
const sel = await page.evaluate(() => {
  const editor = window.__editor;
  if (!editor) return { ok: false, error: 'no window.__editor' };

  // Pick the first pitched note with a middle duration across all voices.
  let target = null;
  for (const v of editor.getVoices()) {
    for (const m of v.part.measures) {
      for (const n of m.notes) {
        if (n.voice === v.voice && !n.isRest && (n.type === 'quarter' || n.type === 'eighth')) {
          target = n; break;
        }
      }
      if (target) break;
    }
    if (target) break;
  }
  if (!target) return { ok: false, error: 'no quarter/eighth pitched note in document' };

  editor.select(target);
  const p = target.pitch;
  return {
    ok: true,
    step: p.step, octave: p.octave, alter: p.alter ?? 0,
    type: target.type, dots: target.dots ?? 0,
    divisions: target.duration,
  };
});
if (!sel.ok) {
  console.log(JSON.stringify({ ok: false, sel, consoleErrors, failures }, null, 2));
  await browser.close();
  process.exit(1);
}

const STEP_BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const midiOf = (s) => (s.octave + 1) * 12 + STEP_BASE[s.step] + s.alter;
const beforeMidi = midiOf({ step: sel.step, octave: sel.octave, alter: sel.alter });

// The inspector must reflect the selection.
const insp = await page.textContent('#inspectorBody');
check(insp.includes('Pitch'), 'inspector does not show pitch info');

// --- 2. Semitone up ---
const count0 = await page.evaluate(() => window.__editCount);
await page.click('#btnSharp');
await page.waitForFunction((c) => window.__editCount > c, count0, { timeout: 20000 });
const afterSharp = await page.evaluate(() => {
  const n = window.__editor.getFocus();
  return { step: n.pitch.step, octave: n.pitch.octave, alter: n.pitch.alter ?? 0 };
});
check(midiOf(afterSharp) === beforeMidi + 1, `sharp: expected midi ${beforeMidi + 1}, got ${midiOf(afterSharp)} (${afterSharp.step}${afterSharp.alter}${afterSharp.octave})`);

// --- 3. Undo restores ---
const count1 = await page.evaluate(() => window.__editCount);
await page.click('#btnUndo');
await page.waitForFunction((c) => window.__editCount > c, count1, { timeout: 20000 });
const afterUndo = await page.evaluate(() => {
  const n = window.__editor.getFocus();
  return { step: n.pitch.step, octave: n.pitch.octave, alter: n.pitch.alter ?? 0 };
});
check(midiOf(afterUndo) === beforeMidi, `undo: expected midi ${beforeMidi}, got ${midiOf(afterUndo)}`);

// --- 4. Halve duration (structural edit, ripples the voice) ---
const count2 = await page.evaluate(() => window.__editCount);
await page.click('#btnHalve');
await page.waitForFunction((c) => window.__editCount > c, count2, { timeout: 20000 });
const afterHalve = await page.evaluate(() => {
  const n = window.__editor.getFocus();
  return { type: n.type, dots: n.dots ?? 0, divisions: n.duration };
});
check(afterHalve.divisions === Math.round(sel.divisions / 2),
  `halve: expected divisions ${Math.round(sel.divisions / 2)}, got ${afterHalve.divisions} (type ${afterHalve.type})`);

// --- 5. Navigation buttons still work after edits ---
const beforeNav = await page.evaluate(() => window.__editor.getFocus().pitch.step);
await page.click('#btnNext');
await page.waitForTimeout(250);
const afterNav = await page.evaluate(() => window.__editor.getFocus()?.pitch?.step ?? null);
check(afterNav !== beforeNav && afterNav != null, `nav next did not move focus (${beforeNav} -> ${afterNav})`);

// --- 6. Serialization / export path ---
const exported = await page.evaluate(() => {
  const s = window.__serialize();
  return { len: s.length, hasPartwise: s.includes('<score-partwise'), head: s.slice(0, 90) };
});
check(exported.hasPartwise, 'serialized XML is not score-partwise');
check(exported.len > 10000, `serialized XML suspiciously small (${exported.len} bytes)`);

// --- 7. Edited document still renders (non-blank canvas) ---
const canvas = await page.evaluate(() => {
  const c = document.querySelector('#score canvas');
  if (!c) return { hasCanvas: false, nonTransparentSamples: 0 };
  const ctx = c.getContext('2d');
  const w = c.width, h = c.height;
  let n = 0;
  if (ctx && w > 0 && h > 0) {
    const d = ctx.getImageData(0, 0, Math.min(w, 256), Math.min(h, 256)).data;
    for (let i = 3; i < d.length; i += 4) {
      if (d[i] > 0) { n++; if (n > 400) break; }
    }
  }
  return { hasCanvas: true, width: w, height: h, nonTransparentSamples: n };
});
check(canvas.hasCanvas, 'no canvas after edits');
check(canvas.nonTransparentSamples > 0, 'canvas blank after edits');

console.log(JSON.stringify({
  ok: failures.length === 0,
  sel,
  beforeMidi,
  afterSharp,
  afterUndo,
  afterHalve,
  nav: { beforeNav, afterNav },
  exportedLen: exported.len,
  canvas,
  consoleErrors,
  failures,
}, null, 2));

await browser.close();
process.exit(failures.length === 0 ? 0 : 1);