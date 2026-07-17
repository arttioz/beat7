import type { Chart, Difficulty, KeyCount, Note } from './types';

/** Compact on-disk format: notes as [t, lane, len] tuples. */
interface ChartFile {
  version: 1;
  title: string;
  bpm: number;
  offsetMs: number;
  keys: KeyCount;
  difficulty: Difficulty;
  audioHash: string;
  durationMs: number;
  notes: [number, number, number][];
}

export function serializeChart(chart: Chart): string {
  const file: ChartFile = {
    ...chart,
    notes: chart.notes.map((n) => [Math.round(n.t), n.lane, Math.round(n.len)]),
  };
  return JSON.stringify(file);
}

/**
 * Parse + sanitize a chart from JSON text (file import or AI paste-back).
 * Accepts full chart objects or bare {notes:[...]} and clamps everything
 * so a malformed chart can never break gameplay.
 */
export function parseChart(text: string, base?: Partial<Chart>): Chart {
  const json = extractJson(text);
  const raw = JSON.parse(json) as Record<string, unknown>;
  const rawNotes = raw.notes;
  if (!Array.isArray(rawNotes)) throw new Error('chart has no "notes" array');

  const durationMs = numOr(raw.durationMs, base?.durationMs ?? 600000);
  const keys = keysOr(raw.keys, base?.keys ?? 7);
  const notes: Note[] = [];
  for (const item of rawNotes) {
    let t: number, lane: number, len: number;
    if (Array.isArray(item)) {
      [t, lane, len = 0] = item as number[];
    } else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      t = numOr(o.t, NaN); lane = numOr(o.lane, NaN); len = numOr(o.len, 0);
    } else continue;
    if (!Number.isFinite(t) || !Number.isFinite(lane)) continue;
    t = Math.round(t);
    lane = Math.max(0, Math.min(keys - 1, Math.round(lane)));
    len = Math.max(0, Math.round(Number.isFinite(len) ? len : 0));
    if (t < 0 || t > durationMs) continue;
    if (t + len > durationMs) len = Math.max(0, durationMs - t);
    if (len > 0 && len < 120) len = 0; // too short to hold
    notes.push({ t, lane, len });
  }
  notes.sort((a, b) => a.t - b.t || a.lane - b.lane);

  // drop overlapping notes in the same lane (min 100ms apart, LN tails block too)
  const laneFree = new Array(7).fill(-Infinity);
  const clean: Note[] = [];
  for (const n of notes) {
    if (n.t < laneFree[n.lane]) continue;
    laneFree[n.lane] = n.t + n.len + 100;
    clean.push(n);
  }
  if (clean.length === 0) throw new Error('chart contains no valid notes');

  return {
    version: 1,
    title: strOr(raw.title, base?.title ?? 'untitled'),
    bpm: numOr(raw.bpm, base?.bpm ?? 120),
    offsetMs: numOr(raw.offsetMs, base?.offsetMs ?? 0),
    keys,
    difficulty: diffOr(raw.difficulty, base?.difficulty ?? 'medium'),
    audioHash: strOr(raw.audioHash, base?.audioHash ?? ''),
    durationMs,
    notes: clean,
  };
}

/** Pull JSON out of text that may contain prose and ```code fences``` (AI replies). */
function extractJson(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

function numOr(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}
function strOr(v: unknown, d: string): string {
  return typeof v === 'string' && v.length > 0 ? v : d;
}
function diffOr(v: unknown, d: Difficulty): Difficulty {
  return v === 'easy' || v === 'medium' || v === 'hard' ? v : d;
}
function keysOr(v: unknown, d: KeyCount): KeyCount {
  return v === 4 || v === 5 || v === 7 ? v : d;
}

export function downloadChart(chart: Chart): void {
  const blob = new Blob([serializeChart(chart)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const safe = chart.title.replace(/[^\w\-]+/g, '_').slice(0, 40) || 'chart';
  a.download = `${safe}.${chart.keys}k.${chart.difficulty}.chart.json`;
  a.click();
  URL.revokeObjectURL(url);
}
