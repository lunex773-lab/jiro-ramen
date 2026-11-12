// 横バウンスの客が店にいる間に流れる、オリジナルのダンス曲（じろ7 6-5。オーナーの判断: 実在の曲は使わない）。
// 音声ファイルを使わず WebAudio で合成する。キック・ハイハット・ベース・和音の刻みと、短い旋律を1小節ずつ先に予約する。

/** テンポ（1分の拍の数） */
const BPM = 124;
/** 16分音符の長さ（秒） */
const STEP = 60 / BPM / 4;
/** 4小節（16分音符 64個）でひと回り */
const LOOP = 64;

// コード進行（ルートの音の高さ。A=440 を 0 とした半音）: Dm → B♭ → F → C を1小節ずつ
const ROOTS = [-7, -11, -16, -9];
// 和音（ルートからの半音）: 短・長・長・長
const CHORDS = [
  [0, 3, 7],
  [0, 4, 7],
  [0, 4, 7],
  [0, 4, 7],
];
// 旋律（16分音符ごと。null は休み。A=440 からの半音）。跳ねる感じの、オリジナルの短い節
const MELODY: (number | null)[] = [
  5, null, 3, 5, null, 8, null, 5, 3, null, 0, null, 3, null, null, null,
  2, null, 0, 2, null, 5, null, 2, 0, null, -2, null, 0, null, null, null,
  0, null, -2, 0, null, 3, null, 5, 7, null, 5, null, 3, null, 0, null,
  -2, null, 0, 2, null, 3, null, 2, 0, null, -2, -4, -5, null, null, null,
];

const hz = (semi: number) => 440 * Math.pow(2, semi / 12);

export class DanceMusic {
  private gain: GainNode | null = null;
  private timer: number | null = null;
  private next = 0;
  private stepIdx = 0;
  private noiseBuf: AudioBuffer | null = null;

  constructor(private ctx: AudioContext, private out: AudioNode) {}

  get playing(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer !== null) return;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.55, this.ctx.currentTime + 1.2);
    g.connect(this.out);
    this.gain = g;
    if (!this.noiseBuf) {
      const len = Math.floor(this.ctx.sampleRate * 0.2);
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    this.next = this.ctx.currentTime + 0.1;
    this.stepIdx = 0;
    // 0.1秒ごとに、0.3秒先までの音を予約する（タブが裏にあっても途切れにくい）
    this.timer = window.setInterval(() => this.schedule(), 100);
    this.schedule();
  }

  /** フェードアウトして止める */
  stop(): void {
    if (this.timer === null) return;
    window.clearInterval(this.timer);
    this.timer = null;
    const g = this.gain;
    this.gain = null;
    if (!g) return;
    const t = this.ctx.currentTime;
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
    window.setTimeout(() => g.disconnect(), 1000);
  }

  private schedule(): void {
    const g = this.gain;
    if (!g) return;
    while (this.next < this.ctx.currentTime + 0.3) {
      this.playStep(this.stepIdx, this.next, g);
      this.stepIdx = (this.stepIdx + 1) % LOOP;
      this.next += STEP;
    }
  }

  private playStep(i: number, t: number, out: GainNode): void {
    const bar = Math.floor(i / 16);
    const s = i % 16;
    const root = ROOTS[bar]!;
    // キック（4つ打ち）
    if (s % 4 === 0) this.kick(t, out);
    // 裏拍のハイハット・2拍目と4拍目の手拍子
    if (s % 4 === 2) this.hat(t, out, 0.09);
    if (s % 2 === 1) this.hat(t, out, 0.03);
    if (s === 4 || s === 12) this.clap(t, out);
    // ベース（8分の裏で跳ねる）
    if (s % 4 === 0 || s % 4 === 3) this.osc(t, hz(root - 12), STEP * (s % 4 === 0 ? 1.6 : 0.9), 'sawtooth', 0.11, out, 420);
    // 和音の刻み（裏拍）
    if (s % 4 === 2) for (const c of CHORDS[bar]!) this.osc(t, hz(root + 12 + c), STEP * 0.9, 'square', 0.022, out, 1800);
    // 旋律
    const m = MELODY[i];
    if (m !== null && m !== undefined) this.osc(t, hz(m + 12), STEP * 1.6, 'triangle', 0.07, out, 3200);
  }

  private osc(t: number, f: number, dur: number, type: OscillatorType, v: number, out: AudioNode, cutoff: number): void {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    const flt = this.ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.value = cutoff;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(flt).connect(g).connect(out);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private kick(t: number, out: AudioNode): void {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.22);
  }

  private hat(t: number, out: AudioNode, v: number): void {
    this.noiseHit(t, out, v, 'highpass', 7000, 0.04);
  }

  private clap(t: number, out: AudioNode): void {
    this.noiseHit(t, out, 0.12, 'bandpass', 1500, 0.09);
  }

  private noiseHit(t: number, out: AudioNode, v: number, type: BiquadFilterType, f: number, dur: number): void {
    if (!this.noiseBuf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const flt = this.ctx.createBiquadFilter();
    flt.type = type;
    flt.frequency.value = f;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(flt).connect(g).connect(out);
    src.start(t);
    src.stop(t + dur + 0.02);
  }
}
