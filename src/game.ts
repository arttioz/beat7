import { Application, Container, Graphics, Rectangle, Sprite, Text, TextStyle, Texture } from 'pixi.js';
import type { AudioEngine } from './audio';
import type { Chart, Judgment, Note, PlayMode, PlayStats } from './types';

const GOLD = 0xffd700;
/** audition power gauge: fills on hits, drains on misses; empty = dropped out */
const POWER_START = 70;
const POWER_GAIN: Record<Judgment, number> = { cool: 0.7, good: 0.35, bad: -1.5, miss: -4 };

function hslToHex(h: number, s: number, l: number): number {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
}

// key bindings, labels and O2Jam-style lane colours per key mode
export const KEY_SETS: Record<number, { codes: string[]; labels: string[]; colors: number[]; laneW: number }> = {
  4: {
    codes: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'],
    labels: ['D', 'F', 'J', 'K'],
    colors: [0xe8e8f0, 0x5b8dff, 0x5b8dff, 0xe8e8f0],
    laneW: 88,
  },
  5: {
    codes: ['KeyD', 'KeyF', 'Space', 'KeyJ', 'KeyK'],
    labels: ['D', 'F', '␣', 'J', 'K'],
    colors: [0xe8e8f0, 0x5b8dff, 0xffcf4d, 0x5b8dff, 0xe8e8f0],
    laneW: 78,
  },
  7: {
    codes: ['KeyS', 'KeyD', 'KeyF', 'Space', 'KeyJ', 'KeyK', 'KeyL'],
    labels: ['S', 'D', 'F', '␣', 'J', 'K', 'L'],
    colors: [0xe8e8f0, 0x5b8dff, 0xe8e8f0, 0xffcf4d, 0xe8e8f0, 0x5b8dff, 0xe8e8f0],
    laneW: 64,
  },
};

const COOL_MS = 50;
const GOOD_MS = 100;
const BAD_MS = 150;

const JUDGE_STYLE: Record<Judgment, { text: string; color: number }> = {
  cool: { text: 'COOL', color: 0x7dffce },
  good: { text: 'GOOD', color: 0x5b8dff },
  bad: { text: 'BAD', color: 0xffa94d },
  miss: { text: 'MISS', color: 0xff5b6e },
};

interface Particle {
  kind: 'spark' | 'ring' | 'rocket';
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  color: number; size: number;
}

interface Shard {
  sprite: Sprite;
  vx: number; vy: number;
  vr: number;
  delay: number;
}

interface RtNote extends Note {
  headJudged: boolean;
  tailJudged: boolean; // taps: mirrors headJudged
  holding: boolean;
  brokenHold: boolean;
  /** judged as miss — keep the sprite falling (faded) instead of vanishing */
  missed: boolean;
  body: Graphics | null;
}

export interface GameOptions {
  speed: number; // 0.5..6
  offsetMs: number; // user calibration
  autoplay: boolean;
  /** chill = no fail; audition = 4 ❌ drop out + golden buzzer */
  mode: PlayMode;
  onFinish: (stats: PlayStats) => void;
  onQuit: () => void;
  /** called when the player changes speed in-game (↑/↓) so it can be persisted */
  onSpeedChange?: (speed: number) => void;
}

export class Game {
  private app = new Application();
  private notesLayer = new Container();
  private fxLayer = new Container();
  private fxG = new Graphics();
  private beatPulseG = new Graphics();
  private particles: Particle[] = [];
  private holdSparkTimer = 0;
  private notes: RtNote[] = [];
  private chart!: Chart;
  private audio!: AudioEngine;
  private opts!: GameOptions;

  private lanes = 7;
  private codes: string[] = [];
  private labels: string[] = [];
  private colors: number[] = [];
  private laneX: number[] = [];
  private laneW = 64;
  private hitY = 0;
  private pxPerMs = 1;
  private held: boolean[] = [];

  /** when the run actually ends — never earlier than the last note */
  private songEndMs = 0;
  private counts = { cool: 0, good: 0, bad: 0, miss: 0 };
  private combo = 0;
  private maxCombo = 0;
  /** raw judgment points, for accuracy/grade */
  private earned = 0;
  /** score points — doubled during golden time */
  private scorePoints = 0;
  private totalJudgments = 0;

  // audition mode
  private power = POWER_START;
  private powerG = new Graphics();
  private golden = false;
  private goldenAge = 0;
  private goldenComboTarget = 60;
  private pendingDropOut = false;
  private goldenBgG = new Graphics();
  private goldenBanner!: Text;
  private goldSparkTimer = 0;

  // ending sequence (smooth transition into results)
  private ending: 'none' | 'clear' | 'break' = 'none';
  private endingAge = 0;
  private endStats: PlayStats | null = null;
  private endingText!: Text;
  private rocketTimer = 0;
  private shards: Shard[] = [];
  private shatterTex: Texture | null = null;

  private judgeText!: Text;
  private timingText!: Text;
  private comboText!: Text;
  private scoreText!: Text;
  private speedText!: Text;
  private judgeAge = 1e9;
  private speedAge = 1e9;
  private laneFlash: Graphics[] = [];
  private keyGlow: Graphics[] = [];
  private progress!: Graphics;
  private finished = false;
  private destroyed = false;

  private keydown = (e: KeyboardEvent) => this.onKey(e, true);
  private keyup = (e: KeyboardEvent) => this.onKey(e, false);

  async start(host: HTMLElement, chart: Chart, audio: AudioEngine, opts: GameOptions): Promise<void> {
    this.chart = chart;
    this.audio = audio;
    this.opts = opts;
    const ks = KEY_SETS[chart.keys] ?? KEY_SETS[7];
    this.lanes = ks.codes.length;
    this.codes = ks.codes;
    this.labels = ks.labels;
    this.colors = ks.colors;
    this.held = new Array(this.lanes).fill(false);
    this.totalJudgments = chart.notes.reduce((s, n) => s + (n.len > 0 ? 2 : 1), 0);
    this.goldenComboTarget = Math.min(60, Math.max(10, Math.round(this.totalJudgments * 0.3)));
    // guard against a bad/mutated durationMs: the song can never end before the last note
    const lastNoteEnd = chart.notes.reduce((m, n) => Math.max(m, n.t + n.len), 0);
    this.songEndMs = Math.max(chart.durationMs, lastNoteEnd + 500);

    // fill the whole viewport height
    const width = 560;
    const height = Math.max(480, window.innerHeight);
    await this.app.init({
      width, height,
      background: 0x0c0e1a,
      antialias: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      autoDensity: true,
    });
    host.appendChild(this.app.canvas);

    this.laneW = ks.laneW;
    const fieldW = this.laneW * this.lanes;
    const fieldX = (width - fieldW) / 2;
    this.hitY = height - 110;
    this.pxPerMs = 0.45 * opts.speed;
    this.laneX = Array.from({ length: this.lanes }, (_, i) => fieldX + i * this.laneW);

    this.buildStage(width, height, fieldX, fieldW);

    this.notes = chart.notes.map((n) => ({
      ...n, headJudged: false, tailJudged: false,
      holding: false, brokenHold: false, missed: false, body: null,
    }));

    window.addEventListener('keydown', this.keydown);
    window.addEventListener('keyup', this.keyup);
    this.audio.play(2);
    this.app.ticker.add(() => this.update());
  }

  /** Stop the run and return to the menu (Stop button / ESC). */
  quit(): void {
    this.destroy();
    this.opts.onQuit();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    window.removeEventListener('keydown', this.keydown);
    window.removeEventListener('keyup', this.keyup);
    this.audio.stop();
    this.shatterTex?.destroy(true);
    this.shatterTex = null;
    this.app.destroy(true, { children: true });
  }

  private buildStage(width: number, height: number, fieldX: number, fieldW: number): void {
    const bg = new Graphics();
    // full-canvas backing so the shatter capture covers the whole screen
    bg.rect(0, 0, width, height).fill(0x0c0e1a);
    bg.rect(fieldX, 0, fieldW, height).fill(0x11142a);
    for (let i = 0; i <= this.lanes; i++) {
      bg.rect(fieldX + i * this.laneW - 1, 0, 2, height).fill(0x232645);
    }
    bg.rect(fieldX, this.hitY - 3, fieldW, 6).fill(0xff4d88);
    this.app.stage.addChild(bg);
    this.app.stage.addChild(this.goldenBgG);

    for (let i = 0; i < this.lanes; i++) {
      const flash = new Graphics();
      flash.rect(this.laneX[i], 0, this.laneW, this.hitY).fill(this.colors[i]);
      flash.alpha = 0;
      this.app.stage.addChild(flash);
      this.laneFlash.push(flash);
    }

    this.app.stage.addChild(this.beatPulseG);
    this.app.stage.addChild(this.notesLayer, this.fxLayer);
    this.fxLayer.addChild(this.fxG);

    // key area
    const keyStyle = new TextStyle({ fill: 0x8a90c0, fontSize: 18, fontWeight: 'bold', fontFamily: 'monospace' });
    for (let i = 0; i < this.lanes; i++) {
      const glow = new Graphics();
      glow.roundRect(this.laneX[i] + 4, this.hitY + 10, this.laneW - 8, 54, 8).fill(0x1a1e3a);
      this.app.stage.addChild(glow);
      this.keyGlow.push(glow);
      const label = new Text({ text: this.labels[i], style: keyStyle });
      label.anchor.set(0.5);
      label.position.set(this.laneX[i] + this.laneW / 2, this.hitY + 37);
      this.app.stage.addChild(label);
    }

    this.judgeText = new Text({
      text: '', style: new TextStyle({ fill: 0xffffff, fontSize: 40, fontWeight: 'bold', fontFamily: 'monospace' }),
    });
    this.judgeText.anchor.set(0.5);
    this.judgeText.position.set(width / 2, this.hitY - 180);
    this.app.stage.addChild(this.judgeText);

    this.timingText = new Text({
      text: '', style: new TextStyle({ fill: 0x8a90c0, fontSize: 16, fontWeight: 'bold', fontFamily: 'monospace' }),
    });
    this.timingText.anchor.set(0.5);
    this.timingText.position.set(width / 2, this.hitY - 148);
    this.app.stage.addChild(this.timingText);

    this.comboText = new Text({
      text: '', style: new TextStyle({ fill: 0xffe066, fontSize: 54, fontWeight: 'bold', fontFamily: 'monospace' }),
    });
    this.comboText.anchor.set(0.5);
    this.comboText.position.set(width / 2, this.hitY - 250);
    this.app.stage.addChild(this.comboText);

    this.scoreText = new Text({
      text: '0', style: new TextStyle({ fill: 0xc0c4ee, fontSize: 20, fontFamily: 'monospace' }),
    });
    this.scoreText.position.set(width - 130, 14);
    this.app.stage.addChild(this.scoreText);

    this.speedText = new Text({
      text: `${this.opts.speed}x`,
      style: new TextStyle({ fill: 0x8a90c0, fontSize: 16, fontFamily: 'monospace' }),
    });
    this.speedText.position.set(14, 14);
    this.app.stage.addChild(this.speedText);

    // audition mode: side power gauge (O2Jam style)
    if (this.opts.mode === 'audition') {
      this.app.stage.addChild(this.powerG);
      this.drawPowerBar();
    }
    this.goldenBanner = new Text({
      text: '✨ GOLDEN TIME ✨',
      style: new TextStyle({ fill: GOLD, fontSize: 36, fontWeight: 'bold', fontFamily: 'monospace' }),
    });
    this.goldenBanner.anchor.set(0.5);
    this.goldenBanner.position.set(width / 2, this.hitY - 320);
    this.goldenBanner.visible = false;
    this.app.stage.addChild(this.goldenBanner);

    this.endingText = new Text({
      text: 'CLEAR!',
      style: new TextStyle({
        fill: 0xffe066, fontSize: 72, fontWeight: 'bold', fontFamily: 'monospace',
        stroke: { color: 0x0c0e1a, width: 8 },
      }),
    });
    this.endingText.anchor.set(0.5);
    this.endingText.position.set(width / 2, height * 0.4);
    this.endingText.visible = false;
    this.app.stage.addChild(this.endingText);

    this.progress = new Graphics();
    this.app.stage.addChild(this.progress);
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (down && e.code === 'Escape') {
      this.quit();
      return;
    }
    if (down && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) {
      e.preventDefault();
      this.setSpeed(this.opts.speed + (e.code === 'ArrowUp' ? 0.25 : -0.25));
      return;
    }
    if (this.ending !== 'none') return; // outro playing: only ESC works
    const lane = this.codes.indexOf(e.code);
    if (lane < 0) return;
    e.preventDefault();
    if (down && e.repeat) return;
    if (this.opts.autoplay) { this.held[lane] = down; return; }

    // judge at the moment the key event fired, not when the handler ran
    const handlerDelayMs = Math.max(0, Math.min(100, performance.now() - e.timeStamp));
    const t = this.judgeTime() - handlerDelayMs;
    if (down) {
      this.held[lane] = true;
      this.flashLane(lane, 0.35);
      let best: RtNote | null = null;
      let bestDt = Infinity;
      for (const n of this.notes) {
        if (n.lane !== lane || n.headJudged) continue;
        const dt = Math.abs(n.t - t);
        if (dt <= BAD_MS && dt < bestDt) { best = n; bestDt = dt; }
        if (n.t - t > BAD_MS) break;
      }
      if (best) {
        const j: Judgment = bestDt <= COOL_MS ? 'cool' : bestDt <= GOOD_MS ? 'good' : 'bad';
        best.headJudged = true;
        if (best.len > 0) {
          best.holding = true;
        } else {
          best.tailJudged = true;
        }
        this.registerJudgment(j, false);
        this.showTiming(t - best.t, j);
        this.flashLane(lane, 0.7);
        this.spawnHitFx(lane, j);
      }
    } else {
      this.held[lane] = false;
      for (const n of this.notes) {
        if (n.lane !== lane || !n.holding) continue;
        n.holding = false;
        const tail = n.t + n.len;
        const dt = Math.abs(tail - t);
        if (t >= tail - BAD_MS) {
          const j: Judgment = dt <= COOL_MS ? 'cool' : dt <= GOOD_MS ? 'good' : 'bad';
          n.tailJudged = true;
          this.registerJudgment(j, false);
          this.spawnHitFx(lane, j);
        } else {
          n.brokenHold = true;
          n.tailJudged = true;
          n.missed = true;
          this.registerJudgment('miss', true);
        }
        break;
      }
    }
  }

  private judgeTime(): number {
    return this.audio.timeMs - this.opts.offsetMs;
  }

  private setSpeed(speed: number): void {
    this.opts.speed = Math.max(0.5, Math.min(6, Math.round(speed * 4) / 4));
    this.pxPerMs = 0.45 * this.opts.speed;
    this.speedText.text = `${this.opts.speed}x`;
    this.speedAge = 0;
    this.opts.onSpeedChange?.(this.opts.speed);
  }

  private registerJudgment(j: Judgment, silent: boolean): void {
    this.counts[j]++;
    if (j === 'miss') this.combo = 0;
    else this.combo++;
    if (this.combo > 0 && this.combo % 50 === 0) this.spawnComboFx();
    if (this.combo > this.maxCombo) this.maxCombo = this.combo;
    const pts = j === 'cool' ? 3 : j === 'good' ? 2 : j === 'bad' ? 1 : 0;
    this.earned += pts;
    this.scorePoints += pts * (this.golden ? 2 : 1);

    if (this.opts.mode === 'audition') {
      this.power = Math.max(0, Math.min(100, this.power + POWER_GAIN[j]));
      if (this.power <= 0) this.pendingDropOut = true;
      if (!this.golden && this.combo >= this.goldenComboTarget) this.triggerGolden();
    }
    if (!silent || j === 'miss') {
      const s = JUDGE_STYLE[j];
      this.judgeText.text = s.text;
      this.judgeText.style.fill = s.color;
      this.timingText.text = '';
      this.judgeAge = 0;
    }
  }

  /** audition: rainbow LED power gauge along the right side of the field */
  private drawPowerBar(): void {
    const g = this.powerG;
    g.clear();
    const x = this.laneX[0] + this.laneW * this.lanes + 12;
    const top = 30;
    const bottom = this.hitY - 8;
    const h = bottom - top;
    const w = 16;
    const low = this.power < 25;
    const frame = low && Math.sin(performance.now() / 120) > 0 ? 0xff3b30 : 0x232645;
    g.roundRect(x - 4, top - 4, w + 8, h + 8, 6).fill(0x11142a).stroke({ color: frame, width: 2 });

    const segs = 30;
    const gap = 2;
    const segH = (h - (segs - 1) * gap) / segs;
    const lit = Math.round((this.power / 100) * segs);
    for (let i = 0; i < segs; i++) {
      const yy = bottom - (i + 1) * segH - i * gap;
      if (i < lit) {
        // rainbow: red at the bottom → violet at the top, gold during golden time
        const color = this.golden ? GOLD : hslToHex((i / segs) * 280, 0.9, 0.55);
        g.roundRect(x, yy, w, segH, 2).fill(color);
      } else {
        g.roundRect(x, yy, w, segH, 2).fill(0x1a1e3a);
      }
    }
  }

  private explodeFirework(x: number, y: number, color: number): void {
    const n = 26;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const sp = 2.2 + Math.random() * 3.2;
      const life = 550 + Math.random() * 450;
      this.particles.push({
        kind: 'spark', x, y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 0.5,
        life, maxLife: life,
        color: Math.random() < 0.25 ? 0xffffff : color,
        size: 2 + Math.random() * 2.5,
      });
    }
    this.particles.push({
      kind: 'ring', x, y, vx: 0, vy: 0,
      life: 380, maxLife: 380, color, size: 70,
    });
  }

  private launchRocket(): void {
    const w = this.app.screen.width;
    this.particles.push({
      kind: 'rocket',
      x: w * (0.15 + Math.random() * 0.7),
      y: this.app.screen.height + 10,
      vx: (Math.random() - 0.5) * 1.4,
      vy: -(7 + Math.random() * 3),
      life: 550 + Math.random() * 350,
      maxLife: 900,
      color: hslToHex(Math.random() * 360, 0.9, 0.6),
      size: 3,
    });
  }

  /** win: CLEAR! + fireworks, then ease into the results */
  private startClearEnding(): void {
    this.ending = 'clear';
    this.endingAge = 0;
    this.rocketTimer = 0;
    this.endStats = this.stats();
    this.endingText.text = this.golden ? '✨ CLEAR! ✨' : 'CLEAR!';
    this.endingText.style.fill = this.golden ? GOLD : 0xffe066;
    this.endingText.visible = true;
    for (let i = 0; i < 3; i++) this.launchRocket();
  }

  /** drop-out: capture the live screen and shatter it into falling shards */
  private startBreakEnding(): void {
    this.ending = 'break';
    this.endingAge = 0;
    const stats = this.stats();
    stats.droppedOut = true;
    this.endStats = stats;
    this.audio.stop();

    const w = this.app.screen.width;
    const h = this.app.screen.height;
    this.shatterTex = this.app.renderer.generateTexture(this.app.stage);
    this.app.stage.removeChildren();
    const cols = 6;
    const rows = 9;
    const cw = w / cols;
    const ch = h / rows;
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const frame = new Rectangle(cx * cw, cy * ch, cw, ch);
        const sprite = new Sprite(new Texture({ source: this.shatterTex.source, frame }));
        sprite.anchor.set(0.5);
        sprite.position.set(cx * cw + cw / 2, cy * ch + ch / 2);
        this.app.stage.addChild(sprite);
        // shards near the center get kicked harder
        const dx = sprite.x - w / 2;
        this.shards.push({
          sprite,
          vx: dx * 0.004 + (Math.random() - 0.5) * 2.2,
          vy: -1 - Math.random() * 2.5,
          vr: (Math.random() - 0.5) * 0.12,
          delay: Math.random() * 260,
        });
      }
    }
  }

  private updateShatter(dtMs: number): void {
    this.endingAge += dtMs;
    const k = dtMs / 16.7;
    for (const s of this.shards) {
      if (this.endingAge < s.delay) continue;
      s.sprite.x += s.vx * k;
      s.sprite.y += s.vy * k;
      s.vy += 0.55 * k;
      s.sprite.rotation += s.vr * k;
      s.sprite.alpha = Math.max(0, 1 - (this.endingAge - s.delay) / 1600);
    }
    if (this.endingAge > 1900 && !this.finished) {
      this.finished = true;
      const stats = this.endStats!;
      this.destroy();
      this.opts.onFinish(stats);
    }
  }

  /** audition: GOLDEN BUZZER — golden stage + double score for the rest of the song */
  private triggerGolden(): void {
    this.golden = true;
    this.goldenAge = 0;
    this.goldenBanner.visible = true;
    // gold confetti everywhere
    const fieldW = this.laneW * this.lanes;
    for (let i = 0; i < 90; i++) {
      const life = 600 + Math.random() * 900;
      this.particles.push({
        kind: 'spark', x: this.laneX[0] + Math.random() * fieldW, y: -20 - Math.random() * 200,
        vx: (Math.random() - 0.5) * 2.5, vy: 1.5 + Math.random() * 3,
        life, maxLife: life, color: Math.random() < 0.7 ? GOLD : 0xffffff, size: 2 + Math.random() * 4,
      });
    }
    // golden stage ambience: warm wash + glowing side edges (notes keep their colors)
    const gb = this.goldenBgG;
    const fieldX = this.laneX[0];
    gb.clear();
    gb.rect(fieldX, 0, fieldW, this.hitY).fill({ color: GOLD, alpha: 0.055 });
    gb.rect(fieldX, 0, 24, this.hitY).fill({ color: GOLD, alpha: 0.12 });
    gb.rect(fieldX + fieldW - 24, 0, 24, this.hitY).fill({ color: GOLD, alpha: 0.12 });
    gb.rect(fieldX - 30, this.hitY - 5, fieldW + 60, 10).fill({ color: GOLD, alpha: 0.5 });
  }

  /** Show which direction a non-perfect press was off, so players can calibrate. */
  private showTiming(signedDtMs: number, j: Judgment): void {
    if (j === 'cool') { this.timingText.text = ''; return; }
    const early = signedDtMs < 0;
    this.timingText.text = `${early ? 'EARLY' : 'LATE'} ${Math.abs(Math.round(signedDtMs))}ms`;
    this.timingText.style.fill = early ? 0x6fb7ff : 0xffa94d;
  }

  private flashLane(lane: number, alpha: number): void {
    this.laneFlash[lane].alpha = Math.max(this.laneFlash[lane].alpha, alpha * 0.4);
    this.keyGlow[lane].tint = 0xffffff;
    this.keyGlow[lane].alpha = 1;
  }

  /** spark burst + shockwave ring at the hit line */
  private spawnHitFx(lane: number, j: Judgment): void {
    if (j === 'miss' || this.particles.length > 280) return;
    const cx = this.laneX[lane] + this.laneW / 2;
    const color = j === 'cool' ? this.colors[lane] : JUDGE_STYLE[j].color;
    const count = j === 'cool' ? 10 : 6;
    for (let i = 0; i < count; i++) {
      const a = Math.PI * (1 + Math.random()); // upward half
      const sp = 2 + Math.random() * 4;
      const life = 300 + Math.random() * 250;
      this.particles.push({
        kind: 'spark', x: cx + (Math.random() - 0.5) * this.laneW * 0.6, y: this.hitY,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1.5,
        life, maxLife: life, color, size: 2 + Math.random() * 3,
      });
    }
    this.particles.push({
      kind: 'ring', x: cx, y: this.hitY, vx: 0, vy: 0,
      life: 320, maxLife: 320, color, size: this.laneW * 0.75,
    });
  }

  /** celebratory burst across the field on combo milestones */
  private spawnComboFx(): void {
    for (let lane = 0; lane < this.lanes; lane++) {
      const cx = this.laneX[lane] + this.laneW / 2;
      for (let i = 0; i < 4; i++) {
        const life = 450 + Math.random() * 300;
        this.particles.push({
          kind: 'spark', x: cx, y: this.hitY,
          vx: (Math.random() - 0.5) * 5, vy: -3 - Math.random() * 5,
          life, maxLife: life, color: 0xffe066, size: 2.5 + Math.random() * 3,
        });
      }
    }
  }

  private updateFx(dtMs: number, t: number): void {
    // physics + draw
    const k = dtMs / 16.7;
    const g = this.fxG;
    g.clear();
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dtMs;
      if (p.life <= 0) {
        if (p.kind === 'rocket') this.explodeFirework(p.x, p.y, p.color);
        this.particles.splice(i, 1);
        continue;
      }
      const a = p.life / p.maxLife;
      if (p.kind === 'spark') {
        p.x += p.vx * k;
        p.y += p.vy * k;
        p.vy += 0.28 * k;
        g.circle(p.x, p.y, p.size * (0.5 + a * 0.5)).fill({ color: p.color, alpha: a });
      } else if (p.kind === 'rocket') {
        p.x += p.vx * k;
        p.y += p.vy * k;
        g.circle(p.x, p.y, p.size).fill({ color: 0xffffff, alpha: 0.9 });
        g.circle(p.x, p.y + 8, p.size * 0.7).fill({ color: p.color, alpha: 0.5 });
      } else {
        const r = p.size * (1.3 - a);
        g.circle(p.x, p.y, r).stroke({ color: p.color, alpha: a * 0.9, width: 3 * a + 1 });
      }
    }

    // sparkles while holding long notes
    this.holdSparkTimer -= dtMs;
    if (this.holdSparkTimer <= 0) {
      this.holdSparkTimer = 70;
      for (const n of this.notes) {
        if (!n.holding || this.particles.length > 280) continue;
        const cx = this.laneX[n.lane] + this.laneW / 2;
        const life = 250 + Math.random() * 200;
        this.particles.push({
          kind: 'spark', x: cx + (Math.random() - 0.5) * this.laneW * 0.7, y: this.hitY,
          vx: (Math.random() - 0.5) * 1.5, vy: -1 - Math.random() * 2.5,
          life, maxLife: life, color: this.colors[n.lane], size: 1.5 + Math.random() * 2,
        });
      }
    }

    // golden time: gentle gold confetti rain
    if (this.golden) {
      this.goldSparkTimer -= dtMs;
      if (this.goldSparkTimer <= 0 && this.particles.length < 280) {
        this.goldSparkTimer = 110;
        const fieldW = this.laneW * this.lanes;
        for (let i = 0; i < 2; i++) {
          const life = 700 + Math.random() * 600;
          this.particles.push({
            kind: 'spark', x: this.laneX[0] + Math.random() * fieldW, y: -10,
            vx: (Math.random() - 0.5) * 1.5, vy: 1 + Math.random() * 2,
            life, maxLife: life, color: Math.random() < 0.7 ? GOLD : 0xfff6c2, size: 1.5 + Math.random() * 2.5,
          });
        }
      }
    }

    // background pulse on every beat (gold during golden time)
    const beatMs = 60000 / this.chart.bpm;
    const phase = ((t - this.chart.offsetMs) % beatMs + beatMs) % beatMs;
    const pulse = Math.max(0, 1 - phase / (beatMs * 0.4));
    const pulseColor = this.golden ? GOLD : 0xff4d88;
    const bp = this.beatPulseG;
    bp.clear();
    if (pulse > 0.01 && t > 0) {
      const fieldW = this.laneW * this.lanes;
      const fieldX = this.laneX[0];
      bp.rect(fieldX, 0, fieldW, this.hitY).fill({ color: pulseColor, alpha: pulse * (this.golden ? 0.07 : 0.045) });
      bp.rect(fieldX - 30, this.hitY - 4, fieldW + 60, 8).fill({ color: pulseColor, alpha: pulse * 0.35 });
    }
  }

  private update(): void {
    if (this.destroyed) return;
    const dtMs = this.app.ticker.deltaMS;
    if (this.ending === 'break') {
      this.updateShatter(dtMs);
      return;
    }
    const t = this.judgeTime();

    // autoplay: perfect hits exactly on time
    if (this.opts.autoplay) {
      for (const n of this.notes) {
        if (!n.headJudged && n.t <= t) {
          n.headJudged = true;
          if (n.len > 0) n.holding = true;
          else n.tailJudged = true;
          this.registerJudgment('cool', false);
          this.flashLane(n.lane, 0.7);
          this.spawnHitFx(n.lane, 'cool');
        }
        if (n.holding && n.t + n.len <= t) {
          n.holding = false;
          n.tailJudged = true;
          this.registerJudgment('cool', false);
          this.spawnHitFx(n.lane, 'cool');
        }
        if (n.t > t) break;
      }
    }

    // miss detection
    for (const n of this.notes) {
      if (!n.headJudged && n.t < t - BAD_MS) {
        n.headJudged = true;
        n.tailJudged = true; // missed LN head forfeits the tail too
        n.missed = true;
        this.registerJudgment('miss', false);
        if (n.len > 0) this.registerJudgment('miss', true);
      }
      // LN held to the end: auto-complete the tail as COOL
      if (n.holding && t >= n.t + n.len) {
        n.holding = false;
        n.tailJudged = true;
        this.registerJudgment('cool', false);
        this.flashLane(n.lane, 0.5);
        this.spawnHitFx(n.lane, 'cool');
      }
      if (n.t - t > BAD_MS + 50) break;
    }

    this.renderNotes(t);
    this.updateFx(dtMs, t);

    // HUD decay
    this.judgeAge += dtMs;
    const k = Math.max(0, 1 - this.judgeAge / 350);
    this.judgeText.scale.set(1 + 0.25 * k);
    this.judgeText.alpha = this.judgeAge < 500 ? 1 : Math.max(0, 1 - (this.judgeAge - 500) / 300);
    this.timingText.alpha = this.judgeText.alpha;
    this.speedAge += dtMs;
    this.speedText.style.fill = this.speedAge < 800 ? 0xffe066 : 0x8a90c0;

    // audition HUD animation
    if (this.opts.mode === 'audition') this.drawPowerBar();
    if (this.golden) {
      this.goldenAge += dtMs;
      const burst = Math.max(0, 1 - this.goldenAge / 900);
      this.goldenBanner.scale.set(1 + burst * 0.8);
      this.goldenBanner.alpha = this.goldenAge < 2600 ? 1 : 0.55 + 0.2 * Math.sin(this.goldenAge / 300);
      this.comboText.style.fill = 0xffd700;
      this.goldenBgG.alpha = 0.8 + 0.2 * Math.sin(this.goldenAge / 250);
    }
    this.comboText.text = this.combo >= 2 ? String(this.combo) : '';
    this.comboText.scale.set(1 + 0.15 * k);
    this.scoreText.text = String(this.currentScore()).padStart(7, '0');
    for (const f of this.laneFlash) f.alpha *= Math.pow(0.85, dtMs / 16.7);
    for (let i = 0; i < this.lanes; i++) {
      if (!this.held[i]) this.keyGlow[i].alpha = Math.max(0.9, this.keyGlow[i].alpha * 0.9);
      this.keyGlow[i].tint = this.held[i] ? this.colors[i] : 0xffffff;
    }

    const width = this.app.screen.width;
    this.progress.clear();
    this.progress.rect(0, 0, width * Math.max(0, Math.min(1, t / this.songEndMs)), 4).fill(0xff4d88);

    // audition: power empty → screen shatters, then results
    if (this.pendingDropOut && this.ending === 'none' && !this.finished) {
      this.startBreakEnding();
      return;
    }

    // song complete → CLEAR! + fireworks, then results
    if (this.ending === 'none' && !this.finished && t > this.songEndMs + 800) {
      this.startClearEnding();
    }
    if (this.ending === 'clear') {
      this.endingAge += dtMs;
      this.rocketTimer -= dtMs;
      if (this.endingAge < 2300 && this.rocketTimer <= 0 && this.particles.length < 260) {
        this.rocketTimer = 280 + Math.random() * 260;
        this.launchRocket();
      }
      const pop = Math.max(0, 1 - this.endingAge / 450);
      this.endingText.scale.set(1 + 1.1 * pop * pop);
      this.endingText.alpha = Math.min(1, this.endingAge / 160);
      if (this.endingAge > 2700) {
        this.app.canvas.style.transition = 'opacity 0.6s ease';
        this.app.canvas.style.opacity = '0';
      }
      if (this.endingAge > 3350 && !this.finished) {
        this.finished = true;
        const stats = this.endStats!;
        this.destroy();
        this.opts.onFinish(stats);
      }
    }
  }

  private renderNotes(t: number): void {
    const height = this.app.screen.height;
    const lookAheadMs = (this.hitY + 200) / this.pxPerMs;
    // ms past the hit line at which a note is fully below the canvas
    const belowMs = (height - this.hitY + 60) / this.pxPerMs;

    for (const n of this.notes) {
      const done = n.len > 0 ? n.tailJudged : n.headJudged;
      // hit notes vanish immediately; missed notes keep falling until off-screen
      const gone = (done && !n.missed) || n.t + n.len - t < -belowMs;
      const visible = !gone && n.t - t < lookAheadMs;
      if (visible && !n.body) {
        const g = new Graphics();
        this.drawNote(g, n);
        this.notesLayer.addChild(g);
        n.body = g;
      } else if (!visible && n.body) {
        n.body.destroy();
        n.body = null;
        continue;
      }
      if (!n.body) continue;

      const headY = this.hitY - (n.t - t) * this.pxPerMs;
      if (n.len > 0) {
        const tailY = this.hitY - (n.t + n.len - t) * this.pxPerMs;
        const anchorY = n.holding ? Math.min(this.hitY, headY) : headY;
        n.body.position.set(0, 0);
        n.body.clear();
        this.drawLongNote(n.body, n, anchorY, tailY, n.holding);
      } else {
        n.body.position.set(0, headY);
        n.body.visible = headY < height + 30;
      }
      n.body.alpha = n.missed ? 0.3 : 1;
    }
  }

  private drawNote(g: Graphics, n: RtNote): void {
    if (n.len > 0) return; // long notes are redrawn each frame
    const x = this.laneX[n.lane] + 3;
    const w = this.laneW - 6;
    g.roundRect(x, -9, w, 18, 5).fill(this.colors[n.lane]);
    g.roundRect(x, -9, w, 6, 3).fill(0xffffff);
  }

  private drawLongNote(g: Graphics, n: RtNote, headY: number, tailY: number, holding: boolean): void {
    const x = this.laneX[n.lane] + 3;
    const w = this.laneW - 6;
    const color = this.colors[n.lane];
    const bodyTop = Math.min(tailY, headY);
    const bodyH = Math.max(4, Math.abs(headY - tailY));
    g.roundRect(x + 8, bodyTop, w - 16, bodyH, 6).fill({ color, alpha: holding ? 0.85 : 0.45 });
    g.roundRect(x, tailY - 7, w, 14, 5).fill({ color, alpha: 0.9 });
    g.roundRect(x, headY - 9, w, 18, 5).fill(color);
    if (holding) g.roundRect(x, headY - 9, w, 18, 5).stroke({ color: 0xffffff, width: 2 });
  }

  private currentScore(): number {
    if (this.totalJudgments === 0) return 0;
    return Math.round((1000000 * this.scorePoints) / (3 * this.totalJudgments));
  }

  private stats(): PlayStats {
    const done = this.counts.cool + this.counts.good + this.counts.bad + this.counts.miss;
    const accuracy = done > 0 ? this.earned / (3 * done) : 0;
    const grade =
      accuracy >= 0.98 ? 'SS' :
      accuracy >= 0.95 ? 'S' :
      accuracy >= 0.9 ? 'A' :
      accuracy >= 0.8 ? 'B' :
      accuracy >= 0.7 ? 'C' : 'D';
    return {
      ...this.counts,
      maxCombo: this.maxCombo,
      totalJudgments: this.totalJudgments,
      score: this.currentScore(),
      accuracy: Math.round(accuracy * 1000) / 10,
      grade,
      droppedOut: false,
      goldenTime: this.golden,
    };
  }
}
