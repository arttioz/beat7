import { fft, hannWindow } from './fft';
import type { Analysis, Band, Onset, Section } from './types';

const FFT_SIZE = 2048;
const HOP = 512;

interface BandDef { name: Band; lo: number; hi: number; }
const BANDS: BandDef[] = [
  { name: 'bass', lo: 20, hi: 180 },
  { name: 'mid', lo: 180, hi: 2200 },
  { name: 'high', lo: 2200, hi: 9000 },
];

/**
 * Offline audio analysis: spectral-flux onset detection per frequency band,
 * BPM via autocorrelation of the onset envelope, beat phase alignment.
 */
export async function analyze(
  buffer: AudioBuffer,
  onProgress?: (p: number) => void,
): Promise<Analysis> {
  const sr = buffer.sampleRate;
  const mono = mixdown(buffer);
  const nFrames = Math.max(0, Math.floor((mono.length - FFT_SIZE) / HOP));
  const hopMs = (HOP / sr) * 1000;
  const win = hannWindow(FFT_SIZE);
  const nBins = FFT_SIZE / 2;
  const binHz = sr / FFT_SIZE;

  const bandBins = BANDS.map((b) => ({
    lo: Math.max(1, Math.floor(b.lo / binHz)),
    hi: Math.min(nBins - 1, Math.ceil(b.hi / binHz)),
  }));

  // per-band spectral flux + energy envelopes, total flux, loudness
  const flux: Float32Array[] = BANDS.map(() => new Float32Array(nFrames));
  const bandEnergy: Float32Array[] = BANDS.map(() => new Float32Array(nFrames));
  const totalFlux = new Float32Array(nFrames);
  const rms = new Float32Array(nFrames);

  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  let prevMag = new Float32Array(nBins);
  let curMag = new Float32Array(nBins);

  for (let f = 0; f < nFrames; f++) {
    const off = f * HOP;
    let sumSq = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const s = mono[off + i];
      re[i] = s * win[i];
      sumSq += s * s;
      im[i] = 0;
    }
    rms[f] = Math.sqrt(sumSq / FFT_SIZE);
    fft(re, im);
    for (let k = 0; k < nBins; k++) {
      curMag[k] = Math.hypot(re[k], im[k]);
    }
    for (let b = 0; b < BANDS.length; b++) {
      let fl = 0;
      let en = 0;
      for (let k = bandBins[b].lo; k <= bandBins[b].hi; k++) {
        const d = curMag[k] - prevMag[k];
        if (d > 0) fl += d;
        en += curMag[k];
      }
      flux[b][f] = fl;
      bandEnergy[b][f] = en;
      totalFlux[f] += fl;
    }
    const tmp = prevMag; prevMag = curMag; curMag = tmp;

    if (onProgress && f % 400 === 0) {
      onProgress(f / nFrames);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const onsets: Onset[] = [];
  for (let b = 0; b < BANDS.length; b++) {
    pickOnsets(flux[b], BANDS[b].name, hopMs, onsets);
  }
  onsets.sort((a, z) => a.tMs - z.tMs);

  // measure how long each sound keeps ringing (long vocals, held solo notes)
  const bandIdx: Record<Band, number> = { bass: 0, mid: 1, high: 2 };
  for (const o of onsets) {
    o.sustainMs = measureSustain(bandEnergy[bandIdx[o.band]], Math.round(o.tMs / hopMs), hopMs);
  }

  const { bpm, beatOffsetMs } = detectBpm(totalFlux, hopMs);
  const durationMs = (buffer.length / sr) * 1000;
  const sections = buildSections(rms, onsets, hopMs, durationMs, bpm, beatOffsetMs);

  onProgress?.(1);
  return { bpm, beatOffsetMs, durationMs, onsets, sections };
}

function mixdown(buffer: AudioBuffer): Float32Array {
  const out = new Float32Array(buffer.length);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) out[i] += data[i];
  }
  const scale = 1 / buffer.numberOfChannels;
  for (let i = 0; i < out.length; i++) out[i] *= scale;
  return out;
}

/** Local-maximum peak picking with an adaptive threshold. */
function pickOnsets(env: Float32Array, band: Band, hopMs: number, out: Onset[]): void {
  const n = env.length;
  if (n === 0) return;
  const NEAR = 3; // frames each side that must be <= peak
  const AVG = 25; // frames each side for the adaptive mean
  let globalMax = 0;
  for (let i = 0; i < n; i++) if (env[i] > globalMax) globalMax = env[i];
  if (globalMax <= 0) return;

  // prefix sums for fast local mean
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + env[i];

  const minGapFrames = Math.round(60 / hopMs); // 60ms per band
  let lastPick = -minGapFrames;

  for (let i = NEAR; i < n - NEAR; i++) {
    const v = env[i];
    if (v < 0.015 * globalMax) continue;
    let isPeak = true;
    for (let k = 1; k <= NEAR; k++) {
      if (env[i - k] > v || env[i + k] > v) { isPeak = false; break; }
    }
    if (!isPeak) continue;
    const lo = Math.max(0, i - AVG);
    const hi = Math.min(n, i + AVG + 1);
    const mean = (prefix[hi] - prefix[lo]) / (hi - lo);
    const strength = mean > 0 ? v / mean : 0;
    if (strength < 1.35) continue;
    if (i - lastPick < minGapFrames) continue;
    lastPick = i;
    out.push({ tMs: i * hopMs, band, strength, sustainMs: 0 });
  }
}

/**
 * From an onset frame, walk forward while the band's energy stays above a
 * fraction of its attack level — the length of the sustained sound.
 */
function measureSustain(env: Float32Array, startF: number, hopMs: number): number {
  const n = env.length;
  if (startF < 0 || startF >= n) return 0;
  let base = 0;
  const baseEnd = Math.min(n, startF + 4);
  for (let f = startF; f < baseEnd; f++) base = Math.max(base, env[f]);
  if (base <= 0) return 0;
  const thr = base * 0.4;
  const maxF = Math.min(n, startF + Math.ceil(5000 / hopMs)); // cap at 5s
  let f = startF + 1;
  let grace = 0;
  while (f < maxF) {
    if (env[f] >= thr) {
      grace = 0;
    } else {
      grace++;
      if (grace > 3) break; // allow tiny dips (vibrato) but stop on real decay
    }
    f++;
  }
  return Math.round((f - grace - startF) * hopMs);
}

function detectBpm(env: Float32Array, hopMs: number): { bpm: number; beatOffsetMs: number } {
  const n = env.length;
  const fallback = { bpm: 120, beatOffsetMs: 0 };
  if (n < 200) return fallback;

  // mean-removed envelope
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) e[i] = Math.max(0, env[i] - mean);

  const minLag = Math.max(2, Math.round(60000 / 220 / hopMs)); // 220 BPM
  const maxLag = Math.min(n - 1, Math.round(60000 / 55 / hopMs)); // 55 BPM
  let bestLag = 0;
  let bestScore = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let ac = 0;
    for (let i = 0; i + lag < n; i++) ac += e[i] * e[i + lag];
    ac /= n - lag;
    // mild preference for typical dance tempos (~90-180 BPM)
    const bpm = 60000 / (lag * hopMs);
    const pref = Math.exp(-Math.pow((bpm - 130) / 90, 2));
    const score = ac * (0.75 + 0.25 * pref);
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  if (bestLag === 0) return fallback;

  let bpm = 60000 / (bestLag * hopMs);
  while (bpm < 80) bpm *= 2;
  while (bpm > 190) bpm /= 2;
  bpm = Math.round(bpm * 10) / 10;

  // beat phase: shift the grid to maximize envelope energy on beats
  const periodFrames = 60000 / bpm / hopMs;
  let bestPhase = 0;
  let bestPhaseScore = -1;
  const steps = Math.floor(periodFrames);
  for (let p = 0; p < steps; p++) {
    let s = 0;
    for (let t = p; t < n; t += periodFrames) s += e[Math.round(t)] ?? 0;
    if (s > bestPhaseScore) { bestPhaseScore = s; bestPhase = p; }
  }
  return { bpm, beatOffsetMs: bestPhase * hopMs };
}

function buildSections(
  rms: Float32Array,
  onsets: Onset[],
  hopMs: number,
  durationMs: number,
  bpm: number,
  beatOffsetMs: number,
): Section[] {
  const sectionMs = (60000 / bpm) * 16; // 4 bars
  const sections: Section[] = [];
  let peakRms = 0;
  for (let i = 0; i < rms.length; i++) if (rms[i] > peakRms) peakRms = rms[i];
  if (peakRms <= 0) peakRms = 1;

  for (let start = beatOffsetMs; start < durationMs; start += sectionMs) {
    const end = Math.min(start + sectionMs, durationMs);
    const f0 = Math.max(0, Math.floor(start / hopMs));
    const f1 = Math.min(rms.length, Math.ceil(end / hopMs));
    let sum = 0;
    for (let i = f0; i < f1; i++) sum += rms[i];
    const energy = f1 > f0 ? sum / (f1 - f0) / peakRms : 0;
    const count = onsets.filter((o) => o.tMs >= start && o.tMs < end).length;
    sections.push({
      startMs: Math.round(start),
      endMs: Math.round(end),
      energy: Math.round(energy * 100) / 100,
      onsetDensity: Math.round((count / ((end - start) / 1000)) * 10) / 10,
    });
  }
  return sections;
}
