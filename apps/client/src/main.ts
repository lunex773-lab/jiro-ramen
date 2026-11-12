// エントリーポイント
import './styles.css';
import { BALANCE, CHAOS, CHAOS_KINDS } from '@jiro/core';
import { App } from './game/app';

// 自動のテスト（E2E）の間だけ、偶然の爆発事故（初回は1日1.0%）と珍客イベントを止める。何日も営業するテストが偶然で失敗しないように。
// ブラウザの自動操作（navigator.webdriver）で、テストが印を付けたときだけ。開発用の欄からの爆発（強制）はそのまま起こせる
try {
  if (navigator.webdriver && localStorage.getItem('jiro.test.noRandomAccident') === '1') {
    (BALANCE.events.explosion as { firstChancePerDay: number }).firstChancePerDay = 0;
    // 珍客イベント（じろ7 6-5）も偶然には起こさない（開発用の欄からの強制はそのまま起こせる）
    for (const k of CHAOS_KINDS) (CHAOS[k] as { dayChance: number }).dayChance = 0;
  }
} catch {
  // localStorage が使えないときは何もしない
}

const mount = document.getElementById('app');
if (!mount) throw new Error('#app がありません');
const app = new App(mount);
app.showTitle();

// デバッグ・E2E テスト用（本番の動作には影響しない）
(window as unknown as { __jiro?: App }).__jiro = app;
