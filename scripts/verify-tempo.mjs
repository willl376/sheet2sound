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

// scripts/verify-tempo.mjs — E2E for the vexml-tempo-segment port. Loads scores/tempo-seq.xml
// (per-measure <metronome>/<sound tempo> marks + a repeat that back-jumps over them), then:
//   1. asserts our timeline's segments/durationMs/msAt against the XOR truth table (20666.67 ms
//      vs 18000 ms linear-120), and the dropdown default snapped to the written opening tempo;
//   2. asserts EXACT parity with vexml's own sequence durationMs (getDurationMs) — the two
//      tempo maps must fold to identical wall-clock time;
//   3. plays and proves the cursor tracks the WRITTEN tempo map: in the slowed 60-QPM section
//      the sequence measure under the cursor must be m2, not the m3/m4 a naive beat->ms mapping
//      would race to; stop parks the cursor.
import { chromium } from 'playwright';

const url = process.env.APP_URL || 'http://localhost:5173/';
const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const consoleErrors = [];
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300)); });
page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message.slice(0, 300)));

await page.goto(url + '?demo=tempo-seq.xml', { waitUntil: 'networkidle' });

// 1. Demo render + timeline parse.
await page.waitForFunction(
  () => (document.getElementById('log')?.textContent || '').includes('render() OK'),
  null,
  { timeout: 60000 }
);

const parsed = await page.evaluate(() => {
  const p = window.__player;
  const tl = p?.timeline;
  if (!tl) return { ok: false, error: 'no timeline' };
  const pitchCount = tl.events.filter((e) => e.midi != null).length;
  // RepeatList parity: our expanded occurrence order (clone-safe snapshot) vs vexml's own
  // MeasureSequenceIterator output (deduped consecutive step runs = per-occurrence order).
  let occOrder = null;
  let seqOrder = null;
  let parity = true;
  try {
    occOrder = (tl.occurrences ?? []).map((o) => o.index);
    const steps = window.__score.getSequence().getSteps();
    seqOrder = [];
    for (const s of steps) {
      if (seqOrder[seqOrder.length - 1] !== s.measureIndex) seqOrder.push(s.measureIndex);
    }
    if (occOrder.length !== seqOrder.length) {
      parity = false;
    } else {
      for (let i = 0; i < occOrder.length; i++) {
        if (occOrder[i] !== seqOrder[i]) { parity = false; break; }
      }
    }
  } catch (err) {
    parity = 'error: ' + err.message;
  }
  // vexml's own tempo map (getDurationMs) is the ground truth our segments must reproduce.
  let vexmlDurationMs = null;
  try { vexmlDurationMs = window.__score.getSequence().getDurationMs(); } catch { /* noop */ }
  return {
    ok: true,
    events: tl.events.length,
    pitchCount,
    tempo: tl.tempo,
    totalBeats: tl.totalBeats,
    durationMs: Math.round(tl.durationMs),
    tempoSegments: (tl.tempoSegments ?? []).map((s) =>
      [+s.startBeat.toFixed(2), +s.endBeat.toFixed(2), s.bpm]),
    msAt36: tl.msAt(36),
    msAt20: tl.msAt(20),
    dropdown: document.getElementById('tempo')?.value,
    vexmlDurationMs,
    occOrder,
    seqOrder,
    parity,
    state: p.state,
  };
});

// 2. Schedule at written tempo map and prove cursor lock inside the 60-QPM section.
await page.click('#btnPlay');
await page.waitForFunction(
  () => {
    const status = document.getElementById('playStatus')?.textContent || '';
    const log = document.getElementById('log')?.textContent || '';
    return status.includes('playing') || status.includes('audio unavailable') || log.includes('playback warning');
  },
  null,
  { timeout: 30000 }
);
await page.waitForFunction(
  () => window.__cursor && window.__cursor.getTimeMs() > 3000,
  null,
  { timeout: 30000 }
);
const duringPlay = await page.evaluate(() => ({
  state: window.__player.state,
  hasSampler: !!window.__player.sampler,
  status: document.getElementById('playStatus').textContent,
  log: document.getElementById('log').textContent,
  cursorMs: window.__cursor.getTimeMs(),
  cursorBeats: window.__cursor.getTimeBeats(),
  seqMeasure: window.__score.getMeasureIndexAtMs(window.__cursor.getTimeMs()),
  halos: window.__haloCount(),
}));
await page.click('#btnStop');
await page.waitForTimeout(500);
const afterStop = await page.evaluate(() => ({
  state: window.__player.state,
  cursorBeats: window.__cursor ? window.__cursor.getTimeBeats() : -1,
  halos: window.__haloCount(),
}));

const failures = [];
if (!parsed.ok) failures.push('timeline parse failed: ' + parsed.error);
if (parsed.events !== 9) failures.push(`expected 9 events, got ${parsed.events}`);
if (parsed.pitchCount !== 9) failures.push(`expected 9 pitch events, got ${parsed.pitchCount}`);
if (parsed.tempo !== 120) failures.push(`tempo (opening rate) should be 120, got ${parsed.tempo}`);
if (Math.abs(parsed.totalBeats - 36) > 0.05) failures.push(`totalBeats expected 36, got ${parsed.totalBeats}`);
// durationMs must equal vexml's folded durationMs (~20666.67), NOT the 18000 linear-120 would give.
if (Math.abs(parsed.durationMs - 20666.67) > 40) failures.push(`durationMs expected ~20666.67, got ${parsed.durationMs}`);
if (parsed.vexmlDurationMs == null || Math.abs(parsed.vexmlDurationMs - 20666.67) > 40) {
  failures.push(`vexml getDurationMs() parity: got ${parsed.vexmlDurationMs}`);
}
const wantSegs = [[0, 4, 120], [4, 8, 60], [8, 12, 120], [12, 16, 120], [16, 20, 60],
  [20, 24, 120], [24, 28, 120], [28, 32, 180], [32, 36, 180]];
if (JSON.stringify(parsed.tempoSegments) !== JSON.stringify(wantSegs)) {
  failures.push('tempoSegments mismatch: ' + JSON.stringify(parsed.tempoSegments));
}
if (Math.abs(parsed.msAt36 - 20666.67) > 40) failures.push(`msAt(36) expected ~20666.67, got ${parsed.msAt36}`);
if (Math.abs(parsed.msAt20 - 14000) > 2) failures.push(`msAt(20) expected 14000, got ${parsed.msAt20}`);
if (parsed.dropdown !== '120') failures.push(`dropdown default expected 120, got ${parsed.dropdown}`);
if (parsed.parity !== true) failures.push('occurrence order parity with vexml failed: ' + JSON.stringify(parsed.parity));
// The 60-QPM section: at ~3-5 s of sequence time the cursor must be on measure index 1 (m2),
// NOT racing to m3/m4 as a naive beat*500ms mapping would (linear 120 would put 4 s at 8 beats = m3).
if (duringPlay.state !== 'playing') failures.push(`during play state=${duringPlay.state}`);
if (!duringPlay.hasSampler) failures.push('sampler was not created on Play');
if (duringPlay.status.includes('audio unavailable') || duringPlay.log.includes('playback warning')) {
  failures.push('scheduling reported audio unavailable: ' + duringPlay.status);
} else if (!/playing \d+ notes/.test(duringPlay.status)) {
  failures.push('status did not confirm scheduling: ' + duringPlay.status);
}
if (!(duringPlay.cursorMs > 3000)) failures.push(`cursorMs not advancing: ${duringPlay.cursorMs}`);
if (!(duringPlay.cursorMs < 6000)) {
  failures.push(`cursor check window missed (cursorMs=${duringPlay.cursorMs}); tempo fold may be off`);
} else if (duringPlay.seqMeasure !== 1) {
  failures.push(`cursor must be on m2 (index 1) inside the 60-QPM section, got index ${duringPlay.seqMeasure}`);
}
if (duringPlay.halos <= 0) failures.push('no note halo lit during playback');
if (afterStop.state !== 'idle') failures.push(`after stop state=${afterStop.state}`);
if (afterStop.cursorBeats !== 0) failures.push(`cursor not parked on stop: ${afterStop.cursorBeats}`);
if (afterStop.halos !== 0) failures.push(`halos not cleared on stop: ${afterStop.halos}`);

console.log(JSON.stringify({ ok: failures.length === 0, parsed, duringPlay, afterStop, consoleErrors, failures }, null, 2));
await browser.close();
process.exit(failures.length === 0 ? 0 : 1);