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

// scripts/verify-avalon.mjs — E2E for the Audiveris->merge pipeline result:
// /?demo=avalon.musicxml must render, parse to a sane timeline (2/2 -> 4/4 across pages),
// and schedule playback without audio-desync: Play schedules, cursor advances, halos light,
// Stop resets. Counts are Avalon-specific (62 written measures, expanded by the m10↔m60
// repeat + voltas to 111 measure occurrences / 1430 events / ~370 beats @ 120,
// cut-time paced, ~3:05).
// 62 measures = 27 verse (2/2) + 35 chorus (4/4) across four OMR pages, Voice + Piano parts
// kept separate by scripts/merge-sheets.mjs.
import { chromium } from 'playwright';

const url = process.env.APP_URL
  ? `${process.env.APP_URL.replace(/\/$/, '')}/?demo=avalon.musicxml`
  : 'http://localhost:5173/?demo=avalon.musicxml';

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const consoleErrors = [];
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300)); });
page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message.slice(0, 300)));

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(
  () => (document.getElementById('log')?.textContent || '').includes('render() OK'),
  null,
  { timeout: 60000 }
);

const parsed = await page.evaluate(() => {
  const p = window.__player;
  const tl = p?.timeline;
  if (!tl) return { ok: false, error: 'no timeline' };
  return {
    ok: true,
    events: tl.events.length,
    pitchCount: tl.events.filter((e) => e.midi != null).length,
    tempo: tl.tempo,
    timeSignature: tl.timeSignature,
    totalBeats: tl.totalBeats,
    durationMs: Math.round(tl.durationMs),
    state: p.state,
    measuresInScore: document.querySelectorAll('#vf svg .vf-stavenote, #vf text').length,
  };
});

// Play: scheduling must report "playing N notes", the cursor must ride the audio clock,
// and at least one note halo must light (a pitched event in the first measures).
await page.click('#btnPlay');
await page.waitForFunction(
  () => {
    const status = document.getElementById('playStatus')?.textContent || '';
    return status.includes('playing') || status.includes('audio unavailable');
  },
  null,
  { timeout: 30000 }
);
await page.waitForFunction(() => window.__cursor && window.__cursor.getTimeBeats() > 0.2, null, { timeout: 15000 });
await page.waitForFunction(() => window.__haloCount() > 0, null, { timeout: 20000 });
const duringPlay = await page.evaluate(() => ({
  state: window.__player.state,
  hasSampler: !!window.__player.sampler,
  status: document.getElementById('playStatus').textContent,
  cursorBeats: window.__cursor.getTimeBeats(),
  halos: window.__haloCount(),
}));

// Stop must park the cursor and clear halos.
await page.click('#btnStop');
await page.waitForTimeout(500);
const afterStop = await page.evaluate(() => ({
  state: window.__player.state,
  cursorBeats: window.__cursor ? window.__cursor.getTimeBeats() : -1,
  halos: window.__haloCount(),
}));

const failures = [];
if (!parsed.ok) failures.push('timeline parse failed: ' + parsed.error);
if (parsed.events !== 1430) failures.push(`expected 1430 events, got ${parsed.events}`);
if (parsed.pitchCount !== 1187) failures.push(`expected 1187 pitch events, got ${parsed.pitchCount}`);
if (parsed.timeSignature?.beats !== 2 || parsed.timeSignature?.beatType !== 2) {
  failures.push(`verse time signature should be 2/2, got ${JSON.stringify(parsed.timeSignature)}`);
}
// Cut-time pacing: 120 QPM is read in the signature's beat unit (MuseScore convention), so the
// expanded-through piece is 111 occurrences = 27 x 2/2 (1 s/bar) + 35 x 4/4 (2 s/bar), with the
// m10↔m60 repeat + voltas replayed => ~370 beats / ~3:05. The old broken merge ran 568 beats (4:44)
// linearly; the linear timeline alone was ~203 beats (~1:41).
if (!(Math.abs(parsed.totalBeats - 370.46) < 3)) failures.push(`totalBeats ~370.46, got ${parsed.totalBeats}`);
if (!(Math.abs(parsed.durationMs - 185229) < 3500)) failures.push(`durationMs ~185229, got ${parsed.durationMs}`);
if (duringPlay.state !== 'playing') failures.push(`during play state=${duringPlay.state}`);
if (!duringPlay.hasSampler) failures.push('sampler was not created on Play');
if (duringPlay.status.includes('audio unavailable')) {
  failures.push('scheduling reported audio unavailable: ' + duringPlay.status);
} else if (!/playing \d+ notes/.test(duringPlay.status)) {
  failures.push('status did not confirm scheduling: ' + duringPlay.status);
}
if (!(duringPlay.cursorBeats > 0)) failures.push(`cursor not advancing: beats=${duringPlay.cursorBeats}`);
if (!(duringPlay.halos > 0)) failures.push('no note halo lit during playback');
if (afterStop.state !== 'idle') failures.push(`after stop state=${afterStop.state}`);
if (afterStop.cursorBeats !== 0) failures.push(`cursor not parked on stop: ${afterStop.cursorBeats}`);
if (afterStop.halos !== 0) failures.push(`halos not cleared on stop: ${afterStop.halos}`);
if (consoleErrors.some((e) => !/net::ERR|Failed to load resource|tone|blob:/.test(e))) {
  failures.push('console errors: ' + consoleErrors.join(' | ').slice(0, 400));
}

console.log(JSON.stringify({
  ok: failures.length === 0,
  parsed: { events: parsed.events, pitchCount: parsed.pitchCount, tempo: parsed.tempo,
    timeSignature: parsed.timeSignature, totalBeats: parsed.totalBeats, durationMs: parsed.durationMs },
  duringPlay,
  afterStop,
  consoleErrors,
  failures,
}, null, 2));
await browser.close();
process.exit(failures.length === 0 ? 0 : 1);