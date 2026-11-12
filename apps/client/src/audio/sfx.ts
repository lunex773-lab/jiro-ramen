// 効果音（設計書 Audio）。音声ファイルを使わず WebAudio で合成する。
// コール（「ニンニク入れますか？」など）は端末の音声合成（日本語）で読み上げる。

import type { GameEvent } from '@jiro/core';
import { DanceMusic } from './dance';

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private ambience: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  /** 爆発事故のあとの焼け跡の環境音（低いうなり・残り火のはぜる音） */
  private eerie: { nodes: AudioScheduledSourceNode[]; gain: GainNode } | null = null;
  enabled = true;
  voice = true;
  volume = 0.7;
  private lastPlay = new Map<string, number>();
  /** 横バウンスの客が店にいる間のダンス曲（じろ7 6-5） */
  private dance: DanceMusic | null = null;

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
    this.stopEerie();
    this.setDance(false);
  }

  /** ダンス曲を流す・止める（踊る客が店にいる間。効果音が切ってあれば流さない） */
  setDance(on: boolean): void {
    if (on && (!this.ctx || !this.master || !this.enabled)) return;
    if (on) {
      this.dance ??= new DanceMusic(this.ctx!, this.master!);
      this.dance.start();
    } else this.dance?.stop();
  }

  /** 珍客イベントの音（じろ7 6-5。すべて合成のオリジナル） */
  private chaosSound(kind: string): void {
    switch (kind) {
      case 'ufo':
        // 不思議なうなり（ゆれながら下がる音）
        for (let i = 0; i < 6; i++) this.tone(900 - i * 90, 0.45, 'sine', 0.06, i % 2 ? 120 : -120, i * 0.32);
        this.tone(110, 2.6, 'triangle', 0.05, -30);
        break;
      case 'ufoLand':
        this.noise(1.2, 400, 0.6, 0.12, 'lowpass');
        this.tone(220, 0.8, 'sine', 0.06, -80);
        break;
      case 'ufoAscend':
        this.tone(160, 2.2, 'sawtooth', 0.04, 1400);
        this.tone(320, 2.0, 'sine', 0.05, 2400, 0.1);
        break;
      case 'golden':
        // 食べる前は静かに（覚醒のときに鳴らす）
        break;
      case 'awaken':
        // 力がみなぎる: 低いうなり→上がっていく和音→きらめき
        this.noise(1.6, 300, 0.5, 0.18, 'lowpass');
        [262, 330, 392, 523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.5, 'sawtooth', 0.045, 0, 0.25 + i * 0.09));
        for (let i = 0; i < 10; i++) this.tone(2000 + Math.random() * 2200, 0.12, 'sine', 0.03, 0, 0.9 + i * 0.07);
        break;
      case 'fly':
        // 空へ飛び立つ（風を切る音）
        this.noise(1.8, 900, 0.7, 0.2, 'bandpass');
        this.tone(300, 1.4, 'sine', 0.05, 900);
        break;
      case 'bounce':
        // 弾む音
        this.tone(260, 0.16, 'sine', 0.09, 260);
        this.tone(330, 0.16, 'sine', 0.08, 300, 0.2);
        break;
      case 'nosepick':
        break;
      case 'bear':
        // ぽん、ぽん、と、ゆったりした音
        this.tone(196, 0.3, 'triangle', 0.1, -20);
        this.tone(247, 0.3, 'triangle', 0.09, -20, 0.32);
        this.tone(294, 0.45, 'triangle', 0.08, -10, 0.64);
        break;
      default:
        break;
    }
  }

  /** 焼け跡の環境音に切り替える（店内の環境音は止める） */
  startEerie(): void {
    if (!this.ctx || !this.master || this.eerie) return;
    this.ambience?.src.stop();
    this.ambience = null;
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.5, ctx.currentTime + 4);
    g.connect(this.master);
    // 低いうなり（わずかにずれた2つの音でゆっくりうねる）
    const nodes: AudioScheduledSourceNode[] = [];
    for (const [f, v] of [[55, 0.05], [55.7, 0.04], [82.4, 0.015]] as const) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = v;
      o.connect(og).connect(g);
      o.start();
      nodes.push(o);
    }
    // 残り火のはぜる音と、遠くの風
    const len = ctx.sampleRate * 5;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b = 0;
    for (let i = 0; i < len; i++) {
      b = (b + (Math.random() * 2 - 1) * 0.01) * 0.998;
      d[i] = b * 2 + (Math.random() < 0.0009 ? (Math.random() - 0.5) * 0.9 : 0);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1400;
    f.Q.value = 0.4;
    const sg = ctx.createGain();
    sg.gain.value = 0.25;
    src.connect(f).connect(sg).connect(g);
    src.start();
    nodes.push(src);
    this.eerie = { nodes, gain: g };
  }

  /** 焼け跡の環境音をやめて、店内の環境音に戻す */
  stopEerie(restoreAmbience = false): void {
    if (this.eerie) {
      for (const n of this.eerie.nodes) {
        try {
          n.stop();
        } catch {
          // すでに止まっている
        }
      }
      this.eerie.gain.disconnect();
      this.eerie = null;
    }
    if (restoreAmbience) this.startAmbience();
  }

  /** 爆発（閃光と同時）: 低い衝撃音・破片の音・耳鳴り */
  private explosion(): void {
    this.noise(2.6, 180, 0.4, 0.9, 'lowpass');
    this.tone(48, 1.8, 'sine', 0.6, -20);
    this.noise(1.2, 2600, 0.6, 0.25, 'bandpass', 0.05);
    for (let i = 0; i < 8; i++) this.tone(1800 + Math.random() * 2400, 0.06, 'triangle', 0.05, 0, 0.3 + Math.random() * 1.4);
    // 耳鳴り（気を失っていく）
    this.tone(3800, 4.5, 'sine', 0.03, 0, 0.6);
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
        case 'buzzStart':
          // スマホの通知音が重なって鳴る
          for (let i = 0; i < 5; i++) {
            this.tone(1568, 0.07, 'sine', 0.07, 0, i * 0.22);
            this.tone(2093, 0.09, 'sine', 0.06, 0, i * 0.22 + 0.08);
          }
          break;
        case 'criticPublished':
          [659, 880, 1175].forEach((f, i) => this.tone(f, 0.16, 'triangle', 0.08, 0, i * 0.12));
          break;
        case 'complaintResolved':
          this.tone(740, 0.1, 'triangle', 0.05);
          break;
        case 'complaintRejected':
        case 'complaintRefused':
          this.tone(196, 0.3, 'sawtooth', 0.05, -40);
          break;
        case 'accidentWarning':
          // ガスの漏れる音と警報
          this.noise(5, 5200, 0.8, 0.06, 'highpass');
          for (let i = 0; i < 8; i++) this.tone(i % 2 ? 660 : 880, 0.25, 'square', 0.05, 0, i * 0.5);
          break;
        case 'explosion':
          this.explosion();
          this.startEerie();
          break;
        // 隠し扉と武器庫（じろ1 5.12）
        case 'armoryOpen':
        case 'armoryClose':
          this.noise(0.5, 300, 2, 0.08, 'lowpass');
          this.tone(110, 0.4, 'triangle', 0.04, -30);
          break;
        case 'weaponTake':
          this.tone(1800, 0.08, 'triangle', 0.05);
          break;
        case 'weaponHit':
          this.noise(0.12, 500, 1, 0.25, 'lowpass');
          this.tone(90, 0.15, 'sine', 0.2, -40);
          break;
        case 'gunshot':
          this.noise(0.25, 1800, 0.6, 0.45, 'bandpass');
          this.tone(70, 0.2, 'sine', 0.35, -40);
          break;
        case 'bombThrow':
          this.noise(0.3, 3000, 1, 0.05, 'highpass');
          break;
        case 'bombBlast':
          this.explosion();
          break;
        case 'hurt':
          if (this.throttle('hurt', 0.3)) this.tone(880, 0.35, 'sawtooth', 0.06, 500);
          break;
        case 'incident':
          for (let i = 0; i < 4; i++) this.tone(i % 2 ? 740 : 980, 0.3, 'sawtooth', 0.04, 0, i * 0.3);
          break;
        case 'policeSiren':
          // パトカーが走って来る（サイレン ピーポー）
          for (let i = 0; i < 10; i++) this.tone(i % 2 ? 770 : 960, 0.45, 'square', 0.05, 0, i * 0.45);
          break;
        case 'police':
          // 止まって扉を開ける
          this.tone(180, 0.12, 'square', 0.05, 90);
          this.tone(150, 0.1, 'square', 0.04, 80, 0.25);
          break;
        case 'chaos':
        case 'chaosFx':
          this.chaosSound(ev.text ?? '');
          break;
        case 'legend':
          // 店の伝説（じろ7 Phase 7）: ランクが高いほど華やかなファンファーレ
          if (this.throttle('legend', 1)) {
            const notes = ev.text === 'myth' || ev.text === 'legend' ? [523, 659, 784, 1046, 1318] : [523, 659, 784];
            notes.forEach((f, i) => this.tone(f, 0.28, 'triangle', 0.07, 0, i * 0.12));
          }
          break;
        case 'videoPosted':
          if (ev.text === 'flame') this.tone(220, 0.5, 'sawtooth', 0.05, -80);
          else if (ev.text === 'viral' || ev.text === 'hit') [880, 1175, 1568].forEach((f, i) => this.tone(f, 0.16, 'sine', 0.06, 0, i * 0.08));
          break;
        case 'chaosReact':
          // まわりの客の反応: 撮影はシャッターの音、驚きは短い高い音（立て続けには鳴らさない）
          if (ev.text === 'film' && this.throttle('shutter', 0.6)) this.noise(0.05, 4000, 2, 0.08, 'bandpass');
          else if (ev.text === 'surprise' && this.throttle('surprise', 1.2)) this.tone(720, 0.18, 'sine', 0.05, 240);
          break;
        case 'accidentReset':
          this.stopEerie(true);
          [523, 784, 1046].forEach((f, i) => this.tone(f, 0.25, 'sine', 0.07, 0, i * 0.14));
          break;
        default:
          break;
      }
    }
  }
}
