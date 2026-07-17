/**
 * Audio playback with a sample-accurate clock.
 * All gameplay timing derives from AudioContext.currentTime.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private levelBuf: Uint8Array<ArrayBuffer> | null = null;
  buffer: AudioBuffer | null = null;
  /** ctx time at which audio sample 0 plays (song time zero) */
  private zeroTime = 0;
  /** output latency sampled once per play — per-frame reads jitter on macOS */
  private latencySec = 0;
  /** song position at zeroTime, for playback that starts mid-song */
  private startMs = 0;
  private rate = 1;
  playing = false;

  private ensureCtx(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  async decode(data: ArrayBuffer): Promise<AudioBuffer> {
    const ctx = this.ensureCtx();
    this.buffer = await ctx.decodeAudioData(data);
    return this.buffer;
  }

  setBuffer(buffer: AudioBuffer): void {
    this.buffer = buffer;
  }

  /**
   * Start playback with a lead-in, optionally from mid-song and at a slower
   * rate (editor). Song time is negative during the lead-in.
   */
  play(leadInSec = 2, fromMs = 0, rate = 1): void {
    if (!this.buffer) throw new Error('no audio loaded');
    const ctx = this.ensureCtx();
    this.stop();
    this.source = ctx.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.playbackRate.value = rate;
    // route through an analyser so visuals can follow the live waveform
    if (!this.analyser) {
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.levelBuf = new Uint8Array(this.analyser.fftSize);
      this.analyser.connect(ctx.destination);
    }
    this.source.connect(this.analyser);
    const raw = (ctx as AudioContext & { outputLatency?: number }).outputLatency ?? 0;
    this.latencySec = Number.isFinite(raw) ? Math.min(0.3, Math.max(0, raw)) : 0;
    const startAt = ctx.currentTime + 0.05;
    this.zeroTime = startAt + leadInSec;
    this.startMs = fromMs;
    this.rate = rate;
    this.source.start(this.zeroTime, Math.max(0, fromMs) / 1000);
    this.playing = true;
    this.source.onended = () => { this.playing = false; };
  }

  stop(): void {
    if (this.source) {
      try { this.source.stop(); } catch { /* already stopped */ }
      this.source.disconnect();
      this.source = null;
    }
    this.playing = false;
  }

  /** Current song time in ms (negative during lead-in). */
  get timeMs(): number {
    if (!this.ctx) return 0;
    return this.startMs + (this.ctx.currentTime - this.zeroTime - this.latencySec) * 1000 * this.rate;
  }

  get durationMs(): number {
    return this.buffer ? this.buffer.duration * 1000 : 0;
  }

  /** Instantaneous RMS loudness (~0..0.5) of what is playing right now. */
  get level(): number {
    if (!this.analyser || !this.levelBuf || !this.playing) return 0;
    this.analyser.getByteTimeDomainData(this.levelBuf);
    let sum = 0;
    for (let i = 0; i < this.levelBuf.length; i++) {
      const v = (this.levelBuf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / this.levelBuf.length);
  }
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
