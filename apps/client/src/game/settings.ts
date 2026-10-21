// 設定（端末ごと）。localStorage が使えない環境でも既定値で動く。

export interface Settings {
  sound: boolean;
  volume: number;
  /** コールなどの声を音声合成で読み上げる */
  voice: boolean;
  lookSensitivity: number;
  invertY: boolean;
  quality: 'low' | 'medium' | 'high';
  playerName: string;
  /** 初回チュートリアルを見たか */
  tutorialSeen: boolean;
  lastSlot: number;
}

const KEY = 'jiro.settings';

export const DEFAULT_SETTINGS: Settings = {
  sound: true,
  volume: 0.7,
  voice: true,
  lookSensitivity: 1,
  invertY: false,
  quality: 'medium',
  playerName: '店主',
  tutorialSeen: false,
  lastSlot: 1,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const v = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...v };
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
