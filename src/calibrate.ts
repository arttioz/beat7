/**
 * Tap-to-calibrate: plays a steady metronome, the user taps any key on each
 * click, and the median (tap time − click time) becomes the judgment offset.
 * This measures the user's whole chain — audio output latency, display lag,
 * keyboard latency, personal tendency — with the same clock gameplay uses.
 */
export interface CalibrationResult {
  offsetMs: number;
  taps: number;
}

const CLICK_INTERVAL = 0.5; // 120 BPM
const TOTAL_CLICKS = 16;
const WARMUP_CLICKS = 4; // first taps are ignored while the user settles in

export class Calibrator {
  private ctx: AudioContext | null = null;
  private clickTimes: number[] = [];
  private deltas: number[] = [];
  private latencySec = 0;
  private done = false;

  onProgress: (tapCount: number, needed: number, lastDeltaMs: number) => void = () => {};
  onFinish: (result: CalibrationResult) => void = () => {};

  start(): void {
    this.ctx = new AudioContext();
    void this.ctx.resume();
    const raw = (this.ctx as AudioContext & { outputLatency?: number }).outputLatency ?? 0;
    this.latencySec = Number.isFinite(raw) ? Math.min(0.3, Math.max(0, raw)) : 0;

    const t0 = this.ctx.currentTime + 1;
    this.clickTimes = [];
    this.deltas = [];
    this.done = false;
    for (let i = 0; i < TOTAL_CLICKS; i++) {
      const t = t0 + i * CLICK_INTERVAL;
      this.clickTimes.push(t);
      this.scheduleClick(t, i % 4 === 0);
    }
    window.addEventListener('keydown', this.keydown);
    window.addEventListener('pointerdown', this.pointertap);
    // stop listening shortly after the last click
    setTimeout(() => this.finish(), (1 + TOTAL_CLICKS * CLICK_INTERVAL + 0.6) * 1000);
  }

  cancel(): void {
    this.done = true;
    window.removeEventListener('keydown', this.keydown);
    window.removeEventListener('pointerdown', this.pointertap);
    void this.ctx?.close();
    this.ctx = null;
  }

  private scheduleClick(t: number, accent: boolean): void {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.frequency.value = accent ? 1500 : 1000;
    g.gain.setValueAtTime(accent ? 0.5 : 0.35, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    osc.connect(g).connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + 0.06);
  }

  private keydown = (e: KeyboardEvent): void => {
    if (e.repeat || e.code === 'Escape') return;
    e.preventDefault();
    this.registerTap(e.timeStamp);
  };

  /** touch screens: tapping anywhere counts as a tap (mouse uses keys/buttons) */
  private pointertap = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse') return;
    this.registerTap(e.timeStamp);
  };

  private registerTap(eventTimeStamp: number): void {
    if (!this.ctx || this.done) return;
    // same clock semantics as gameplay: context time minus reported latency,
    // corrected by how long the event waited before we handled it
    const handlerDelaySec = Math.max(0, Math.min(0.1, (performance.now() - eventTimeStamp) / 1000));
    const tapTime = this.ctx.currentTime - this.latencySec - handlerDelaySec;
    // nearest click
    let best = Infinity;
    let bestIdx = -1;
    for (let i = 0; i < this.clickTimes.length; i++) {
      const d = tapTime - this.clickTimes[i];
      if (Math.abs(d) < Math.abs(best)) { best = d; bestIdx = i; }
    }
    if (bestIdx < WARMUP_CLICKS || Math.abs(best) > 0.25) return;
    this.deltas.push(best * 1000);
    this.onProgress(this.deltas.length, TOTAL_CLICKS - WARMUP_CLICKS, Math.round(best * 1000));
    if (this.deltas.length >= TOTAL_CLICKS - WARMUP_CLICKS) this.finish();
  };

  private finish(): void {
    if (this.done) return;
    this.done = true;
    window.removeEventListener('keydown', this.keydown);
    window.removeEventListener('pointerdown', this.pointertap);
    void this.ctx?.close();
    this.ctx = null;
    if (this.deltas.length < 4) {
      this.onFinish({ offsetMs: NaN, taps: this.deltas.length });
      return;
    }
    const sorted = [...this.deltas].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    this.onFinish({
      offsetMs: Math.max(-300, Math.min(300, Math.round(median / 5) * 5)),
      taps: this.deltas.length,
    });
  }
}
