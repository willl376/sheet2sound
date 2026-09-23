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

// scripts/render-audio.mjs — bounce the app's ACTUAL playback to a WAV file you can listen to.
//
// It drives the real page (/?demo=<score>), then renders inside the page with Tone.Offline
// using the SAME Tone.Sampler (MusyngKite acoustic_grand_piano SoundFont) and the EXACT
// scheduling formula from src/main.js play() (msAt(startBeats)/1000 placement, written-beats
// duration scaled by the tempo in force at each note, release 1.0, velocity passthrough).
// Sample names/files come from src/player.js noteNameMap — the app's own mapping — so the
// rendered audio is the same instrument and pitch set that the browser plays.
//
// "Sounds correct" verification (all must pass before exit 0):
//   1. WAV header is a valid 16-bit PCM stereo 44.1 kHz file
//   2. duration matches the timeline duration (185.229 s for Avalon) within 0.25 s
//   3. every pitched event was scheduled (1187 for Avalon) with ZERO dropped notes
//   4. no missing sample buffers (any triggerAttackRelease failure is counted)
//   5. audio is non-silent overall (peak > 5%) and does NOT clip (peak < 99.9%)
//   6. music spans the whole piece: every one of 8 time segments has audible RMS
//   7. the restored chorus-vocal window (written measures 28..40) has audible energy,
//      proving the "A-va-lon" melody restored by the merge fix is IN the sound
//
// Usage:
//   node scripts/render-audio.mjs [demo.musicxml] [out.wav]
// Defaults: avalon.musicxml -> artifacts/avalon-sheet2sound.wav
//
// Requires: `npm run dev` on :5173 (or set APP_URL) and network access to the SoundFont CDN.
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { noteNameMap } from '../src/player.js';

const SOUNDFONT = 'https://gleitz.github.io/midi-js-soundfonts/MusyngKite/acoustic_grand_piano-mp3/';

const demo = process.argv[2] || 'avalon.musicxml';
const out = process.argv[3] || `artifacts/${demo.replace(/\.musicxml$/i, '')}-sheet2sound.wav`;
const url = process.env.APP_URL
  ? `${process.env.APP_URL.replace(/\/$/, '')}/?demo=${demo}`
  : `http://localhost:5173/?demo=${demo}`;

const failures = [];
const check = (name, cond, detail = '') => {
  if (!cond) failures.push(name + (detail ? ` — ${detail}` : ''));
};

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

// Phase 1 — read the timeline facts out of the page.
const facts = await page.evaluate(() => {
  const p = window.__player;
  const tl = p?.timeline;
  if (!tl?.events?.length) return { ok: false, error: 'no timeline' };
  const pitched = tl.events.filter((e) => e.midi != null && !e.rest);
  const midis = [...new Set(pitched.map((e) => e.midi))].sort((a, b) => a - b);
  // Written measures 28..40 = the chorus vocal the merge fix restored.
  const chorus = pitched.filter((e) => {
    const m = Number(e.measure);
    return Number.isFinite(m) && m >= 28 && m <= 40;
  });
  const chorusStart = chorus.length
    ? Math.min(...chorus.map((e) => tl.msAt(e.startBeats))) / 1000
    : null;
  const chorusEnd = chorus.length
    ? Math.max(...chorus.map((e) => tl.msAt(e.startBeats) + e.durBeats * (60 / tl.bpmAt(e.startBeats)) * 0.95)) / 1000
    : null;
  return {
    ok: true,
    midis,
    pitchedCount: pitched.length,
    totalBeats: tl.totalBeats,
    durationMs: Math.round(tl.durationMs),
    chorusMeasureEvents: chorus.length,
    chorusStartSec: chorusStart,
    chorusEndSec: chorusEnd,
  };
});
if (!facts.ok) {
  console.log(JSON.stringify({ ok: false, error: facts.error, consoleErrors }, null, 2));
  await browser.close();
  process.exit(1);
}

// Build the sampler URL map with the APP'S OWN noteNameMap (single source of truth).
const urlEntries = noteNameMap(facts.midis.map((midi) => ({ midi })));
const urls = Object.fromEntries(urlEntries.map((n) => [n.name, n.file]));

// Phase 2 — decode samples in the page, render offline to a stereo 44.1k buffer, WAV-encode.
const meta = await page.evaluate(async ({ urls, baseUrl, durationMs, chorusStartSec, chorusEndSec }) => {
  const Tone = window.__Tone;
  const p = window.__player;
  const timeline = p.timeline;
  const events = timeline.events;
  const pitched = events.filter((e) => e.midi != null && !e.rest);
  const durationSec = durationMs / 1000 + 2.0; // 2s tail so releases ring out

  // Pre-decode every sample the app uses (same files, same CDN). Failures are recorded,
  // not swallowed, so a missing sample can never silently become silence.
  const decoded = {};
  const decodeFailureList = [];
  await Promise.all(Object.entries(urls).map(async ([name, file]) => {
    try {
      const buf = await Tone.ToneAudioBuffer.fromUrl(baseUrl + file);
      decoded[name] = buf.get ? buf.get() : buf;
    } catch (err) {
      decodeFailureList.push(`${file}: ${err.message}`);
    }
  }));
  if (Object.keys(decoded).length === 0) return { ok: false, error: 'all samples failed: ' + decodeFailureList.slice(0, 3).join(' | ') };

  let scheduled = 0;
  let dropped = 0;
  const rendered = await Tone.Offline(async () => {
    // Same sampler config as src/main.js ensureSampler(); buffers are pre-decoded so
    // no onload dance is needed inside the offline context.
    const sampler = new Tone.Sampler({ urls: decoded, release: 1.0 }).toDestination();
    for (const e of events) {
      if (e.midi == null || e.rest) continue;
      const note = Tone.Frequency(e.midi, 'midi').toNote();
      const dur = Math.max(e.durBeats * (60 / timeline.bpmAt(e.startBeats)) * 0.95, 0.05);
      try {
        sampler.triggerAttackRelease(note, dur, timeline.msAt(e.startBeats) / 1000, undefined, e.velocity);
        scheduled++;
      } catch { dropped++; }
    }
  }, durationSec, 2, 44100);

  // Extract channels + overall peak.
  const channels = [];
  let peak = 0;
  for (let c = 0; c < rendered.numberOfChannels; c++) {
    const data = rendered.getChannelData(c);
    channels.push(data);
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  }
  const sampleRate = rendered.sampleRate;
  const numSamples = channels[0].length;

  // Segment RMS (8 segments) to prove music spans the whole piece.
  const segCount = 8;
  const segLen = Math.floor(numSamples / segCount);
  const segRms = [];
  for (let s = 0; s < segCount; s++) {
    let sum = 0;
    const lo = s * segLen;
    const hi = s === segCount - 1 ? numSamples : (s + 1) * segLen;
    for (let i = lo; i < hi; i++) sum += channels[0][i] * channels[0][i] + channels[1][i] * channels[1][i];
    segRms.push(Math.sqrt(sum / (2 * (hi - lo))));
  }

  // Peak inside the restored chorus-vocal window (written measures 28..40, seconds from facts).
  let chorusPeak = null;
  if (chorusStartSec != null && chorusEndSec != null) {
    const lo = Math.max(0, Math.floor(chorusStartSec * sampleRate));
    const hi = Math.min(numSamples, Math.ceil(chorusEndSec * sampleRate));
    for (let i = lo; i < hi; i++) {
      const v = Math.max(Math.abs(channels[0][i]), Math.abs(channels[1][i]));
      if (chorusPeak == null || v > chorusPeak) chorusPeak = v;
    }
  }

  // Encode 16-bit PCM WAV.
  const numChannels = channels.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  str(36, 'data');
  view.setUint32(40, dataSize, true);
  let off = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let c = 0; c < numChannels; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }

  // Store the WAV as a latin1 binary string (byte-char round-trip is exact; base64
  // per-chunk padding would break Node's single-pass decode).
  window.__wavLatin1 = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000; // 32 KiB
  for (let i = 0; i < bytes.length; i += chunk) {
    window.__wavLatin1 += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return {
    ok: true,
    scheduled,
    dropped,
    decodeFailures: decodeFailureList.length,
    decodeFailureList: decodeFailureList.slice(0, 5),
    segRms,
    chorusPeak,
    latin1Length: window.__wavLatin1.length,
    samples: numSamples,
    sampleRate,
    channels: numChannels,
    peak,
    sizeBytes: bytes.length,
  };
}, { urls, baseUrl: SOUNDFONT, durationMs: facts.durationMs, chorusStartSec: facts.chorusStartSec, chorusEndSec: facts.chorusEndSec });

if (!meta.ok) {
  console.log(JSON.stringify({ ok: false, error: meta.error, consoleErrors }, null, 2));
  await browser.close();
  process.exit(1);
}

// Pull the latin1-encoded WAV out of the page in slices and write it to disk.
const parts = [];
const SLICE = 1_000_000;
for (let off = 0; off < meta.latin1Length; off += SLICE) {
  const len = Math.min(SLICE, meta.latin1Length - off);
  parts.push(await page.evaluate(([o, l]) => window.__wavLatin1.slice(o, o + l), [off, len]));
}
if (!existsSync('artifacts')) mkdirSync('artifacts');
writeFileSync(out, Buffer.from(parts.join(''), 'latin1'));
await browser.close();

// ----- verify the written WAV on disk -----
const raw = readFileSync(out);
const ascii = (start, len) => raw.toString('latin1', start, start + len);
const isRiff = ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE' && ascii(12, 4) === 'fmt ';
const fmt = raw.readUInt16LE(20);
const wChannels = raw.readUInt16LE(22);
const wRate = raw.readUInt32LE(24);
const wBlockAlign = raw.readUInt16LE(32);
const wBits = raw.readUInt16LE(34);
const dataOff = 44;
const wSamples = (raw.length - dataOff) / wBlockAlign;
let wPeak = 0;
for (let i = dataOff; i < raw.length; i += 2) {
  const v = raw.readInt16LE(i);
  wPeak = Math.max(wPeak, Math.abs(v) / 32768);
}
const wSeconds = wSamples / wRate;

check('WAV header RIFF/WAVE/fmt', isRiff);
check('PCM 16-bit', fmt === 1 && wBits === 16, `fmt=${fmt} bits=${wBits}`);
check('stereo 44100 Hz', wChannels === 2 && wRate === 44100, `ch=${wChannels} rate=${wRate}`);
check(`every pitched event scheduled (${facts.pitchedCount})`, meta.scheduled === facts.pitchedCount,
  `${meta.scheduled} scheduled, ${meta.dropped} dropped`);
check('no sample decode failures', meta.decodeFailures === 0, (meta.decodeFailureList || []).slice(0, 5).join(' | '));
const expectedSec = facts.durationMs / 1000 + 2.0; // 2s tail added for ring-out
check(`duration ${expectedSec.toFixed(2)}s (±0.25s)`, Math.abs(wSeconds - expectedSec) < 0.25,
  `wav=${wSeconds.toFixed(3)}s`);
check('non-silent (peak > 5%)', wPeak > 0.05, `peak=${wPeak.toFixed(3)}`);
check('no clipping (peak < 99.9%)', wPeak < 0.999, `peak=${wPeak.toFixed(3)}`);
check('music across all 8 segments', meta.segRms.every((r) => r > 0.001), `segRms=${meta.segRms.map((r) => r.toFixed(4)).join(',')}`);
const hasChorus = meta.chorusPeak != null && meta.chorusPeak > 0.02;
check(`chorus-vocal window m28-40 audible (peak > 2%)`, hasChorus,
  meta.chorusPeak == null ? 'no chorus events found' : `peak=${meta.chorusPeak.toFixed(3)} (${facts.chorusMeasureEvents} events)`);
check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

console.log(JSON.stringify({
  ok: failures.length === 0,
  failures,
  wav: out,
  bytes: raw.length,
  seconds: wSeconds,
  sampleRate: wRate,
  channels: wChannels,
  peak: wPeak,
  notes: meta.scheduled,
  beats: facts.totalBeats,
  durationMs: facts.durationMs,
  b64Length: meta.latin1Length,
  sizeBytes: meta.sizeBytes,
  chorusMeasureEvents: facts.chorusMeasureEvents,
  chorusWindowSec: [facts.chorusStartSec, facts.chorusEndSec],
  segRms: meta.segRms,
  consoleErrors,
}, null, 2));
process.exit(failures.length === 0 ? 0 : 1);