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

// scripts/verify-playback.mjs — Step 3 E2E: demo renders -> timeline parsed -> Play schedules -> Stop resets.
// Asserts the player state machine only (Tone.Sampler sample downloads are async/non-blocking,
// so this test does not depend on network access to the SoundFont CDN).
import { chromium } from 'playwright';

const url = process.env.APP_URL || 'http://localhost:5173/';
const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const consoleErrors = [];
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300)); });
page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message.slice(0, 300)));

await page.goto(url, { waitUntil: 'networkidle' });

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
  return {
    ok: true,
    events: tl.events.length,
    pitchCount,
    tempo: tl.tempo,
    timeSignature: tl.timeSignature,
    totalBeats: tl.totalBeats,
    durationMs: Math.round(tl.durationMs),
    state: p.state,
    occOrder,
    seqOrder,
    parity,
  };
});

// The strongest signal that scheduling actually ran without throwing is the status text
// mentioning "playing N notes". Then prove the playback cursor follows the audio clock:
// beats advance, and the first pitched note lights a halo (carmen starts with a rest).
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
  () => window.__cursor && window.__cursor.getTimeBeats() > 0.2,
  null,
  { timeout: 15000 }
);
await page.waitForFunction(() => window.__haloCount() > 0, null, { timeout: 20000 });
const duringPlay = await page.evaluate(() => ({
  state: window.__player.state,
  hasSampler: !!window.__player.sampler,
  playBtn: document.getElementById('btnPlay').textContent,
  status: document.getElementById('playStatus').textContent,
  log: document.getElementById('log').textContent,
  cursorBeats: window.__cursor.getTimeBeats(),
  cursorIndex: window.__cursor.getIndex(),
  halos: window.__haloCount(),
}));

// Mid-piece measure lock: once the cursor passes ~4000 ms of sequence time (≈ our measure 5
// at 120 QPM — 8 s of audio), the sequence measure under the cursor must still be near
// measure 5 (indices 3..8). The old naive beat->ms mapping raced to measure 22 here.
await page.waitForFunction(() => window.__cursor.getTimeMs() > 4000, null, { timeout: 25000 });
const mid = await page.evaluate(() => ({
  cursorMs: window.__cursor.getTimeMs(),
  seqMeasure: window.__score.getMeasureIndexAtMs(window.__cursor.getTimeMs()),
  halos: window.__haloCount(),
}));

// 3. Stop: cursor parks at the start, halos clear.
await page.click('#btnStop');
await page.waitForTimeout(500);
const afterStop = await page.evaluate(() => ({
  state: window.__player.state,
  playBtn: document.getElementById('btnPlay').textContent,
  status: document.getElementById('playStatus').textContent,
  cursorBeats: window.__cursor ? window.__cursor.getTimeBeats() : -1,
  halos: window.__haloCount(),
}));

// 4. LIVE tempo change (MuseScore-style): start at 60, then change to 140 while playing.
//    The transport bpm must rescale immediately (no Stop+Play), the status line must follow,
//    and the cursor must keep advancing under the new tempo.
await page.selectOption('#tempo', '60');
await page.click('#btnPlay');
await page.waitForFunction(
  (s) => (document.getElementById('playStatus')?.textContent || '').includes(s),
  'playing', { timeout: 30000 }
);
await page.waitForTimeout(400);
const te1 = await page.evaluate(() => ({
  status: document.getElementById('playStatus').textContent,
  bpm: window.__transportBpm(),
  beats: window.__cursor.getTimeBeats(),
}));
await page.selectOption('#tempo', '140');
await page.waitForFunction(
  (s) => (document.getElementById('playStatus')?.textContent || '').includes(s),
  '@ 140 QPM', { timeout: 10000 }
);
const te2 = await page.evaluate(() => ({
  status: document.getElementById('playStatus').textContent,
  bpm: window.__transportBpm(),
  beats: window.__cursor.getTimeBeats(),
}));
await page.waitForTimeout(500);
const te3 = await page.evaluate(() => ({
  beats: window.__cursor.getTimeBeats(),
  state: window.__player.state,
}));
await page.click('#btnStop');
await page.waitForTimeout(500);
const liveStop = await page.evaluate(() => ({
  state: window.__player.state,
  cursorBeats: window.__cursor ? window.__cursor.getTimeBeats() : -1,
}));

const failures = [];
if (!parsed.ok) failures.push('timeline parse failed: ' + parsed.error);
if (parsed.pitchCount !== 238) failures.push(`expected 238 pitch events, got ${parsed.pitchCount}`);
if (parsed.events !== 277) failures.push(`expected 277 events, got ${parsed.events}`);
if (parsed.parity !== true) failures.push('repeat order parity with vexml sequence failed: ' + JSON.stringify(parsed.parity));
if (duringPlay.state !== 'playing') failures.push(`during play state=${duringPlay.state}`);
if (!duringPlay.hasSampler) failures.push('sampler was not created on Play');
if (duringPlay.status.includes('audio unavailable') || duringPlay.log.includes('playback warning')) {
  failures.push('scheduling reported audio unavailable: ' + duringPlay.status);
} else if (!/playing \d+ notes/.test(duringPlay.status)) {
  failures.push('status did not confirm scheduling: ' + duringPlay.status);
}
if (afterStop.state !== 'idle') failures.push(`after stop state=${afterStop.state}`);
if (!(duringPlay.cursorBeats > 0)) failures.push(`cursor not advancing during play: beats=${duringPlay.cursorBeats}`);
if (!(duringPlay.halos > 0)) failures.push('no note halo lit during playback');
if (!(mid.seqMeasure >= 3 && mid.seqMeasure <= 8)) failures.push(`mid-piece measure lock off: seqMeasure=${mid.seqMeasure} at cursorMs=${mid.cursorMs}`);
if (afterStop.cursorBeats !== 0) failures.push(`cursor not parked at start on stop: ${afterStop.cursorBeats}`);
if (afterStop.halos !== 0) failures.push(`halos not cleared on stop: ${afterStop.halos}`);
if (!(te1.bpm === 60)) failures.push(`transport bpm at play start != 60: ${te1.bpm}`);
if (!(te2.bpm === 140)) failures.push(`live tempo change not applied: bpm=${te2.bpm}, status=${te2.status}`);
if (!te2.status.includes('@ 140 QPM')) failures.push('status did not follow tempo change: ' + te2.status);
if (!(te3.beats > te2.beats)) failures.push(`cursor not advancing after live tempo change: ${te2.beats} -> ${te3.beats}`);
if (liveStop.state !== 'idle') failures.push(`after live-tempo Stop state=${liveStop.state}`);
if (liveStop.cursorBeats !== 0) failures.push(`cursor not parked after live-tempo Stop: ${liveStop.cursorBeats}`);

console.log(JSON.stringify({ ok: failures.length === 0, parsed, duringPlay, mid, afterStop, live: { te1, te2, te3, liveStop }, consoleErrors, failures }, null, 2));
await browser.close();
process.exit(failures.length === 0 ? 0 : 1);