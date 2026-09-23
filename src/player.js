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

// src/player.js — MusicXML -> note timeline (pure, no audio deps).
// Parses a MusicXML score-partwise document into an ordered list of note events
// suitable for scheduling on a sampler. Environment-agnostic (works in Node and
// browsers) so the parse can be unit-tested headlessly.
//
// Returns:
// {
//   tempo,            // quarter notes per minute (default 120 when absent)
//   divisions,        // divisions per quarter note
//   timeSignature,    // { beats, beatType }
//   events: [{
//     id,             // "m<measure>-n<index>"
//     measure,        // measure number (string)
//     voice,          // voice number as written (or "1")
//     midi,           // MIDI note number (or null for rests)
//     startBeats,     // absolute position in quarter-note beats from the start
//     durBeats,       // duration in quarter-note beats
//     velocity,       // 0-1 (before dynamics mapping)
//   }],
//   totalBeats,       // end of the last event
//   durationMs,       // totalBeats * 60 / tempo * 1000
// }
//
// Voice handling: <backup>/<forward> move the reading position inside the measure the same
// way a real reader would, so multi-voice parts (e.g. melody + accompaniment) play
// simultaneously. Each measure then lasts its true rhythmic span — not the concatenation
// of every voice — keeping playback in sync with the written time signature.

const STEP_MIDI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

const typeBeats = {
  whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25, '32nd': 0.125, '64th': 0.0625,
  'breve': 8, 'long': 16,
};

function midiOf (step, alter, octave) {
  const alterSemis = { 0: 0, 1: 1, 2: 2, '-1': -1, '-2': -2 };
  return 12 * (octave + 1) + STEP_MIDI[step] + (alterSemis[String(alter)] ?? alter ?? 0);
}

// ---------------------------------------------------------------------------
// Repeat / volta expansion — the audio "playlist", mirroring MuseScore 3's
// RepeatList::unwind() and vexml's MeasureSequenceIterator (which our playback
// cursor already rides). We expand the SAME way vexml does so audio, cursor,
// and MuseScore all agree: repeated measures replay, voltas pick their pass,
// and totalBeats/durationMs reflect the expanded playback length.
//
// The MusicXML repeat structure mirrors vexml's reader:
//   - `<repeat direction="forward">`   starts a block (repeatstart)
//   - `<repeat direction="backward" times="N">` ends one (repeatend), default 2
//   - `<ending number="1" type="start|stop|discontinue">` a volta (repeatending)
// The iterator then unwinds: play the block, back-jump `times-1` more times,
// taking each ending only on the passes its `number` covers.
// ---------------------------------------------------------------------------

/* How many passes an ending covers, from its `<ending number>` ("1", "1,2", "1-3"). */
function endingPasses (numberAttr) {
  if (!numberAttr) return 1;
  let total = 0;
  for (const part of numberAttr.split(',')) {
    const range = part.trim().match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) total += Math.max(1, Number(range[2]) - Number(range[1]) + 1);
    else if (part.trim()) total += 1;
  }
  return Math.max(1, total);
}

/* The FIRST pass an ending covers. Playback compares this across adjacent runs:
 * a number that doesn't climb means the volta group restarted (an enclosing
 * repeat block), not another ending of this block. */
function endingFirstPass (numberAttr) {
  return Number(numberAttr?.split(/[,-]/)[0]?.trim()) || 1;
}

/* One measure's `<barline>`s, flattened (a measure can carry a left repept and a
 * right repeat/ending). Mirrors vexml's readBarlines. */
function readBarlines (measure) {
  const read = { repeatBegin: false, repeatEnd: false, repeatTimes: null, started: null, closed: null };
  for (const barline of measure.querySelectorAll(':scope > barline')) {
    const repeat = barline.querySelector(':scope > repeat');
    if (repeat) {
      const dir = repeat.getAttribute('direction');
      if (dir === 'forward') read.repeatBegin = true;
      else if (dir === 'backward') {
        read.repeatEnd = true;
        read.repeatTimes = Number(repeat.getAttribute('times')) || null;
      }
    }
    const ending = barline.querySelector(':scope > ending');
    if (ending) {
      const t = ending.getAttribute('type');
      if (t === 'start') read.started = ending.getAttribute('number');
      else read.closed = t;
    }
  }
  return read;
}

/* Resolve the open/closed ending runs in one document-order pass (an ending
 * spans measures but MusicXML only marks its edges; some exporters restate
 * start/stop on every measure — a stop immediately re-opening with the same
 * number is one bracket, not a pile of endings). Mirrors vexml's measureRepeats. */
function measureRepeats (measures) {
  const read = measures.map(readBarlines);
  const out = [];
  let open = null;
  for (let i = 0; i < read.length; i++) {
    const r = read[i];
    const number = r.started ?? open;
    const first = number !== null && open === null;
    const restated = r.closed !== null && read[i + 1]?.started === number;
    const last = r.closed !== null && !restated;
    open = number === null || last ? null : number;
    out.push({
      repeatBegin: r.repeatBegin,
      repeatEnd: r.repeatEnd,
      repeatTimes: r.repeatTimes,
      ending: number === null ? null : { number, first, last },
    });
  }
  return out;
}

/* Per-measure jump list, exactly vexml/jumpsByMeasure: an ending supersedes a
 * co-located backward repeat — the iterator drives the back-jump off the
 * ending instead. */
function jumpsByMeasure (measures) {
  return measureRepeats(measures).map((m) => {
    const jumps = [];
    if (m.repeatBegin) jumps.push({ type: 'repeatstart' });
    if (m.ending) {
      jumps.push({
        type: 'repeatending',
        times: endingPasses(m.ending.number),
        last: m.ending.last,
        number: endingFirstPass(m.ending.number),
      });
    } else if (m.repeatEnd) {
      jumps.push({ type: 'repeatend', times: Math.max(0, (m.repeatTimes ?? 2) - 1) });
    }
    return jumps;
  });
}

/* Port of vexml's MeasureSequenceIterator: pre-scan pairs repeatends with their
 * repeatstarts and groups ending runs into voltas, then a linear walk back-jumps
 * and skips exhausted endings. Returns measure indices in PLAYBACK order. */
function measureOrderFromJumps (measures) {
  const repeatEndsByMeasure = new Map();
  const voltas = [];
  const endingByMeasure = new Map();
  const startStack = [];
  let currentVolta = null;
  let currentEnding = null;

  const closeVolta = () => {
    currentEnding = null;
    if (currentVolta !== null && startStack.at(-1) === currentVolta.startIndex) {
      startStack.pop();
    }
    currentVolta = null;
  };

  const findJump = (jumps, type) => jumps.find((j) => j.type === type);

  for (const [i, measure] of measures.entries()) {
    for (const jump of measure.jumps) {
      if (jump.type === 'repeatstart') startStack.push(i);
    }

    const endingJump = findJump(measure.jumps, 'repeatending');
    if (endingJump) {
      const previous = currentVolta?.endings.at(-1);
      if (
        currentEnding === null &&
        previous !== undefined &&
        endingJump.number <= previous.number
      ) {
        closeVolta();
      }
      if (currentVolta === null) {
        currentVolta = { startIndex: startStack.at(-1) ?? 0, endings: [], totalPasses: 0 };
        voltas.push(currentVolta);
      }
      let ending = currentEnding;
      if (ending === null) {
        ending = {
          startIndex: i,
          endIndex: i,
          times: endingJump.times,
          number: endingJump.number,
          startPass: 0,
          endPass: 0,
        };
        currentVolta.endings.push(ending);
      } else {
        ending.endIndex = i;
      }
      currentEnding = endingJump.last ? null : ending;
      endingByMeasure.set(i, { volta: currentVolta, ending });
      continue; // a repeatend co-located with a repeatending is intentionally dropped
    }

    if (currentVolta !== null) closeVolta();

    const endJump = findJump(measure.jumps, 'repeatend');
    if (endJump) {
      const startIndex = startStack.pop() ?? 0;
      repeatEndsByMeasure.set(i, { measureIndex: i, startIndex, times: endJump.times });
    }
  }

  // Close any volta that runs to the end of the score.
  if (currentVolta !== null && startStack.at(-1) === currentVolta.startIndex) {
    startStack.pop();
  }

  for (const volta of voltas) {
    const last = volta.endings.at(-1);
    let pass = 1;
    for (const ending of volta.endings) {
      const effective = ending === last && ending.times === 0 ? 1 : ending.times;
      ending.startPass = pass;
      ending.endPass = pass + effective - 1;
      pass += effective;
    }
    const sum = pass - 1;
    const needsImplicitFinalPass =
      volta.endings.length === 1 && last !== undefined && last.times > 0;
    volta.totalPasses = needsImplicitFinalPass ? sum + 1 : sum;
  }

  const result = [];
  const remainingBackJumps = new Map();
  const voltaPass = new Map();

  const resetNestedState = (startIndex, endIndex) => {
    for (const measureIndex of repeatEndsByMeasure.keys()) {
      if (measureIndex > startIndex && measureIndex < endIndex) {
        remainingBackJumps.delete(measureIndex);
      }
    }
    for (const volta of voltas) {
      if (volta.startIndex > startIndex && volta.startIndex < endIndex) {
        voltaPass.delete(volta);
      }
    }
  };

  let i = 0;
  while (i < measures.length) {
    if (!measures[i]) break;

    const endingHit = endingByMeasure.get(i);
    if (endingHit) {
      const pass = voltaPass.get(endingHit.volta) ?? 1;
      if (pass < endingHit.ending.startPass || pass > endingHit.ending.endPass) {
        i++;
        continue;
      }
    }

    result.push(i);

    if (endingHit) {
      const { volta, ending } = endingHit;
      if (i < ending.endIndex) { i++; continue; } // mid-run, keep playing
      const nextPass = (voltaPass.get(volta) ?? 1) + 1;
      if (nextPass > volta.totalPasses) {
        voltaPass.delete(volta);
        i++;
      } else {
        voltaPass.set(volta, nextPass);
        resetNestedState(volta.startIndex, i);
        i = volta.startIndex;
      }
      continue;
    }

    const repeatEnd = repeatEndsByMeasure.get(i);
    if (repeatEnd) {
      if (repeatEnd.times === 0) { i++; continue; }
      const remaining = remainingBackJumps.get(i) ?? repeatEnd.times;
      if (remaining > 0) {
        remainingBackJumps.set(i, remaining - 1);
        resetNestedState(repeatEnd.startIndex, i);
        i = repeatEnd.startIndex;
      } else {
        remainingBackJumps.delete(i);
        i++;
      }
      continue;
    }

    i++;
  }

  return result;
}

function textOf (el, tag) {
  return el.querySelector(tag)?.textContent ?? null;
}

function toNumber (el, tag) {
  const t = textOf(el, tag);
  return t == null ? null : Number(t);
}

// MusicXML <beat-unit> name -> quarter notes, so a metronome mark normalizes to quarter BPM.
// Mirrors vexml's QUARTERS_PER_UNIT (sequence-factory.ts).
const QUARTERS_PER_UNIT = {
  whole: 4, half: 2, quarter: 1, eighth: 0.5,
  '16th': 0.25, '32nd': 0.125, '64th': 0.0625, '128th': 0.03125,
};

/* A measure's PLAYBACK tempo in quarter-note beats per minute, or null when it carries no
 * mark (the tempo already in force carries forward). Mirrors vexml's playbackTempoOf +
 * quarterBpm: a visible <metronome> with a <beat-unit> wins (bpm from <per-minute>, falling
 * back to that direction's <sound tempo>, then 120), normalized by the beat-unit; otherwise
 * the first <sound tempo> in the measure — MusicXML's tempo is already quarter-note BPM. */
function tempoBpmOfMeasure (measure) {
  for (const dir of measure.querySelectorAll(':scope > direction')) {
    const metronome = dir.querySelector(':scope > direction-type > metronome');
    if (!metronome) continue;
    const beatUnit = metronome.querySelector(':scope > beat-unit');
    if (!beatUnit) continue;
    const perMinute = Number(metronome.querySelector(':scope > per-minute')?.textContent?.trim());
    const soundTempo = Number(dir.querySelector(':scope > sound')?.getAttribute('tempo'));
    const bpm = perMinute || soundTempo || 120;
    return bpm * (QUARTERS_PER_UNIT[beatUnit.textContent.trim()] ?? 1);
  }
  for (const sound of [
    ...measure.querySelectorAll(':scope > sound'),
    ...measure.querySelectorAll(':scope > direction > sound'),
  ]) {
    const t = Number(sound.getAttribute('tempo'));
    if (t > 0) return t;
  }
  return null;
}

/* Port of vexml's TempoMap.msAt: quarter-note beats -> milliseconds by folding every
 * segment the beat spans, plus the partial it lands in. A beat past the last segment
 * extrapolates at the last segment's rate. */
function tempoMsAt (segments, beats) {
  const last = segments.at(-1);
  if (!last) return (beats / 120) * 60000;
  let ms = 0;
  for (const seg of segments) {
    if (beats <= seg.startBeat) break;
    const upto = Math.min(beats, seg.endBeat);
    ms += ((upto - seg.startBeat) / seg.bpm) * 60000;
  }
  if (beats > last.endBeat) {
    ms += ((beats - last.endBeat) / last.bpm) * 60000;
  }
  return ms;
}

/* Port of vexml's TempoMap.beatsAt: the monotonic inverse of tempoMsAt. */
function tempoBeatsAt (segments, ms) {
  const last = segments.at(-1);
  if (!last) return (ms / 60000) * 120;
  let elapsed = 0;
  for (const seg of segments) {
    const segMs = ((seg.endBeat - seg.startBeat) / seg.bpm) * 60000;
    if (ms <= elapsed + segMs) {
      return seg.startBeat + ((ms - elapsed) / 60000) * seg.bpm;
    }
    elapsed += segMs;
  }
  return last.endBeat + ((ms - elapsed) / 60000) * last.bpm;
}

/* The bpm in force at a beat position (segments are disjoint and ordered). */
function tempoBpmAt (segments, beats) {
  for (const seg of segments) {
    if (beats >= seg.startBeat && beats < seg.endBeat) return seg.bpm;
  }
  return segments.at(-1)?.bpm ?? 120;
}

export function parseMusicXML (xmlString, { DOMParser: Parser = globalThis.DOMParser } = {}) {
  const doc = new Parser().parseFromString(xmlString, 'application/xml');
  const root = doc.documentElement;
  if (root.nodeName !== 'score-partwise') {
    throw new Error(`Expected score-partwise, got ${root.nodeName}`);
  }

  const part = root.querySelector(':scope > part');
  if (!part) throw new Error('No <part> found');

  // Global score metadata (first part is authoritative for our pipeline).
  const divisions = toNumber(part, 'attributes > divisions') ?? 1;
  const timeSignature = (() => {
    const beats = toNumber(part, 'attributes > time > beats');
    const beatType = toNumber(part, 'attributes > time > beat-type');
    return beats && beatType ? { beats, beatType } : null;
  })();
  // Metre-aware parsing: divisions and time signature may change mid-score (each page of a
  // multi-page merge re-declares them). Keep the first for metadata, track the current one
  // while walking measures, and only use per-measure declarations for actual timing.

  const events = [];
  let measureStartBeats = 0; // absolute beat position of the current measure's start
  let eventCount = 0;
  const laneTails = new Map(); // "measure\0occ\0part\0voice" -> { event, startTicks } for tie handling

  // Multi-part scores: a score-partwise file can have several <part>s (e.g. Voice + Piano
  // exported by Audiveris). They PLAY SIMULTANEOUSLY, one per staff — so unlike the old
  // document-order walk (which serialised P1 then P2 and caused the "long silent measures"),
  // we process every part's measure of the same NUMBER together, resetting the reading
  // position to 0 at each part's measure start (an implicit <backup> to the bar-line).
  const parts = [...root.querySelectorAll(':scope > part')];
  const perPartMeasures = parts.map((p) => [...p.querySelectorAll(':scope > measure')]);
  const measureNumbers = [...new Set(perPartMeasures.flat().map((m) => m.getAttribute('number') || ''))];

  // Effective per-part, per-measure divisions/time signature, resolved in one document-order
  // pass (a page only re-declares its values on its first measure, so they carry forward).
  // Precomputed so a repeat BACK-JUMP re-applies each measure's signature as written —
  // exactly how MuseScore's RepeatList and vexml's SequenceFactory re-apply tempo on a jump.
  const ctxByKey = new Map(); // "p\0measureNo" -> { div, sig }
  perPartMeasures.forEach((list, p) => {
    const ctx = { div: divisions, sig: timeSignature };
    for (const measure of list) {
      const no = measure.getAttribute('number') || '';
      const divEl = measure.querySelector(':scope > attributes > divisions');
      if (divEl) ctx.div = Number(divEl.textContent) || ctx.div;
      const tsEl = measure.querySelector(':scope > attributes > time');
      if (tsEl) {
        const b = Number(tsEl.querySelector('beats')?.textContent);
        const bt = Number(tsEl.querySelector('beat-type')?.textContent);
        if (b && bt) ctx.sig = { beats: b, beatType: bt };
      }
      ctxByKey.set(`${p}\u0000${no}`, { div: ctx.div, sig: ctx.sig });
    }
  });

  // Repeat-aware playback order over the FIRST part's measures (the system-authoritative
  // lane: repeat bars and voltas apply across the system, so the structure is read there,
  // matching vexml). With no repeat structure this collapses to document order.
  const firstMeasures = perPartMeasures[0] ?? [];
  // Playback tempo map, per measure number, from the FIRST part (the system-authoritative
  // lane, matching vexml). A measure's mark sets the quarter-BPM from there on; null carries
  // the previous rate; a back-jump re-applies each measure's mark as written.
  const tempoBpmByNo = new Map(); // measure number -> quarter-BPM mark or null
  for (const measure of firstMeasures) {
    tempoBpmByNo.set(measure.getAttribute('number') || '', tempoBpmOfMeasure(measure));
  }
  let orderNumbers;
  let firstIndexByNumber = new Map(); // measure number -> first part's measure index
  if (firstMeasures.length === 0) {
    orderNumbers = measureNumbers;
  } else {
    const jumps = jumpsByMeasure(firstMeasures);
    const orderIdx = measureOrderFromJumps(
      firstMeasures.map((m, i) => ({ index: i, jumps: jumps[i] ?? [] })),
    );
    orderNumbers = orderIdx.map(
      (i) => firstMeasures[i]?.getAttribute('number') || String(i + 1),
    );
    firstIndexByNumber = new Map(orderNumbers.map((no, k) => [no, orderIdx[k]]));
  }

  const occurrences = []; // per-occurrence start beats, in playback order (for the cursor map)
  const tempoSegments = []; // per-occurrence rate segments { startBeat, endBeat, bpm } (vexml TempoMap)
  let carried = 120; // quarter-BPM carried across occurrences; a measure's mark sets it from there on

  for (const measureNo of orderNumbers) {
    const occ = occurrences.length;
    let measureQmax = 0;      // furthest content end, in quarter-note beats (across parts)
    let writtenQ = 0;         // written meter length (quarters) from the first part's signature
    let writtenScale = 1;     // pacing scale of that same signature (beatType / 4)
    let wroteSpan = false;

    for (let p = 0; p < perPartMeasures.length; p++) {
      const measure = perPartMeasures[p].find((m) => (m.getAttribute('number') || '') === measureNo);
      if (!measure) continue;
      const ctx = ctxByKey.get(`${p}\u0000${measureNo}`) ?? { div: divisions, sig: timeSignature };
      const div = ctx.div;
      if (!wroteSpan && ctx.sig) {
        writtenQ = ctx.sig.beats * (4 / ctx.sig.beatType);
        writtenScale = ctx.sig.beatType / 4;
        wroteSpan = true;
      }
      // Meter-aware pacing: the tempo (120 QPM default) is interpreted in the SIGNATURE's
      // beat unit, exactly like MuseScore does on a file with no explicit metronome mark —
      // so a 2/2 (cut time) bar at "120" lasts 1 s (2 half-note beats), not the 2 s a
      // quarter-note reading gives it. BeatType 4 => scale 1 (unchanged, incl. 2/4), 2/2 => 0.5.
      // Applied to in-measure offsets, durations AND the measure's grid span.
      const scale = ctx.sig ? ctx.sig.beatType / 4 : 1;
      // Position within this (part, measure): starts at the bar-line, like an implicit
      // <backup> so simultaneous parts align instead of stacking back-to-back.
      let localTicks = 0;
      let lastNoteStartTicks = 0;
      let partMaxTicks = 0;

      for (const el of [...measure.children]) {
        const tag = el.nodeName;
        if (tag === 'backup' || tag === 'forward') {
          const delta = Number(el.querySelector('duration')?.textContent) || 0;
          localTicks = tag === 'backup'
            ? Math.max(0, localTicks - delta)
            : localTicks + delta;
          continue;
        }
        if (tag !== 'note') continue;

        const voice = textOf(el, 'voice') || '1';
        const isChord = textOf(el, 'chord') != null;
        const rest = textOf(el, 'rest') != null;
        const durTicks = toNumber(el, 'duration') ?? 0;
        const durBeats = durTicks / div;

        // Grace notes are decorative for v1 playback.
        if (textOf(el, 'grace') != null) continue;

        // Tied continuation: extend the sounding note in this lane, don't strike a new one.
        const tieStop = el.querySelector('tie[type="stop"]');
        if (tieStop && !rest) {
          const tail = laneTails.get(`${measureNo}\u0000${occ}\u0000${p}\u0000${voice}`);
          if (tail && !tail.event.rest && Math.abs(tail.startTicks - localTicks) <= 0.1) {
            tail.event.durBeats += durBeats;
          }
          localTicks += durTicks; // the reading position still moves past this note
          continue;
        }

        const pitchEl = el.querySelector('pitch');
        const midi = rest || !pitchEl
          ? null
          : midiOf(textOf(pitchEl, 'step'), toNumber(pitchEl, 'alter'), toNumber(pitchEl, 'octave'));

        const type = textOf(el, 'type');
        const dots = (el.querySelectorAll('dot').length || 0);
        let durType = durBeats;
        if (type && typeBeats[type] && durType <= 0.001) {
          durType = typeBeats[type] * (2 - 1 / Math.pow(2, dots)); // dotted fallback
        }
        if (durType <= 0.001) durType = 0.001;

        const startTicks = isChord ? lastNoteStartTicks : localTicks;
        const startBeats = measureStartBeats + (startTicks / div) * scale;
        if (!isChord) localTicks += durTicks; // chords share the previous note's start
        lastNoteStartTicks = startTicks;

        const spanTicks = durTicks > 0 ? durTicks : durType * div;
        partMaxTicks = Math.max(partMaxTicks, startTicks + spanTicks);

        eventCount += 1;
        const event = {
          id: `m${measureNo}-${p}-${eventCount}`,
          measure: measureNo,
          occ, // playback occurrence (0-based); repeated measures reuse the same 'measure'
          voice: p > 0 ? `${voice}#${p + 1}` : voice,
          midi,
          startBeats,
          durBeats: durType * scale, // signature-beat pacing: 2/2 quarters are twice as fast
          velocity: 0.8,
          rest,
        };
        events.push(event);
        laneTails.set(`${measureNo}\u0000${occ}\u0000${p}\u0000${voice}`, { event, startTicks });
      }
      measureQmax = Math.max(measureQmax, (partMaxTicks / div) * scale);
    }

    // The next measure begins after whatever is furthest across all parts — the real content
    // or the written meter — so short/empty measures still leave a correct, metre-aligned
    // grid. Both are in signature-beat-pacing units (content and written share `writtenScale`).
    const spanBeats = Math.max(measureQmax, writtenQ * writtenScale);
    const mark = tempoBpmByNo.get(measureNo);
    if (mark != null && mark > 0) carried = mark;
    const startBeats = measureStartBeats;
    occurrences.push({
      index: firstIndexByNumber.get(measureNo) ?? measureNumbers.indexOf(measureNo),
      measure: measureNo,
      startBeats,
      spanBeats,
    });
    tempoSegments.push({ startBeat: startBeats, endBeat: startBeats + spanBeats, bpm: carried });
    measureStartBeats += spanBeats;
  }

  const totalBeats = events.reduce((m, e) => Math.max(m, e.startBeats + e.durBeats), 0);
  return {
    tempo: tempoSegments[0]?.bpm ?? 120, // dropdown default: the rate in force at the start
    tempoSegments,
    msAt: (beats) => tempoMsAt(tempoSegments, beats),
    beatsAt: (ms) => tempoBeatsAt(tempoSegments, ms),
    bpmAt: (beats) => tempoBpmAt(tempoSegments, beats),
    divisions,
    timeSignature,
    events,
    occurrences,
    totalBeats,
    durationMs: tempoMsAt(tempoSegments, totalBeats),
  };
}

// Playable note set (unique midis, in 21..108) — used to build the sampler url map.
// Tone keys use sharp names (as Tone.Frequency(midi).toNote() produces); the
// midi-js-soundfonts MusyngKite set names files by flats (Db/Eb/Gb/Ab/Bb).
export function noteNameMap (events) {
  const midis = [...new Set(events.map((e) => e.midi).filter((m) => m != null && m >= 21 && m <= 108))].sort((a, b) => a - b);
  const sharp = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const flat = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  return midis.map((m) => {
    const pc = m % 12;
    const octave = Math.floor(m / 12) - 1;
    return { midi: m, name: `${sharp[pc]}${octave}`, file: `${flat[pc]}${octave}.mp3` };
  });
}