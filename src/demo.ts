/**
 * Synthesizes a 32-second 120 BPM demo track with OfflineAudioContext
 * so the whole pipeline can be tested without uploading an MP3.
 */
export async function renderDemoSong(): Promise<AudioBuffer> {
  const sr = 44100;
  const bpm = 120;
  const beat = 60 / bpm;
  const bars = 16;
  const totalSec = bars * 4 * beat + 1;
  const ctx = new OfflineAudioContext(2, Math.ceil(totalSec * sr), sr);

  const master = ctx.createGain();
  master.gain.value = 0.8;
  master.connect(ctx.destination);

  const noiseBuf = ctx.createBuffer(1, sr, sr);
  const nd = noiseBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

  const kick = (t: number) => {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.1);
    g.gain.setValueAtTime(1.0, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    osc.connect(g).connect(master);
    osc.start(t); osc.stop(t + 0.3);
  };

  const snare = (t: number) => {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.6, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    src.connect(bp).connect(g).connect(master);
    src.start(t); src.stop(t + 0.2);
  };

  const hat = (t: number, loud: boolean) => {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 7500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(loud ? 0.3 : 0.15, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    src.connect(hp).connect(g).connect(master);
    src.start(t); src.stop(t + 0.06);
  };

  const bassNote = (t: number, freq: number, dur: number) => {
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = freq;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.22, t);
    g.gain.setValueAtTime(0.22, t + dur - 0.03);
    g.gain.linearRampToValueAtTime(0, t + dur);
    osc.connect(lp).connect(g).connect(master);
    osc.start(t); osc.stop(t + dur);
  };

  const lead = (t: number, freq: number, dur: number) => {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0, t);
    g.gain.linearRampToValueAtTime(0.18, t + 0.02);
    g.gain.setValueAtTime(0.18, t + dur - 0.05);
    g.gain.linearRampToValueAtTime(0, t + dur);
    osc.connect(g).connect(master);
    osc.start(t); osc.stop(t + dur);
  };

  const bassRoots = [55, 55, 65.4, 49]; // A A C G per bar
  const scale = [220, 261.6, 293.7, 329.6, 392, 440];

  for (let bar = 0; bar < bars; bar++) {
    const barT = bar * 4 * beat;
    const intro = bar < 2;
    const breakdown = bar >= 8 && bar < 10;
    for (let b = 0; b < 4; b++) {
      const t = barT + b * beat;
      if (!breakdown) kick(t);
      if (b % 2 === 1 && !intro) snare(t);
      if (!intro && !breakdown) {
        hat(t, true);
        hat(t + beat / 2, false);
      }
      if (!intro) {
        bassNote(t, bassRoots[bar % 4], beat * 0.45);
        if (!breakdown) bassNote(t + beat / 2, bassRoots[bar % 4], beat * 0.2);
      }
    }
    // simple deterministic melody from bar 4 on
    if (bar >= 4) {
      for (let b = 0; b < 4; b++) {
        const idx = (bar * 7 + b * 3) % scale.length;
        lead(barT + b * beat, scale[idx], beat * 0.8);
        if (bar >= 12 && b % 2 === 0) {
          lead(barT + b * beat + beat / 2, scale[(idx + 2) % scale.length], beat * 0.35);
        }
      }
    }
  }

  return ctx.startRendering();
}
