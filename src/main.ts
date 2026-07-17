import { analyze } from './analysis';
import { Calibrator } from './calibrate';
import { AudioEngine, sha256Hex } from './audio';
import { downloadChart, parseChart } from './chart';
import { renderDemoSong } from './demo';
import { Editor } from './editor';
import { Game } from './game';
import { LANGS, applyTranslations, getLang, setLang, t } from './i18n';
import { getKeyCodes, isTouchDevice, labelFor, resetKeyCodes, setKeyCode } from './keys';
import { generateChart } from './generator';
import type { Analysis, Chart, Difficulty, KeyCount, PlayMode, PlayStats } from './types';

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

const audio = new AudioEngine();
let analysis: Analysis | null = null;
let chart: Chart | null = null;
let songTitle = '';
let audioHash = '';
let difficulty: Difficulty = 'medium';
let keyCount: KeyCount = 7;
let playMode: PlayMode = 'audition';
let game: Game | null = null;

function keysHintText(): string {
  const keyList = getKeyCodes(keyCount).map(labelFor).join(' ');
  return isTouchDevice() ? `${t('touchHint')} · ${keyList}` : keyList;
}

// language picker: populate, restore saved/auto-detected choice, retranslate on change
const langSel = $('#langSel') as HTMLSelectElement;
for (const { code, name } of LANGS) {
  const opt = document.createElement('option');
  opt.value = code;
  opt.textContent = name;
  langSel.appendChild(opt);
}
langSel.value = getLang();
langSel.addEventListener('change', () => {
  setLang(langSel.value as Parameters<typeof setLang>[0]);
  applyTranslations();
});
applyTranslations();

const statusEl = $('#status');
const infoEl = $('#songInfo');
const bar = $('#progressBar');
const barFill = bar.querySelector('div') as HTMLDivElement;

function setStatus(msg: string, isError = false): void {
  statusEl.textContent = msg;
  statusEl.style.color = isError ? '#ff5b6e' : '#7dffce';
}

function refreshButtons(): void {
  const hasAudio = !!audio.buffer;
  const hasChart = !!chart;
  ($('#btnPlay') as HTMLButtonElement).disabled = !(hasAudio && hasChart);
  ($('#btnRegen') as HTMLButtonElement).disabled = !analysis;
  ($('#btnExport') as HTMLButtonElement).disabled = !hasChart;
  ($('#btnNew') as HTMLButtonElement).disabled = !hasAudio;
  ($('#btnEdit') as HTMLButtonElement).disabled = !(hasAudio && hasChart);
}

function showInfo(): void {
  if (!chart) { infoEl.innerHTML = ''; return; }
  const dur = chart.durationMs / 1000;
  const mm = Math.floor(dur / 60);
  const ss = String(Math.floor(dur % 60)).padStart(2, '0');
  infoEl.innerHTML =
    `<b>${escapeHtml(chart.title)}</b> · ${mm}:${ss} · <b>${chart.bpm}</b> BPM · ` +
    `<b>${chart.notes.length}</b> notes (${chart.keys}K ${chart.difficulty})`;
}

function syncModeUi(): void {
  $('#keysHint').textContent = keysHintText();
  document.querySelectorAll('#keySeg button').forEach((b) =>
    b.classList.toggle('on', Number((b as HTMLElement).dataset.k) === keyCount));
  document.querySelectorAll('#diffSeg button').forEach((b) =>
    b.classList.toggle('on', (b as HTMLElement).dataset.d === difficulty));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

async function loadSong(name: string, buffer: AudioBuffer, hash: string): Promise<void> {
  songTitle = name;
  audioHash = hash;
  audio.setBuffer(buffer);
  chart = null;
  bar.style.display = 'block';
  setStatus(t('stAnalyzing'));
  try {
    analysis = loadCachedAnalysis(hash);
    if (!analysis) {
      analysis = await analyze(buffer, (p) => { barFill.style.width = `${Math.round(p * 100)}%`; });
      saveCachedAnalysis(hash, analysis);
    }
    regenerate();
    setStatus(t('stReady', { bpm: analysis.bpm }));
  } catch (err) {
    setStatus(`Analysis failed: ${(err as Error).message}`, true);
  } finally {
    bar.style.display = 'none';
    barFill.style.width = '0%';
    refreshButtons();
  }
}

// analysis is deterministic per file, so cache it by audio hash
// (v2: includes per-onset sustain data for long-note generation)
function loadCachedAnalysis(hash: string): Analysis | null {
  try {
    const raw = localStorage.getItem(`beat7-analysis2-${hash}`);
    if (!raw) return null;
    const a = JSON.parse(raw) as Analysis;
    return Array.isArray(a.onsets) && typeof a.bpm === 'number' ? a : null;
  } catch { return null; }
}

function saveCachedAnalysis(hash: string, a: Analysis): void {
  try {
    localStorage.removeItem(`beat7-analysis-${hash}`); // drop v1 cache
    localStorage.setItem(`beat7-analysis2-${hash}`, JSON.stringify(a));
  } catch { /* storage full — analysis will simply rerun next time */ }
}

function regenerate(): void {
  if (!analysis) return;
  chart = generateChart(analysis, difficulty, songTitle, audioHash, keyCount);
  showInfo();
  refreshButtons();
}

// --- song loading ---------------------------------------------------------

$('#btnFile').addEventListener('click', () => $('#fileInput').click());
($('#fileInput') as HTMLInputElement).addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  setStatus(t('stDecoding'));
  try {
    const bytes = await file.arrayBuffer();
    const hash = await sha256Hex(bytes);
    const buffer = await audio.decode(bytes.slice(0));
    await loadSong(file.name.replace(/\.[^.]+$/, ''), buffer, hash);
  } catch (err) {
    setStatus(`Could not load file: ${(err as Error).message}`, true);
  }
});

$('#btnDemo').addEventListener('click', async () => {
  setStatus('Synthesizing demo song…');
  try {
    const buffer = await renderDemoSong();
    await loadSong('Demo Track (120 BPM)', buffer, 'demo');
  } catch (err) {
    setStatus(`Demo failed: ${(err as Error).message}`, true);
  }
});

// --- key mode / difficulty / regenerate -------------------------------------

$('#keySeg').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button[data-k]') as HTMLButtonElement | null;
  if (!btn) return;
  keyCount = Number(btn.dataset.k) as KeyCount;
  syncModeUi();
  saveSettings();
  if (analysis) {
    regenerate();
    setStatus(t('stGenerated', { mode: `${keyCount}K ${difficulty}` }));
  }
});

$('#diffSeg').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button[data-d]') as HTMLButtonElement | null;
  if (!btn) return;
  difficulty = btn.dataset.d as Difficulty;
  syncModeUi();
  if (analysis) {
    regenerate();
    setStatus(t('stGenerated', { mode: `${keyCount}K ${difficulty}` }));
  }
});

$('#btnRegen').addEventListener('click', () => {
  regenerate();
  setStatus(t('stGenerated', { mode: `${keyCount}K ${difficulty}` }));
});

// --- export / import -------------------------------------------------------

$('#btnExport').addEventListener('click', () => {
  if (chart) downloadChart(chart);
});

$('#btnImport').addEventListener('click', () => $('#chartInput').click());
($('#chartInput') as HTMLInputElement).addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const imported = parseChart(text);
    chart = imported;
    difficulty = imported.difficulty;
    keyCount = imported.keys;
    syncModeUi();
    showInfo();
    refreshButtons();
    if (audio.buffer && imported.audioHash && audioHash && imported.audioHash !== audioHash) {
      setStatus('Chart loaded, but it was made for a DIFFERENT audio file — notes may not line up.', true);
    } else if (!audio.buffer) {
      setStatus('Chart loaded. Now upload the matching MP3 to play.');
    } else {
      setStatus(t('stImported'));
    }
  } catch (err) {
    setStatus(`Import failed: ${(err as Error).message}`, true);
  }
});

// --- settings ---------------------------------------------------------------

const speedEl = $('#speed') as HTMLInputElement;
const offsetEl = $('#offset') as HTMLInputElement;

const SETTINGS_KEY = 'beat7-settings';
function saveSettings(): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({
    speed: parseFloat(speedEl.value),
    offsetMs: parseInt(offsetEl.value, 10),
    keys: keyCount,
    mode: playMode,
  }));
}
try {
  const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
  if (typeof s.speed === 'number') speedEl.value = String(s.speed);
  if (typeof s.offsetMs === 'number') offsetEl.value = String(s.offsetMs);
  if (s.keys === 4 || s.keys === 5 || s.keys === 7) keyCount = s.keys;
  if (s.mode === 'chill' || s.mode === 'audition') playMode = s.mode;
} catch { /* corrupt settings: use defaults */ }
syncPlayModeUi();
syncModeUi();

function syncPlayModeUi(): void {
  document.querySelectorAll('#modeSeg button').forEach((b) =>
    b.classList.toggle('on', (b as HTMLElement).dataset.m === playMode));
}

$('#modeSeg').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button[data-m]') as HTMLButtonElement | null;
  if (!btn) return;
  playMode = btn.dataset.m as PlayMode;
  syncPlayModeUi();
  saveSettings();
});

function syncLabels(): void {
  $('#speedVal').textContent = `${speedEl.value}x`;
  $('#offsetVal').textContent = `${offsetEl.value} ms`;
}
speedEl.addEventListener('input', () => { syncLabels(); saveSettings(); });
offsetEl.addEventListener('input', () => { syncLabels(); saveSettings(); });
syncLabels();

// --- editor ---------------------------------------------------------------------

let editor: Editor | null = null;

function fmtTime(ms: number): string {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const f = Math.floor(ms % 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(f).padStart(3, '0')}`;
}

async function openEditor(): Promise<void> {
  if (!chart || !audio.buffer) return;
  $('#menu').classList.add('off');
  $('#editor').classList.add('on');
  const host = $('#edCanvas');
  host.innerHTML = '';
  editor = new Editor();
  (window as unknown as { __editor: Editor | null }).__editor = editor;
  const ed = editor;
  const seekEl = $('#edSeek') as HTMLInputElement;
  seekEl.max = String(chart.durationMs);
  let seeking = false;
  ed.setOnChange(() => {
    if (!seeking) seekEl.value = String(Math.round(ed.timeMs));
    $('#edTime').textContent = fmtTime(ed.timeMs);
    $('#edCount').textContent = `${ed.noteCount} ♪`;
    $('#edPlayBtn').textContent = ed.playing ? t('edPause') : t('edPlay');
  });
  await ed.open(host, chart, audio, {
    onExit: (notes) => closeEditor(notes),
  });
  ed.setRate(parseFloat(($('#edRate') as HTMLSelectElement).value));
  ed.setSnap(parseInt(($('#edSnap') as HTMLSelectElement).value, 10));
  ed.setRecord(($('#edRecord') as HTMLInputElement).checked);
  seekEl.addEventListener('pointerdown', () => { seeking = true; });
  seekEl.addEventListener('pointerup', () => { seeking = false; });
}

function closeEditor(notes: Chart['notes']): void {
  if (!editor) return;
  editor.close();
  editor = null;
  if (chart) {
    chart.notes = notes;
    showInfo();
  }
  $('#editor').classList.remove('on');
  $('#menu').classList.remove('off');
  setStatus(t('stEdited', { n: notes.length }));
}

$('#btnNew').addEventListener('click', () => {
  if (!audio.buffer) return;
  chart = {
    version: 1,
    title: songTitle || 'untitled',
    bpm: analysis?.bpm ?? chart?.bpm ?? 120,
    offsetMs: Math.round(analysis?.beatOffsetMs ?? chart?.offsetMs ?? 0),
    keys: keyCount,
    difficulty,
    audioHash,
    durationMs: Math.round(audio.durationMs),
    notes: [],
  };
  showInfo();
  refreshButtons();
  setStatus(t('stNewChart'));
  void openEditor();
});

$('#btnEdit').addEventListener('click', () => void openEditor());
$('#edBack').addEventListener('click', () => { if (editor) closeEditor(editor.finish()); });
$('#edPlayBtn').addEventListener('click', () => editor?.togglePlay());
$('#edRate').addEventListener('change', (e) => editor?.setRate(parseFloat((e.target as HTMLSelectElement).value)));
$('#edSnap').addEventListener('change', (e) => editor?.setSnap(parseInt((e.target as HTMLSelectElement).value, 10)));
$('#edRecord').addEventListener('change', (e) => editor?.setRecord((e.target as HTMLInputElement).checked));
$('#edZoomIn').addEventListener('click', () => editor?.zoom(1.3));
$('#edZoomOut').addEventListener('click', () => editor?.zoom(1 / 1.3));
$('#edUndo').addEventListener('click', () => editor?.undo());
$('#edSeek').addEventListener('input', (e) => editor?.seek(parseInt((e.target as HTMLInputElement).value, 10)));
$('#edSave').addEventListener('click', () => {
  if (!editor || !chart) return;
  downloadChart({ ...chart, notes: editor.finish() });
});

// --- key setup ------------------------------------------------------------------

const keysDlg = $('#keysDlg') as HTMLDialogElement;
let captureLane = -1;

function renderKeyButtons(): void {
  const row = $('#keysRow');
  row.innerHTML = '';
  getKeyCodes(keyCount).forEach((code, lane) => {
    const b = document.createElement('button');
    b.className = 'keybtn' + (captureLane === lane ? ' capture' : '');
    b.textContent = captureLane === lane ? '…' : labelFor(code);
    b.title = captureLane === lane ? t('keysPress') : code;
    b.addEventListener('click', () => {
      captureLane = lane;
      renderKeyButtons();
    });
    row.appendChild(b);
  });
}

$('#btnKeys').addEventListener('click', () => {
  captureLane = -1;
  renderKeyButtons();
  keysDlg.showModal();
});

// capture phase: swallow the pressed key before anything else reacts to it
window.addEventListener('keydown', (e) => {
  if (!keysDlg.open || captureLane < 0) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.code !== 'Escape') setKeyCode(keyCount, captureLane, e.code);
  captureLane = -1;
  renderKeyButtons();
  syncModeUi();
}, true);

$('#btnKeysReset').addEventListener('click', () => {
  resetKeyCodes(keyCount);
  captureLane = -1;
  renderKeyButtons();
  syncModeUi();
});
$('#btnKeysClose').addEventListener('click', () => keysDlg.close());

// --- calibration --------------------------------------------------------------

const calDlg = $('#calDlg') as HTMLDialogElement;
const calStatus = $('#calStatus');
let calibrator: Calibrator | null = null;

$('#btnCalibrate').addEventListener('click', () => {
  calStatus.textContent = t('calGetReady');
  calDlg.showModal();
  calibrator = new Calibrator();
  calibrator.onProgress = (n, needed, lastMs) => {
    calStatus.textContent = `${n} / ${needed} taps  (${lastMs >= 0 ? '+' : ''}${lastMs}ms)`;
  };
  calibrator.onFinish = (result) => {
    calibrator = null;
    calDlg.close();
    if (Number.isNaN(result.offsetMs)) {
      setStatus('Calibration cancelled — not enough taps. Try again.', true);
      return;
    }
    offsetEl.value = String(result.offsetMs);
    syncLabels();
    saveSettings();
    setStatus(t('stCalibrated', { ms: result.offsetMs, taps: result.taps }));
  };
  calibrator.start();
});

$('#btnCalCancel').addEventListener('click', () => {
  calibrator?.cancel();
  calibrator = null;
  calDlg.close();
});

// --- play / results -----------------------------------------------------------

const resultsDlg = $('#resultsDlg') as HTMLDialogElement;

function showResults(stats: PlayStats): void {
  $('#game').classList.remove('on');
  $('#menu').classList.remove('off');
  const gradeEl = $('#grade');
  const titleEl = $('#resultTitle');
  if (stats.droppedOut) {
    titleEl.textContent = t('droppedOut');
    gradeEl.textContent = 'OUT';
    gradeEl.style.color = '#ff5b6e';
  } else if (stats.goldenTime) {
    titleEl.textContent = t('goldenBuzzer');
    gradeEl.textContent = stats.grade;
    gradeEl.style.color = '#ffd700';
  } else {
    titleEl.textContent = t('result');
    gradeEl.textContent = stats.grade;
    gradeEl.style.color = '';
  }
  $('#rScore').textContent = String(stats.score).padStart(7, '0');
  $('#rAcc').textContent = `${stats.accuracy}%`;
  $('#rCool').textContent = String(stats.cool);
  $('#rGood').textContent = String(stats.good);
  $('#rBad').textContent = String(stats.bad);
  $('#rMiss').textContent = String(stats.miss);
  $('#rCombo').textContent = String(stats.maxCombo);
  resultsDlg.showModal();
}

async function startGame(): Promise<void> {
  if (!chart || !audio.buffer) return;
  resultsDlg.close();
  $('#menu').classList.add('off');
  $('#game').classList.add('on');
  const host = $('#gameCanvas');
  host.innerHTML = '';
  game = new Game();
  (window as unknown as { __game: Game | null }).__game = game;
  await game.start(host, chart, audio, {
    speed: parseFloat(speedEl.value),
    offsetMs: parseInt(offsetEl.value, 10),
    autoplay: ($('#autoplay') as HTMLInputElement).checked,
    mode: playMode,
    onFinish: (stats) => { game = null; showResults(stats); },
    onQuit: () => {
      game = null;
      $('#game').classList.remove('on');
      $('#menu').classList.remove('off');
    },
    onSpeedChange: (s) => {
      speedEl.value = String(s);
      syncLabels();
      saveSettings();
    },
  });
}

$('#btnPlay').addEventListener('click', () => void startGame());
$('#btnStop').addEventListener('click', () => game?.quit());
$('#btnRetry').addEventListener('click', () => { resultsDlg.close(); void startGame(); });
$('#btnBack').addEventListener('click', () => resultsDlg.close());

async function loadFromUrl(url: string, name: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  const bytes = await res.arrayBuffer();
  const hash = await sha256Hex(bytes);
  const buffer = await audio.decode(bytes.slice(0));
  await loadSong(name, buffer, hash);
}

// dev helper: load a song from a URL (used for automated testing)
(window as unknown as { __loadFromUrl?: typeof loadFromUrl }).__loadFromUrl = loadFromUrl;

// auto-load the bundled default song + hand-tuned default chart on startup
// (relative URLs so the build works when deployed under a subpath)
void (async () => {
  try {
    setStatus(t('stLoadingDefault'));
    await loadFromUrl('default-song.mp3', 'Nene Royal — Zombie (AGT)');
  } catch {
    setStatus('');
    return;
  }
  try {
    const res = await fetch('default-chart.json');
    if (!res.ok) return;
    const parsed = parseChart(await res.text(), chart ?? undefined);
    chart = parsed;
    difficulty = parsed.difficulty;
    keyCount = parsed.keys;
    syncModeUi();
    showInfo();
    refreshButtons();
    setStatus(t('stDefaultLoaded', { n: parsed.notes.length }));
  } catch { /* fall back to the auto-generated chart */ }
})();

refreshButtons();
