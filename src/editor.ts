import { Application, Container, Graphics, Text, TextStyle } from 'pixi.js';
import type { AudioEngine } from './audio';
import { KEY_SETS } from './game';
import type { Chart, Note } from './types';

/**
 * Chart editor:
 * - click empty space to add a tap note (drag up in the same motion → long note)
 * - drag a note to move it (time + lane, snapped to the beat grid)
 * - drag a note's tail handle to change its length; shrink to turn it back into a tap
 * - right-click a note (or select + Delete) to remove it
 * - record mode: while the song plays, lane keys add notes at the press time;
 *   hold a key to record a long note
 * - Enter = play/pause, Ctrl/Cmd+Z = undo, mouse wheel = scroll time, Esc = done
 */
export interface EditorOptions {
  onExit: (notes: Note[]) => void;
}

interface DragState {
  mode: 'move' | 'resize';
  note: Note;
  /** grab offset between pointer time and note time (move mode) */
  grabMs: number;
}

export class Editor {
  private app = new Application();
  private gridG = new Graphics();
  private notesG = new Graphics();
  private hudG = new Graphics();
  private chart!: Chart;
  private audio!: AudioEngine;
  private opts!: EditorOptions;
  private notes: Note[] = [];

  private lanes = 7;
  private codes: string[] = [];
  private colors: number[] = [];
  private laneW = 64;
  private fieldX = 0;
  private nowY = 0; // y of the "now" line
  private pxPerMs = 0.25;

  private curMs = 0;
  playing = false;
  private rate = 1;
  private snapDiv = 4; // grid = beat / snapDiv
  private record = false;
  private selected: Note | null = null;
  private drag: DragState | null = null;
  private undoStack: string[] = [];
  private holds = new Map<number, number>(); // lane -> press time (recording)
  private destroyed = false;
  private onChange: () => void = () => {};

  private keydown = (e: KeyboardEvent): void => this.onKey(e, true);
  private keyup = (e: KeyboardEvent): void => this.onKey(e, false);

  async open(host: HTMLElement, chart: Chart, audio: AudioEngine, opts: EditorOptions): Promise<void> {
    this.chart = chart;
    this.audio = audio;
    this.opts = opts;
    this.notes = chart.notes.map((n) => ({ ...n }));
    const ks = KEY_SETS[chart.keys] ?? KEY_SETS[7];
    this.lanes = ks.codes.length;
    this.codes = ks.codes;
    this.colors = ks.colors;
    this.laneW = ks.laneW;

    const width = Math.max(640, this.laneW * this.lanes + 160);
    const height = Math.max(520, window.innerHeight - 120);
    await this.app.init({
      width, height,
      background: 0x0c0e1a,
      antialias: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      autoDensity: true,
    });
    host.appendChild(this.app.canvas);

    this.fieldX = (width - this.laneW * this.lanes) / 2;
    this.nowY = height - 90;

    const stage = new Container();
    this.app.stage.addChild(stage);
    stage.addChild(this.gridG, this.notesG, this.hudG);

    // lane key labels under the now line
    const keyStyle = new TextStyle({ fill: 0x8a90c0, fontSize: 15, fontWeight: 'bold', fontFamily: 'monospace' });
    for (let i = 0; i < this.lanes; i++) {
      const label = new Text({ text: ks.labels[i], style: keyStyle });
      label.anchor.set(0.5);
      label.position.set(this.fieldX + (i + 0.5) * this.laneW, this.nowY + 24);
      this.app.stage.addChild(label);
    }

    window.addEventListener('keydown', this.keydown);
    window.addEventListener('keyup', this.keyup);
    const canvas = this.app.canvas;
    canvas.addEventListener('pointerdown', this.pointerdown);
    canvas.addEventListener('pointermove', this.pointermove);
    window.addEventListener('pointerup', this.pointerup);
    canvas.addEventListener('contextmenu', this.contextmenu);
    canvas.addEventListener('wheel', this.wheel, { passive: false });

    this.app.ticker.add(() => this.tick());
    this.onChange();
  }

  close(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.pause();
    window.removeEventListener('keydown', this.keydown);
    window.removeEventListener('keyup', this.keyup);
    window.removeEventListener('pointerup', this.pointerup);
    this.app.destroy(true, { children: true });
  }

  /** toolbar hooks ---------------------------------------------------------- */

  setOnChange(cb: () => void): void { this.onChange = cb; }
  get noteCount(): number { return this.notes.length; }
  get timeMs(): number { return this.curMs; }
  get durationMs(): number { return this.chart.durationMs; }
  get isRecording(): boolean { return this.record; }

  togglePlay(): void { this.playing ? this.pause() : this.play(); }

  play(): void {
    if (this.playing) return;
    if (this.curMs >= this.chart.durationMs - 50) this.curMs = 0;
    this.audio.play(0.15, this.curMs, this.rate);
    this.playing = true;
    this.drag = null;
    this.onChange();
  }

  pause(): void {
    if (this.playing) this.curMs = Math.max(0, Math.min(this.chart.durationMs, this.audio.timeMs));
    this.audio.stop();
    this.playing = false;
    this.holds.clear();
    this.onChange();
  }

  seek(ms: number): void {
    this.curMs = Math.max(0, Math.min(this.chart.durationMs, ms));
    if (this.playing) {
      this.audio.stop();
      this.audio.play(0.05, this.curMs, this.rate);
    }
  }

  setRate(rate: number): void {
    this.rate = rate;
    if (this.playing) { this.curMs = this.audio.timeMs; this.audio.stop(); this.audio.play(0.05, this.curMs, this.rate); }
  }

  setSnap(div: number): void { this.snapDiv = div; }
  setRecord(on: boolean): void { this.record = on; }
  zoom(factor: number): void { this.pxPerMs = Math.max(0.08, Math.min(1.2, this.pxPerMs * factor)); }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.notes = JSON.parse(prev) as Note[];
    this.selected = null;
    this.drag = null;
    this.onChange();
  }

  finish(): Note[] {
    this.notes.sort((a, b) => a.t - b.t || a.lane - b.lane);
    return this.notes;
  }

  /** internals -------------------------------------------------------------- */

  private pushUndo(): void {
    this.undoStack.push(JSON.stringify(this.notes));
    if (this.undoStack.length > 100) this.undoStack.shift();
  }

  private gridMs(): number { return 60000 / this.chart.bpm / this.snapDiv; }

  private snap(t: number): number {
    const g = this.gridMs();
    const s = this.chart.offsetMs + Math.round((t - this.chart.offsetMs) / g) * g;
    return Math.round(Math.max(0, Math.min(this.chart.durationMs, s)));
  }

  private yOf(t: number): number { return this.nowY - (t - this.curMs) * this.pxPerMs; }
  private timeAt(y: number): number { return this.curMs + (this.nowY - y) / this.pxPerMs; }
  private laneAt(x: number): number {
    return Math.max(0, Math.min(this.lanes - 1, Math.floor((x - this.fieldX) / this.laneW)));
  }

  private canvasPos(e: MouseEvent): { x: number; y: number } {
    const r = this.app.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** find a note under the pointer; prefer the tail handle of long notes */
  private hitTest(x: number, y: number): { note: Note; part: 'tail' | 'body' } | null {
    const lane = this.laneAt(x);
    let best: { note: Note; part: 'tail' | 'body' } | null = null;
    for (const n of this.notes) {
      if (n.lane !== lane) continue;
      if (n.len > 0 && Math.abs(this.yOf(n.t + n.len) - y) < 10) return { note: n, part: 'tail' };
      const headY = this.yOf(n.t);
      const within = n.len > 0
        ? y <= headY + 10 && y >= this.yOf(n.t + n.len) - 10
        : Math.abs(headY - y) < 12;
      if (within) best = { note: n, part: 'body' };
    }
    return best;
  }

  private pointerdown = (e: PointerEvent): void => {
    if (e.button !== 0 || this.playing) return;
    const { x, y } = this.canvasPos(e);
    if (x < this.fieldX || x > this.fieldX + this.lanes * this.laneW) return;
    const hit = this.hitTest(x, y);
    if (hit) {
      this.pushUndo();
      this.selected = hit.note;
      this.drag = hit.part === 'tail'
        ? { mode: 'resize', note: hit.note, grabMs: 0 }
        : { mode: 'move', note: hit.note, grabMs: this.timeAt(y) - hit.note.t };
    } else {
      // add a tap note; keep dragging upward to stretch it into a long note
      this.pushUndo();
      const note: Note = { t: this.snap(this.timeAt(y)), lane: this.laneAt(x), len: 0 };
      this.notes.push(note);
      this.selected = note;
      this.drag = { mode: 'resize', note, grabMs: 0 };
      this.onChange();
    }
  };

  private pointermove = (e: PointerEvent): void => {
    if (!this.drag) return;
    const { x, y } = this.canvasPos(e);
    const n = this.drag.note;
    if (this.drag.mode === 'move') {
      n.t = this.snap(this.timeAt(y) - this.drag.grabMs);
      n.lane = this.laneAt(x);
      if (n.t + n.len > this.chart.durationMs) n.t = this.chart.durationMs - n.len;
    } else {
      const len = this.snap(this.timeAt(y)) - n.t;
      n.len = len >= this.gridMs() * 0.75 ? Math.round(len) : 0;
      if (n.t + n.len > this.chart.durationMs) n.len = this.chart.durationMs - n.t;
    }
    this.onChange();
  };

  private pointerup = (): void => {
    if (this.drag) {
      this.notes.sort((a, b) => a.t - b.t || a.lane - b.lane);
      this.drag = null;
      this.onChange();
    }
  };

  private contextmenu = (e: MouseEvent): void => {
    e.preventDefault();
    if (this.playing) return;
    const { x, y } = this.canvasPos(e);
    const hit = this.hitTest(x, y);
    if (hit) {
      this.pushUndo();
      this.notes.splice(this.notes.indexOf(hit.note), 1);
      if (this.selected === hit.note) this.selected = null;
      this.onChange();
    }
  };

  private wheel = (e: WheelEvent): void => {
    e.preventDefault();
    if (this.playing) return;
    this.curMs = Math.max(0, Math.min(this.chart.durationMs, this.curMs - e.deltaY / this.pxPerMs));
    this.onChange();
  };

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (down && e.code === 'Escape') { this.opts.onExit(this.finish()); return; }
    if (down && e.code === 'Enter') { e.preventDefault(); this.togglePlay(); return; }
    if (down && (e.metaKey || e.ctrlKey) && e.code === 'KeyZ') { e.preventDefault(); this.undo(); return; }
    if (down && (e.code === 'Delete' || e.code === 'Backspace') && this.selected && !this.playing) {
      e.preventDefault();
      this.pushUndo();
      this.notes.splice(this.notes.indexOf(this.selected), 1);
      this.selected = null;
      this.onChange();
      return;
    }
    // record mode: lane keys add notes at the current song time
    const lane = this.codes.indexOf(e.code);
    if (lane < 0) return;
    e.preventDefault();
    if (!this.playing || !this.record) return;
    if (down) {
      if (e.repeat || this.holds.has(lane)) return;
      this.holds.set(lane, this.audio.timeMs);
    } else {
      const downMs = this.holds.get(lane);
      this.holds.delete(lane);
      if (downMs === undefined) return;
      const t = this.snap(downMs);
      let len = this.snap(this.audio.timeMs) - t;
      if (len < this.gridMs() * 1.5) len = 0; // short holds are taps
      // don't stack on an existing note in the same lane
      const clash = this.notes.some((n) => n.lane === lane && t < n.t + n.len + 100 && n.t < t + len + 100);
      if (clash) return;
      this.pushUndo();
      const note: Note = { t, lane, len };
      this.notes.push(note);
      this.notes.sort((a, b) => a.t - b.t || a.lane - b.lane);
      this.selected = note;
      this.onChange();
    }
  }

  private tick(): void {
    if (this.destroyed) return;
    if (this.playing) {
      this.curMs = this.audio.timeMs;
      if (this.curMs >= this.chart.durationMs) this.pause();
      this.onChange();
    }
    this.redraw();
  }

  private redraw(): void {
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    const fieldW = this.laneW * this.lanes;

    // grid
    const g = this.gridG;
    g.clear();
    g.rect(this.fieldX, 0, fieldW, h).fill(0x11142a);
    for (let i = 0; i <= this.lanes; i++) {
      g.rect(this.fieldX + i * this.laneW - 1, 0, 2, h).fill(0x232645);
    }
    const beatMs = 60000 / this.chart.bpm;
    const step = this.gridMs();
    const tMin = Math.max(0, this.timeAt(h + 20));
    const tMax = Math.min(this.chart.durationMs, this.timeAt(-20));
    let idx = Math.ceil((tMin - this.chart.offsetMs) / step);
    for (; ; idx++) {
      const t = this.chart.offsetMs + idx * step;
      if (t > tMax) break;
      const y = this.yOf(t);
      const beatIdx = (t - this.chart.offsetMs) / beatMs;
      const isMeasure = Math.abs(beatIdx / 4 - Math.round(beatIdx / 4)) < 1e-6;
      const isBeat = Math.abs(beatIdx - Math.round(beatIdx)) < 1e-6;
      g.rect(this.fieldX, y - 0.5, fieldW, isMeasure ? 2 : 1)
        .fill(isMeasure ? 0x3a3f6e : isBeat ? 0x2a2e55 : 0x1c2040);
    }
    // now line
    g.rect(this.fieldX - 30, this.nowY - 2, fieldW + 60, 4).fill(0xff4d88);

    // notes
    const ng = this.notesG;
    ng.clear();
    for (const n of this.notes) {
      if (n.t + n.len < tMin - 200 || n.t > tMax + 200) continue;
      const x = this.fieldX + n.lane * this.laneW + 3;
      const nw = this.laneW - 6;
      const headY = this.yOf(n.t);
      const color = this.colors[n.lane];
      const sel = n === this.selected;
      if (n.len > 0) {
        const tailY = this.yOf(n.t + n.len);
        ng.roundRect(x + 8, tailY, nw - 16, headY - tailY, 6).fill({ color, alpha: 0.45 });
        ng.roundRect(x, tailY - 7, nw, 14, 5).fill({ color, alpha: 0.9 });
        // tail drag handle
        ng.circle(x + nw / 2, tailY, 5).fill(sel ? 0xffffff : 0xb9befb);
      }
      ng.roundRect(x, headY - 9, nw, 18, 5).fill(color);
      if (sel) ng.roundRect(x - 1, headY - 10, nw + 2, 20, 6).stroke({ color: 0xffffff, width: 2 });
    }

    // recording holds preview
    const hud = this.hudG;
    hud.clear();
    for (const [lane, downMs] of this.holds) {
      const x = this.fieldX + lane * this.laneW + 3;
      const y0 = this.yOf(downMs);
      hud.roundRect(x, Math.min(y0, this.nowY) - 9, this.laneW - 6, Math.abs(y0 - this.nowY) + 18, 5)
        .fill({ color: 0xff4d88, alpha: 0.5 });
    }
    if (this.record && this.playing) {
      hud.circle(w - 26, 24, 8).fill(0xff3b30);
    }
  }
}
