// 設定（端末ごと）。localStorage が使えない環境でも既定値で動く。

import type { EventSlowConfig } from '@jiro/core';

export interface Settings {
  sound: boolean;
  volume: number;
  /** コールなどの声を音声合成で読み上げる */
  voice: boolean;
  lookSensitivity: number;
  invertY: boolean;
  quality: 'low' | 'medium' | 'high';
  /** 動作の重さ（fps・1フレームの処理時間・描画の解像度）を画面に出す */
  showFps: boolean;
  playerName: string;
  /** 初回チュートリアルを見たか */
  tutorialSeen: boolean;
  /** 「ホーム画面に追加すると全画面で遊べる」を案内したか */
  homeTipShown: boolean;
  lastSlot: number;
  /** 決まったイベントが起きたら倍速を解除し、終わるまでその速さにする（オーナーの判断 2026-11-13。初期はオン） */
  slowOnEvents: boolean;
  /** 解除したときの速さ（1 = 等倍、2 = 2倍。もともと遅いときはそのまま） */
  slowSpeed: number;
  /** 最後のゲーム速度（次の日・次に始めたときもそのまま。イベントで等倍に戻ったら等倍） */
  gameSpeed: number;
}

const KEY = 'jiro.settings';

export const DEFAULT_SETTINGS: Settings = {
  sound: true,
  volume: 0.7,
  voice: true,
  lookSensitivity: 1,
  invertY: false,
  quality: 'medium',
  showFps: false,
  playerName: '店主',
  tutorialSeen: false,
  homeTipShown: false,
  lastSlot: 1,
  slowOnEvents: true,
  slowSpeed: 1,
  gameSpeed: 1,
};

/** 倍速の解除の設定（GameHost に渡す形） */
export function slowConfigOf(s: Settings): EventSlowConfig {
  return { on: s.slowOnEvents, speed: s.slowSpeed === 2 ? 2 : 1 };
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const v = JSON.parse(raw) as Partial<Settings>;
    const out = { ...DEFAULT_SETTINGS, ...v };
    // 前の版の「解除するイベントの選択」は使わない（解除するイベントは決まっている。オーナーの指示 2026-11-13）
    delete (out as Partial<Settings> & { slowEvents?: unknown }).slowEvents;
    if (out.slowSpeed !== 2) out.slowSpeed = 1;
    return out;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // 保存できなくてもゲームは続行
  }
}
