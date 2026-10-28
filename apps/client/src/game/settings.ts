// 設定（端末ごと）。localStorage が使えない環境でも既定値で動く。

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
