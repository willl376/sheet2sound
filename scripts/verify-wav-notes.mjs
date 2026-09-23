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

// scripts/verify-wav-notes.mjs — the "does it SOUND right" proof: frequency-content check.
// For a sample of pitched timeline events across the whole piece, take the rendered WAV's
// FFT at each note onset and require the note's expected frequency to actually be present
// in the audio (a spectral peak at f ± 3% that is at least 15% of the strongest peak).
// This ties the printed notation -> OMR -> merged score -> playback -> audio chain:
// if the rendered audio did not contain a note, its frequency would be absent.
//
// Usage: node scripts/verify-wav-notes.mjs <rendered.wav> [score.musicxml] [sampleStride]
// Defaults: artifacts/avalon-sheet2sound.wav  scores/avalon.musicxml  stride 20 (~60 samples)
import { readFileSync } from 'node:fs';
import { DOMParser } from 'linkedom';
import { parseMusicXML } from '../src/player.js';

const wavPath = process.argv[2] || 'artifacts/avalon-sheet2sound.wav';
const xmlPath = process.argv[3] || 'scores/avalon.musicxml';
const stride = Number(process.argv[4] || 20);

const raw = readFileSync(wavPath);
const ascii = (start, len) => raw.toString('latin1', start, start + len);
if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') throw new Error('not a WAV: ' + wavPath);
const channels = raw.readUInt16LE(22);
const rate = raw.readUInt32LE(24);
const bits = raw.readUInt16LE(34);
if (channels !== 2 || bits !== 16) throw new Error(`expected 16-bit stereo; got ${channels}ch ${bits}bit`);
const dataOff = 44;
// Mono downmix for analysis.
const n = (raw.length - dataOff) / (2 * channels);
const samples = new Float32Array(n);
for (let i = 0; i < n; i++) {
  const off = dataOff + i * 2 * channels;
  const l = raw.readInt16LE(off) / 32768;
  const r = raw.readInt16LE(off + 2) / 32768;
  samples[i] = (l + r) / 2;
}

const tl = parseMusicXML(readFileSync(xmlPath, 'utf8'), { DOMParser });
const pitched = tl.events.filter((e) => e.midi != null && !e.rest);

// ---------- FFT (iterative radix-2) ----------
function fftMagWindow (samples, start, size) {
  const N = size;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    const i = Math.min(start + k, samples.length - 1);
    const h = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (N - 1)); // Hann
    re[k] = samples[i] * h;
    im[k] = 0;
  }
  // bit reversal
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
        const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
  const mag = new Float64Array(N / 2);
  for (let k = 0; k < N / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
  return mag;
}

function midiToFreq (m) { return 440 * Math.pow(2, (m - 69) / 12); }

const NFFT = 8192;
const binHz = rate / NFFT;
const failures = [];
const checks = [];
for (let i = 0; i < pitched.length; i += stride) {
  const e = pitched[i];
  const freq = midiToFreq(e.midi);
  const startSec = tl.msAt(e.startBeats) / 1000;
  const start = Math.floor(startSec * rate);
  if (start < 0 || start > samples.length - NFFT) continue; // skip beyond audio tail
  const mag = fftMagWindow(samples, start, NFFT);
  let peak = 0;
  for (let k = 1; k < mag.length; k++) if (mag[k] > peak) peak = mag[k];
  // expected frequency bin with ±3% radius (min 3 bins)
  const expectedBin = freq / binHz;
  const radius = Math.max(3, Math.floor(expectedBin * 0.03));
  let found = 0;
  for (let k = Math.max(1, Math.floor(expectedBin - radius)); k <= Math.min(mag.length - 1, Math.ceil(expectedBin + radius)); k++) {
    if (mag[k] > found) found = mag[k];
  }
  const ratio = peak > 0 ? found / peak : 0;
  const ok = ratio >= 0.15;
  checks.push({ measure: e.measure, midi: e.midi, freq: Math.round(freq), startSec: +startSec.toFixed(2), ratio: +ratio.toFixed(3), ok });
  if (!ok) failures.push(`m${e.measure} midi ${e.midi} (${Math.round(freq)}Hz @${startSec.toFixed(1)}s) ratio ${ratio.toFixed(2)}`);
}

const checked = checks.length;
const matched = checks.filter((c) => c.ok).length;
const ratio = checked ? matched / checked : 0;
const pass = checked >= 20 && ratio >= 0.90 && failures.length <= 5;

console.log(JSON.stringify({
  ok: pass,
  wav: wavPath,
  xml: xmlPath,
  checked,
  matched,
  matchRatio: +ratio.toFixed(3),
  failures: failures.slice(0, 10),
  sample: checks.slice(0, 8).map((c) => `m${c.measure} ${c.freq}Hz@${c.startSec}s r=${c.ratio}`),
}, null, 2));
process.exit(pass ? 0 : 1);