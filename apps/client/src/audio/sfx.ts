// 効果音（設計書 Audio）。音声ファイルを使わず WebAudio で合成する。
// コール（「ニンニク入れますか？」など）は端末の音声合成（日本語）で読み上げる。

import type { GameEvent } from '@jiro/core';

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private ambience: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  enabled = true;
  voice = true;
  volume = 0.7;
  private lastPlay = new Map<string, number>();

  /** ユーザー操作の中で呼ぶ（iOS の自動再生制限のため） */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  private now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  private throttle(key: string, sec: number): boolean {
    const t = performance.now() / 1000;
    const last = this.lastPlay.get(key) ?? -1e9;
    if (t - last < sec) return false;
    this.lastPlay.set(key, t);
    return true;
  }

  private tone(freq: number, dur: number, type: OscillatorType = 'sine', gain = 0.2, slide = 0, delay = 0): void {
    if (!this.ctx || !this.master || !this.enabled) return;
    const t0 = this.now() + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(this.master);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  private noise(dur: number, freq: number, q = 1, gain = 0.15, type: BiquadFilterType = 'bandpass', delay = 0): void {
    if (!this.ctx || !this.master || !this.enabled) return;
    const t0 = this.now() + delay;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t0);
  }

  /** 店内の環境音（換気扇・ぐつぐつ・ざわめき） */
  startAmbience(): void {
    if (!this.ctx || !this.master || this.ambience) return;
    const len = this.ctx.sampleRate * 4;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b = 0;
    for (let i = 0; i < len; i++) {
      // ブラウンノイズ＋ときどき泡の音
      b = (b + (Math.random() * 2 - 1) * 0.02) * 0.995;
      d[i] = b * 3 + (Math.random() < 0.0004 ? (Math.random() - 0.5) * 0.6 : 0);
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = this.ctx.createGain();
    g.gain.value = 0.12;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 900;
    src.connect(f).connect(g).connect(this.master);
    src.start();
    this.ambience = { src, gain: g };
  }

  stopAmbience(): void {
    this.ambience?.src.stop();
    this.ambience = null;
  }

  say(text: string, rate = 1.15, pitch = 1): void {
    if (!this.voice || !this.enabled || !text) return;
    const synth = window.speechSynthesis;
    if (!synth) return;
    try {
      if (synth.speaking && synth.pending) synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ja-JP';
      u.rate = rate;
      u.pitch = pitch;
      u.volume = Math.min(1, this.volume + 0.2);
      synth.speak(u);
    } catch {
      // 音声合成が使えない端末
    }
  }

  /** ゲームイベントに対応する音 */
  onEvents(events: GameEvent[], myId: string): void {
    for (const ev of events) {
      const mine = ev.actorId === myId;
      switch (ev.type) {
        case 'arrive':
          if (this.throttle('arrive', 1.5)) this.noise(0.12, 2500, 4, 0.04, 'bandpass');
          break;
        case 'ticket':
          if (this.throttle('ticket', 0.5)) {
            this.tone(1320, 0.08, 'square', 0.06);
            this.tone(990, 0.1, 'square', 0.05, 0, 0.09);
          }
          break;
        case 'seated':
          if (this.throttle('seated', 0.5)) this.say('いらっしゃいませ', 1.2, 0.9);
          break;
        case 'noodlesIn':
          this.noise(0.35, 600, 0.8, 0.12, 'lowpass');
          break;
        case 'noodlesUp':
          // 湯切り（チャッチャッ）
          for (let i = 0; i < 3; i++) this.noise(0.08, 1800, 2, 0.15, 'bandpass', i * 0.12);
          break;
        case 'tare':
          if (mine) this.noise(0.15, 900, 3, 0.05);
          break;
        case 'soup':
          if (mine) this.noise(0.3, 500, 1, 0.08, 'lowpass');
          break;
        case 'toppings':
          if (mine) this.noise(0.2, 3000, 1, 0.04, 'highpass');
          break;
        case 'call':
          if (mine) this.say('ニンニク入れますか？', 1.2, 0.85);
          if (ev.text) setTimeout(() => this.say(ev.text ?? '', 1.25, 1.1), mine ? 1200 : 0);
          break;
        case 'served':
          this.tone(660, 0.07, 'triangle', 0.08);
          this.tone(880, 0.12, 'triangle', 0.08, 0, 0.07);
          if (mine && this.throttle('serve-voice', 2)) this.say('お待たせしました', 1.25, 0.9);
          break;
        case 'collect':
        case 'wash':
          if (this.throttle(`dish${ev.type}`, 0.25)) this.tone(2200 + Math.random() * 600, 0.05, 'triangle', 0.04);
          break;
        case 'wipe':
        case 'mop':
          this.noise(0.4, 1200, 0.7, 0.05);
          break;
        case 'complaint':
          this.tone(220, 0.25, 'sawtooth', 0.06, -60);
          break;
        case 'walkout':
        case 'abandon':
          if (this.throttle('walkout', 1)) this.tone(300, 0.3, 'triangle', 0.05, -120);
          break;
        case 'breakdown':
          this.noise(0.5, 300, 0.5, 0.2, 'lowpass');
          this.tone(110, 0.4, 'square', 0.05, -40);
          break;
        case 'goal':
          [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.18, 'triangle', 0.1, 0, i * 0.11));
          break;
        case 'open':
          this.say('開店です！', 1.1, 1);
          break;
        case 'dayEnd':
          [784, 659, 523].forEach((f, i) => this.tone(f, 0.2, 'sine', 0.08, 0, i * 0.15));
          break;
        case 'notice':
          if ((ev.value ?? 0) >= 2 && this.throttle('danger', 1.5)) this.tone(880, 0.12, 'square', 0.05);
          break;
        case 'workDone':
          if (mine) this.tone(1200, 0.05, 'sine', 0.05);
          break;
        case 'tutorialStep':
          [880, 1175].forEach((f, i) => this.tone(f, 0.12, 'sine', 0.06, 0, i * 0.09));
          break;
        case 'tutorialDone':
          [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.18, 'triangle', 0.1, 0, i * 0.11));
          break;
        default:
          break;
      }
    }
  }
}
