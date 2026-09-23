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

// scripts/merge-sheets.mjs — combine per-page Audiveris .mxl exports into ONE score-partwise
// MusicXML with correct multi-part structure.
//
// Real exports have multiple parts per page (typically "Voice" and "Piano", page 23 here even has
// two Voice parts). This merge:
//   * keeps parts by name — Voice (P1) and Piano (P2) — appending each page's measures to the
//     matching target part (an earlier naive merge dumped ALL parts' measures into one part, which
//     doubled the bar count and produced the "long silent measures");
//   * folds any additional parts (extra voice staves) INTO their target part as extra
//     <voice> lanes (simultaneous, not sequential);
//   * pads short parts with empty measures so every part has the same measure count;
//   * normalizes <divisions> to one value per part (MuseScore 3 imports a single global
//     divisions — Audi page exports use 4/12/4/2 and confuse it);
//   * drops measures with no <note> at all (Audiveris fill-bar artifacts);
//   * renumbers all measures sequentially across pages.
//
// It also audits each sheet (time signature, key, meter changes, per-measure over/under-fill).
// Usage: node scripts/merge-sheets.mjs <page1.mxl> <page2.mxl> … -o out.musicxml [--title T]
import { readFileSync, writeFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { DOMParser } from 'linkedom';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const mxlPaths = args.filter((a) => a.toLowerCase().endsWith('.mxl'));
const out = flag('-o') || flag('--out') || 'scores/merged.musicxml';
const title = flag('--title') || null;
if (mxlPaths.length < 2) {
  console.error('usage: node scripts/merge-sheets.mjs a.mxl b.mxl … -o out.musicxml [--title "Avalon"]');
  process.exit(2);
}

function readXmlFromMxl (path) {
  const entries = unzipSync(new Uint8Array(readFileSync(path)));
  const k = Object.keys(entries).find((n) => /\.(musicxml|xml)$/i.test(n) && !n.startsWith('__MACOSX'));
  if (!k) throw new Error(`${path}: no .xml inside .mxl`);
  return strFromU8(entries[k]);
}

const MEASURE_RE = /<measure\b[\s\S]*?<\/measure>/g;
// Bare `<note>` misses attributed notes (`<note default-x="...">`), which Audiveris emits for
// pitched music — page 23's second Voice (chorus melody) was silently dropped without ever
// matching. Keep the word boundary so `<note` inside <notehead>/<notetype> never matches.
const NOTE_RE = /<note\b[^>]*>[\s\S]*?<\/note>/g;

// Split a sheet's XML into <part id="..."> blocks (a part ends at <part id= or </score-partwise>).
function partBlocks (xml) {
  const blocks = [];
  const re = /<part id="([^"]*)"[^>]*>/g;
  let m;
  while ((m = re.exec(xml))) {
    const id = m[1];
    const from = m.index + m[0].length;
    const next = xml.slice(from).search(/<part id="/);
    const endTag = xml.indexOf('</part>', from);
    let to = next >= 0 ? from + next : endTag;
    if (to < 0) to = xml.length;
    blocks.push({ id, xml: xml.slice(from, to) });
  }
  return blocks;
}

// Score-part names in order, so Voice/Piano parts can be mapped across pages.
function partNames (xml) {
  const names = new Map();
  for (const m of xml.matchAll(/<score-part id="([^"]+)"[^>]*>[\s\S]*?<part-name>([^<]*)<\/part-name>/g)) {
    names.set(m[1], m[2].trim());
  }
  return names;
}

// ---- Per-sheet audit (time signature = the "playable?" gate) ----
function auditSheet (path, sheetDiv) {
  const xml = readXmlFromMxl(path);
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const part = doc.querySelector('part');
  const measures = [...(part?.querySelectorAll('measure') ?? [])];
  const div = Number(doc.querySelector('divisions')?.textContent) || 4;

  const sigs = [];
  for (const m of measures) {
    const beats = m.querySelector('time > beats')?.textContent;
    const bt = m.querySelector('time > beat-type')?.textContent;
    if (beats && bt && !sigs.some((s) => s.beats === beats && s.bt === bt)) {
      sigs.push({ beats, bt, atMeasure: m.getAttribute('number') });
    }
  }
  const firstTime = measures.find((m) => m.querySelector('time'));
  const time = firstTime
    ? `${firstTime.querySelector('time > beats')?.textContent}/${firstTime.querySelector('time > beat-type')?.textContent}` : '?';
  const fifths = firstTime?.querySelector('key > fifths')?.textContent ?? '?';
  const meterQ = time !== '?' ? Number(time.split('/')[0]) * (4 / Number(time.split('/')[1])) : null;
  const overfull = [];
  for (const m of measures) {
    const maxDur = Math.max(0, ...[...m.querySelectorAll('duration')].map((d) => Number(d.textContent))) / div;
    if (meterQ != null && maxDur > meterQ + 0.001) overfull.push(`#${m.getAttribute('number')} ${maxDur}q>${meterQ}q`);
  }
  return {
    file: path.split(/[\\/]/).pop(),
    divisions: sheetDiv,
    timeSignature: time,
    keyFifths: fifths,
    meterChanges: sigs,
    measures: measures.length,
    overfull,
  };
}

// ---- Collect measures per part across pages (in document order), with number assignment ----
const TARGETS = ['Voice', 'Piano'];
const collected = { Voice: [], Piano: [] };
const sheetAudits = [];
const folds = []; // { pageFile, atMeasure, lane, notesInserted }

mxlPaths.forEach((path) => {
  const xml = readXmlFromMxl(path);
  const names = partNames(xml);
  const blocks = partBlocks(xml);
  const sheetDiv = Number(/<divisions>(\d+)<\/divisions>/.exec(xml)?.[1]) || 4;
  sheetAudits.push(auditSheet(path, sheetDiv));

  // Map blocks to target lanes. First Voice part -> Voice; first Piano -> Piano; extras fold in.
  let voiceBlocks = 0;
  let pianoBlocks = 0;
  for (const b of blocks) {
    const name = names.get(b.id) || '';
    const isPiano = /piano|keyboard|piano/i.test(name);
    const lane = isPiano ? 'Piano' : 'Voice';
    if (lane === 'Voice') voiceBlocks += 1; else pianoBlocks += 1;
    const isFirst = lane === 'Voice' ? voiceBlocks === 1 : pianoBlocks === 1;
    const measures = [...b.xml.matchAll(MEASURE_RE)].map((m) => m[0]);

    if (isFirst) {
      // Normalize divisions on the fly: rescale durations, force the sheet's divisions value.
      const factor = 12 / sheetDiv;
      const scaled = measures.map((frag) =>
        frag.replace(/<duration>(\d+)<\/duration>/g, (_, d) => `<duration>${Math.round(Number(d) * factor)}</duration>`)
            .replace(/<divisions>\d+<\/divisions>/g, '<divisions>12</divisions>'));
      collected[lane].push({ path, sheetDiv, measures: scaled });
    } else if (lane === 'Voice') {
      // Extra voice part: fold into the Voice target as extra lanes (simultaneous).
      if (collected.Voice.length === 0) throw new Error(`${path}: extra voice before any Voice part`);
      const targetBlock = collected.Voice[collected.Voice.length - 1];
      // Align measure-by-measure with the page's primary Voice measures.
      const primary = collected.Voice[collected.Voice.length - 1].measures;
      const DIRECTION_RE = /<direction\b[^>]*>[\s\S]*?<\/direction>|<harmony\b[^>]*>[\s\S]*?<\/harmony>/g;
      measures.forEach((extraFrag, i) => {
        const targetFrag = primary[i];
        if (!targetFrag) return;
        // Voice lane number: pick a lane above everything used in this measure.
        const used = new Set([...primary[i].matchAll(/<voice>(\d+)<\/voice>/g)].map((m) => m[1]));
        let laneNo = 20;
        while (used.has(String(laneNo))) laneNo += 1;
        const notes = [...extraFrag.matchAll(NOTE_RE)].map((m) => m[0])
          .map((n) => n.replace(/<voice>\d+<\/voice>/, `<voice>${laneNo}</voice>`));
        // A folded voice may also carry expressions (dynamics/words/harmony) on its staff:
        // keep them so the merged score preserves every element of the printed part.
        const directions = [...extraFrag.matchAll(DIRECTION_RE)].map((m) => m[0]);
        if (!notes.length && !directions.length) return;
        // Backup to the measure start so the added voice overlaps the primary, not follows it.
        const p1Ticks = [...targetFrag.matchAll(NOTE_RE)]
          .map((m) => (/<chord\s*\/?\s*>/.test(m[0]) ? 0 : Number(/<duration>(\d+)<\/duration>/.exec(m[0])?.[1] || 0)))
          .reduce((a, b) => a + b, 0);
        const backup = `<backup><duration>${p1Ticks}</duration></backup>`;
        primary[i] = targetFrag.replace(/<\/measure>/, backup + notes.join('') + directions.join('') + '</measure>');
        folds.push({ page: path.split(/[\\/]/).pop(), atMeasure: i + 1, laneNo, notes: notes.length, directions: directions.length });
      });
    }
  }

  // Pad shorter parts on this page to the page's primary part length, so all parts stay
  // aligned measure-for-measure. The pad is a whole rest of the page's written meter.
  const pageVoiceLen = collected.Voice.length ? collected.Voice[collected.Voice.length - 1].measures.length : 0;
  if (pageVoiceLen) {
    // Written span (in ticks @ divisions 12) of the page's first declared time signature.
    const m0 = collected.Voice[collected.Voice.length - 1].measures[0] || '';
    const beats = Number(/<beats>(\d+)<\/beats>/.exec(m0)?.[1]) || 4;
    const bt = Number(/<beat-type>(\d+)<\/beat-type>/.exec(m0)?.[1]) || 4;
    const spanTicks = beats * (4 / bt) * 12;
    const pianoBlock = collected.Piano[collected.Piano.length - 1];
    if (pianoBlock) {
      const cur = pianoBlock.measures.length;
      if (cur < pageVoiceLen) {
        for (let k = cur; k < pageVoiceLen; k++) {
          pianoBlock.measures.push(`<measure><note><rest measure="yes"/><duration>${spanTicks}</duration><voice>1</voice><type>whole</type></note></measure>`);
        }
        sheetAudits[sheetAudits.length - 1].pianoPadded = pageVoiceLen - cur;
        sheetAudits[sheetAudits.length - 1].pianoMeasures = cur;
      }
    }
  }
});

// ---- Renumber ALL measures sequentially across pages, per part ----
// Everything is kept (fill bars, pads) so every part has the SAME measure count and the
// measure numbers align across parts.
function renumber (list) {
  const out = [];
  let n = 0;
  for (const block of list) {
    for (const frag of block.measures) {
      n += 1;
      out.push(frag.replace(/<measure\b[^>]*>/, (tag) => tag.replace(/\snumber="[^"]*"/, '').replace(/^<measure/, `<measure number="${n}"`)));
    }
  }
  return { xml: out.join(''), count: n };
}

const voice = renumber(collected.Voice);
const piano = renumber(collected.Piano);

const head = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
${title ? `  <work><work-title>${title}</work-title></work>
  <movement-title>${title}</movement-title>
` : ''}  <part-list>
    <score-part id="P1"><part-name>Voice</part-name></score-part>
    <score-part id="P2"><part-name>Piano</part-name></score-part>
  </part-list>`;

const partXml = (id, body) => `  <part id="${id}">
${body}
  </part>`;

// ---- Fit-to-meter: compress overfull measures onto their written span ----
// Audiveris rhythm over-reads (typically 5 quarters in a 4-quarter bar, or voices that lost
// their <backup>) leave measures whose content exceeds the meter. MuseScore 3 then overflows
// the bar and shoves content into following measures, which shows up as shifted/rest-heavy
// bars. Normalize conservatively: scale every <duration> (notes + backup/forward) in the
// measure by written/content so the measure ends inside the bar-line; all notes and RELATIVE
// rhythms are preserved, so nothing is lost for the human-verification stage.
//
// Tolerance is MuseScore's own: its MusicXML importer rescales every <duration> onto the
// internal 480-ticks-per-quarter grid (MScore::division in libmscore/mscore.cpp) and treats
// up to maxDiff = 3 of those ticks as a rounding error (importmxmlnoteduration.cpp). At the
// file's divisions (12/quarter here) that band is 3 * 12 / 480 = 0.075 file ticks — i.e. a
// fit leaves NOTHING over by a whole tick (1 file tick = 40 MuseScore ticks > 3), or the bar
// still triggers MuseScore's measure-too-long handling.

// Reading-position end of a fragment in Div-ticks (a real reader honors <backup>/<forward>).
function measureEndInfo (xml) {
  const notes = [...xml.matchAll(/<note\b[^>]*>[\s\S]*?<\/note>/g)];
  let pos = 0;
  let lastStart = 0;
  let maxEnd = 0;
  let maxNote = 0;
  let ni = 0;
  for (const el of xml.matchAll(/<note\b[^>]*>[\s\S]*?<\/note>|<backup>[\s\S]*?<\/backup>|<forward>[\s\S]*?<\/forward>/g)) {
    const t = el[0];
    if (t.startsWith('<backup') || t.startsWith('<forward')) {
      const d = Number(/<duration>(\d+)<\/duration>/.exec(t)?.[1] || 0);
      pos = t.startsWith('<backup') ? Math.max(0, pos - d) : pos + d;
      continue;
    }
    const d = Number(/<duration>(\d+)<\/duration>/.exec(t)?.[1] || 0);
    const chord = /<chord\s*\/?\s*>/.test(t);
    const start = chord ? lastStart : pos;
    if (!chord) pos += d;
    lastStart = start;
    if (start + d > maxEnd) { maxEnd = start + d; maxNote = ni; }
    ni += 1;
  }
  return { maxEnd, maxNote, notes };
}

const measureEndTicks = (xml) => measureEndInfo(xml).maxEnd;

function fitToMeter (partXml) {
  const frags = [...partXml.matchAll(MEASURE_RE)].map((m) => m[0]);
  const out = [];
  const normalized = [];
  let div = 12;
  let sig = null;
  let curSig = null;
  for (const frag of frags) {
    const divM = /<divisions>(\d+)<\/divisions>/.exec(frag);
    if (divM) div = Number(divM[1]) || div;
    const beatsM = /<beats>(\d+)<\/beats>/.exec(frag);
    const btM = /<beat-type>(\d+)<\/beat-type>/.exec(frag);
    if (beatsM && btM) curSig = { beats: Number(beatsM[1]), bt: Number(btM[1]) };
    if (!sig && curSig) sig = curSig;
    const writtenT = curSig ? curSig.beats * (4 / curSig.bt) * div : 0;
    const toleranceTicks = (3 * div) / 480; // MuseScore's maxDiff, projected to file divisions
    const { maxEnd, maxNote, notes } = measureEndInfo(frag);
    if (writtenT > 0 && maxEnd > writtenT + toleranceTicks) {
      const factor = writtenT / maxEnd;
      const no = /<measure\b[^>]*\bnumber="([^"]*)"/.exec(frag)?.[1] ?? '?';
      normalized.push({ measure: no, contentTicks: maxEnd, writtenTicks: writtenT, factor: +factor.toFixed(3) });
      let scaled = frag.replace(/<duration>(\d+)<\/duration>/g, (_, d) =>
        `<duration>${Math.max(1, Math.round(Number(d) * factor))}</duration>`);
      // Rounding can leave the bar a tick or two over — and with several voices the overhang
      // may be held by a note that is NOT last in document order. Shave the current max-end
      // note by the residual and re-measure until the bar is within written (+ sub-tick band).
      while (measureEndTicks(scaled) > writtenT) {
        const { maxEnd: m2, maxNote: mn, notes: ns } = measureEndInfo(scaled);
        const nb = (ns[mn] ?? null)?.[0] ?? null;
        const dm = nb ? /<duration>(\d+)<\/duration>/.exec(nb) : null;
        if (!dm) break;
        const at = nb.indexOf('<duration>');
        const nv = Math.max(1, Number(dm[1]) - Math.max(1, m2 - writtenT));
        if (nv === Number(dm[1])) break; // at the 1-tick floor, nothing left to shave
        scaled = scaled.slice(0, ns[mn].index + at) + `<duration>${nv}</duration>` +
          scaled.slice(ns[mn].index + at + dm[0].length);
      }
      out.push(scaled);
    } else {
      out.push(frag);
    }
  }
  return { xml: out.join(''), normalized };
}

// ---- Sync time signatures across parts ----
// Audiveris re-declares the meter only on the part it puts the change in (and continuation
// pages carry it). If the piano part never picks up the verse->chorus change, MuseScore
// renders (and our player paces) those bars in the wrong meter. For every measure where the
// primary part declares a <time>, make the other parts declare the same one.
function syncTimeSignatures (primaryXml, otherXml) {
  const primFrags = [...primaryXml.matchAll(MEASURE_RE)].map((m) => m[0]);
  const otherFrags = [...otherXml.matchAll(MEASURE_RE)].map((m) => m[0]);
  for (let i = 0; i < primFrags.length && i < otherFrags.length; i++) {
    const timeM = /<time\b[^>]*>[\s\S]*?<\/time>/.exec(primFrags[i]);
    if (!timeM) continue;
    const beats = /<beats>(\d+)<\/beats>/.exec(timeM[0])?.[1];
    const bt = /<beat-type>(\d+)<\/beat-type>/.exec(timeM[0])?.[1];
    if (!beats || !bt) continue;
    const other = otherFrags[i];
    const foreignTime = /<time\b[^>]*>[\s\S]*?<\/time>/.exec(other);
    const timeXml = (foreignTime
      ? foreignTime[0].replace(/<beats>[\s\S]*?<\/beats>/, `<beats>${beats}</beats>`)
          .replace(/<beat-type>[\s\S]*?<\/beat-type>/, `<beat-type>${bt}</beat-type>`)
      : `<time><beats>${beats}</beats><beat-type>${bt}</beat-type></time>`)
      .replace(/\s+symbol="[^"]*"/, ''); // drop e.g. symbol="cut" if the meter changed
    let updated;
    if (foreignTime) {
      updated = other.replace(foreignTime[0], timeXml);
    } else if (/<attributes>[\s\S]*?<\/attributes>/.test(other)) {
      updated = other.replace(/<\/attributes>/, timeXml + '</attributes>');
    } else {
      updated = other.replace(/<measure\b[^>]*>/, (tag) => tag + `<attributes>${timeXml}</attributes>`);
    }
    otherFrags[i] = updated;
  }
  return otherFrags.join('');
}

const fitVoice = fitToMeter(voice.xml);
const fitPiano = fitToMeter(piano.xml);
const syncedPiano = syncTimeSignatures(fitVoice.xml, fitPiano.xml);

writeFileSync(out, head + '\n' + partXml('P1', fitVoice.xml) + '\n' + partXml('P2', syncedPiano) + '\n</score-partwise>\n');

console.log(JSON.stringify({
  ok: true,
  sheets: sheetAudits.map((s) => ({
    file: s.file, sig: s.timeSignature, key: s.keyFifths, measures: s.measures,
    pianoPadded: s.pianoPadded ?? 0, overfull: s.overfull,
  })),
  folds,
  fitNormalized: fitVoice.normalized.concat(fitPiano.normalized),
  voiceMeasures: voice.count,
  pianoMeasures: piano.count,
  out,
  outKb: Math.round(readFileSync(out).length / 1024),
}, null, 2));