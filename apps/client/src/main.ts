// エントリーポイント
import './styles.css';
import { App } from './game/app';

const mount = document.getElementById('app');
if (!mount) throw new Error('#app がありません');
const app = new App(mount);
app.showTitle();

// デバッグ・E2E テスト用（本番の動作には影響しない）
(window as unknown as { __jiro?: App }).__jiro = app;
