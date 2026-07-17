import type { Analysis, Band, Chart, Difficulty, KeyCount, Note } from './types';

interface DiffConfig {
  /** grid subdivisions per beat: 1 = quarter notes, 2 = eighths, 4 = sixteenths */
  div: number;
  /** min ms between any two note slots */
  minGapMs: number;
  /** min ms before the same lane can be used again */
  laneGapMs: number;
  /** max notes in any sliding 1s window */
  maxPerSec: number;
  /** max simultaneous notes */
  chord: number;
  /** onset strength cutoff (higher = fewer notes) */
  strengthMin: number;
  longNotes: boolean;
}

const CONFIGS: Record<Difficulty, DiffConfig> = {
  easy: {
    div: 1, minGapMs: 280, laneGapMs: 340, maxPerSec: 2.5, chord: 1,
    strengthMin: 1.9, longNotes: false,
  },
  medium: {
    div: 2, minGapMs: 155, laneGapMs: 210, maxPerSec: 4.5, chord: 2,
    strengthMin: 1.55, longNotes: true,
  },
  hard: {
    div: 4, minGapMs: 82, laneGapMs: 135, maxPerSec: 7.5, chord: 3,
    strengthMin: 1.35, longNotes: true,
  },
};

/** Which lanes each frequency band prefers, per key mode. */
const BAND_LANES: Record<KeyCount, Record<Band, number[]>> = {
  4: { bass: [0, 3], mid: [1, 2], high: [2, 1] },
  5: { bass: [0, 2, 4], mid: [1, 3], high: [3, 1, 4] },
  7: { bass: [0, 3, 6], mid: [1, 2, 5], high: [2, 4, 5] },
};

function allowedLanes(keys: KeyCount, difficulty: Difficulty): number[] {
  // 7K easy avoids the pinky lanes; smaller modes use everything
  if (keys === 7 && difficulty === 'easy') return [1, 2, 3, 4, 5];
  return Array.from({ length: keys }, (_, i) => i);
}

interface Slot { tMs: number; bands: Map<Band, number>; }

export function generateChart(
  analysis: Analysis,
  difficulty: Difficulty,
  title: string,
  audioHash: string,
  keys: KeyCount = 7,
): Chart {
  const cfg = CONFIGS[difficulty];
  const lanes = allowedLanes(keys, difficulty);
  const bandLanes = BAND_LANES[keys];
  // fewer lanes saturate faster: scale chords and density down for 4K/5K
  const maxChord = Math.min(cfg.chord, keys - 2);
  const maxPerSec = cfg.maxPerSec * (keys === 7 ? 1 : keys === 5 ? 0.85 : 0.7);
  const beatMs = 60000 / analysis.bpm;
  const gridMs = beatMs / cfg.div;
  const snapTolMs = Math.min(45, gridMs * 0.4);

  // 1. snap onsets to the beat grid, merging same-time onsets into slots
  const slots = new Map<number, Slot>();
  for (const o of analysis.onsets) {
    if (o.tMs < 1500) continue; // give the player a moment before the first note
    if (o.strength < cfg.strengthMin) continue;
    const gridIdx = Math.round((o.tMs - analysis.beatOffsetMs) / gridMs);
    const snapped = analysis.beatOffsetMs + gridIdx * gridMs;
    const err = Math.abs(o.tMs - snapped);
    let tMs: number;
    let key: number;
    if (err <= snapTolMs) {
      tMs = Math.round(snapped);
      key = gridIdx;
    } else if (o.strength >= 2.5) {
      // strong but off-grid (syncopation or imperfect BPM): keep the real timing
      tMs = Math.round(o.tMs);
      key = 1_000_000 + Math.round(o.tMs / 30);
    } else {
      continue; // off-grid and weak: probably noise
    }
    let slot = slots.get(key);
    if (!slot) {
      slot = { tMs, bands: new Map() };
      slots.set(key, slot);
    }
    slot.bands.set(o.band, Math.max(slot.bands.get(o.band) ?? 0, o.strength));
  }

  // 2. density filtering: strongest slots win inside each 1s window
  const ordered = [...slots.values()].sort((a, b) => a.tMs - b.tMs);
  const kept: Slot[] = [];
  const strengthOf = (s: Slot) => Math.max(...s.bands.values());
  for (const slot of ordered) {
    const windowStart = slot.tMs - 1000;
    const inWindow = kept.filter((k) => k.tMs > windowStart);
    const last = kept[kept.length - 1];
    if (last && slot.tMs - last.tMs < cfg.minGapMs) {
      // too close: keep whichever is stronger
      if (strengthOf(slot) > strengthOf(last) * 1.25) kept[kept.length - 1] = slot;
      continue;
    }
    if (inWindow.length >= maxPerSec) {
      const weakest = inWindow.reduce((a, b) => (strengthOf(a) < strengthOf(b) ? a : b));
      if (strengthOf(slot) > strengthOf(weakest) * 1.15) {
        kept.splice(kept.indexOf(weakest), 1);
      } else {
        continue;
      }
    }
    kept.push(slot);
  }
  kept.sort((a, b) => a.tMs - b.tMs);

  // 3. lane assignment: per-band stair walkers over each band's lane pool
  const notes: Note[] = [];
  const lastLaneUse = new Array(keys).fill(-Infinity);
  const walker: Record<Band, { idx: number; dir: number }> = {
    bass: { idx: 0, dir: 1 },
    mid: { idx: 0, dir: 1 },
    high: { idx: 1, dir: -1 },
  };
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const pickLane = (band: Band, t: number, taken: Set<number>): number => {
    const pool = bandLanes[band].filter((l) => lanes.includes(l));
    const w = walker[band];
    for (let attempt = 0; attempt < pool.length; attempt++) {
      w.idx += w.dir;
      if (w.idx >= pool.length) { w.idx = pool.length - 1; w.dir = -1; }
      if (w.idx < 0) { w.idx = 0; w.dir = 1; }
      const lane = pool[w.idx];
      if (!taken.has(lane) && t - lastLaneUse[lane] >= cfg.laneGapMs) return lane;
    }
    // fallback: any allowed free lane
    const free = lanes.filter((l) => !taken.has(l) && t - lastLaneUse[l] >= cfg.laneGapMs);
    if (free.length) return free[Math.floor(rand() * free.length)];
    return -1;
  };

  for (let i = 0; i < kept.length; i++) {
    const slot = kept[i];
    const bands = [...slot.bands.entries()].sort((a, b) => b[1] - a[1]);
    const chordSize = Math.min(maxChord, bands.length);
    const taken = new Set<number>();
    for (let c = 0; c < chordSize; c++) {
      const [band, strength] = bands[c];
      if (c > 0 && strength < cfg.strengthMin * 1.25) break; // extra chord notes need to earn it
      const lane = pickLane(band, slot.tMs, taken);
      if (lane < 0) continue;
      taken.add(lane);
      lastLaneUse[lane] = slot.tMs;

      // long note: strong bass hit with a big gap before the next slot
      let len = 0;
      if (cfg.longNotes && band === 'bass' && strength > 2.2) {
        const next = kept[i + 1];
        const gap = next ? next.tMs - slot.tMs : Infinity;
        if (gap >= beatMs * 2) len = Math.round(beatMs);
      }
      notes.push({ t: slot.tMs, lane, len });
    }
  }

  notes.sort((a, b) => a.t - b.t || a.lane - b.lane);
  return {
    version: 1,
    title,
    bpm: analysis.bpm,
    offsetMs: Math.round(analysis.beatOffsetMs),
    keys,
    difficulty,
    audioHash,
    durationMs: Math.round(analysis.durationMs),
    notes,
  };
}
