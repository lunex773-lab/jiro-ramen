// アプリ全体の流れ: タイトル → スロット選択 → 店内（一人称）→ 営業終了 → 経営 → 翌日 …

import {
  arrestOf,
  playerDowned,
  WEAPONS,
  BALANCE,
  createGame,
  incidentToday,
  policeCarDoor,
  policeCarSeat,
  stageOf,
  locationProblem,
  setStoreLocation,
  equipmentCenter,
  resolveTarget,
  seatCounterPoint,
  targetPoints,
  tutorialTarget,
  deleteSlot,
  listSlots,
  loadFromSlot,
  moveWithCollision,
  saveToSlot,
  type GameState,
  type SaveStore,
  overdueShortfall,
  storeReport,
} from '@jiro/core';
import { Sfx } from '../audio/sfx';
import { World } from '../render/world';
import { alertDialog, choiceDialog, confirmDialog, h, replace, toast } from '../ui/dom';
import { Hud } from '../ui/hud';
import { openStoreMap } from '../ui/store-map';
import { LayoutEditor } from '../ui/layout-editor';
import { ManageMenu } from '../ui/manage';
import { TutorialPanel } from '../ui/tutorial';
import { AccidentOverlay, accidentView } from '../ui/accident';
import { RequestPrompt } from '../ui/request';
import { showCriticReport } from '../ui/critic';
import { bankruptScreen, helpScreen, noReportScreen, resultScreen, settingsScreen, slotScreen, titleScreen, type ResultCallbacks } from '../ui/screens';
import { Controls } from './controls';
import { nextHint } from './guide';
import { LocalHost, type GameHost } from './host';
import { isRotated, isStandalone, lockLandscape } from './orientation';
import { loadSettings, saveSettings, slowConfigOf, type Settings } from './settings';
import { findFocus, interactableBoxes } from './targeting';
import { openLobby } from '../ui/lobby';
import { MarketScreen, openMarketLobby } from '../ui/market';
import { MarketHost, MarketSession, prepareState } from './market-play';
import { RankingScreen } from '../ui/ranking';
import type { Api, Auth } from '../net/api';
import { installRotatedScroll } from '../ui/rotated-scroll';

export const VERSION = '0.9.0';

/** localStorage を SaveStore として使う（使えない環境ではメモリ） */
export class BrowserStore implements SaveStore {
  private mem = new Map<string, string>();
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return this.mem.get(key) ?? null;
    }
  }
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      this.mem.set(key, value);
      throw e;
    }
  }
  remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      this.mem.delete(key);
    }
  }
}

export class App {
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly overlay: HTMLElement;
  readonly uiLayer: HTMLElement;
  readonly store = new BrowserStore();
  readonly sfx = new Sfx();
  settings: Settings = loadSettings();
  private world: World | null = null;
  private controls: Controls | null = null;
  private hud: Hud | null = null;
  private manage: ManageMenu | null = null;
  private editor: LayoutEditor | null = null;
  host: GameHost | null = null;
  slot = 1;
  private screenEl: HTMLElement | null = null;
  private hintEl: HTMLElement;
  private raf = 0;
  private lastT = 0;
  private lastPhase = '';
  /** 前のフレームのゲーム速度（等倍に戻ったことに気づくため） */
  private lastSpeed = 1;
  /** 共通市場: 企業間の貸し借りのお金を受け取る間隔のタイマー */
  private creditTimer: number | null = null;
  private pausedForMenu = false;
  /** 共通市場の企業を端末で営業している（会社の状態はサーバー。端末のスロットには保存しない） */
  private marketPlay: { session: MarketSession; api: Api; auth: Auth; marketId: string } | null = null;
  /** サーバーへ1日を送っている間（時間を止め、操作できないようにする） */
  private marketBusy: HTMLElement | null = null;
  /** 共通市場: 営業の結果を送っている最中・送信の状態の表示（結果の画面の中）・途中のセーブ（じろ7 4・5） */
  private sending = false;
  private sendStatusEl: HTMLElement | null = null;
  private sendRetry: number | null = null;
  private cloudTimer: number | null = null;
  private cloudSaving = false;
  private lastCloudVersion = -1;
  private cloudStatusEl: HTMLElement | null = null;
  private cloudHide: number | null = null;
  private localPos = { x: 0, z: 0 };
  private moveSendAcc = 0;
  private unsub: (() => void)[] = [];
  private onLeaveGame: (() => void) | null = null;
  private tutorial: TutorialPanel | null = null;
  /** 爆発事故の画面の演出 */
  private accidentUi: AccidentOverlay | null = null;
  private requestPrompt: RequestPrompt | null = null;
  private lastAccidentId: string | null = null;
  private accidentMode = false;
  private arrestMode = false;
  private arrestFadeEl: HTMLElement | null = null;
  private arrestFade = 0;
  private lastArrestPos = { x: 0, z: 0 };
  /** 表示済みの覆面調査員の記事 */
  private shownCritics = new Set<string>();
  /** チュートリアルで目立たせている対象（変わったときだけ画面を更新する） */
  private tutorialHi = '';
  /** 注視対象は 1 秒に 10 回求める（毎フレームは要らない） */
  private focusAcc = 0;
  /** 動作の重さの表示（設定で ON のとき） */
  private fpsEl: HTMLElement;
  private fpsAcc = 0;
  private fpsFrames = 0;
  private fpsWork = 0;
  /** 下の帯（案内・チュートリアル）の高さ。大きさが変わったときだけ測る */
  private stripObserver: ResizeObserver | null = null;
  private stripH = -1;

  constructor(mount: HTMLElement) {
    this.root = mount;
    this.root.classList.add('app');
    this.canvas = h('canvas', { class: 'game-canvas' });
    this.overlay = h('div', { class: 'overlay3d' });
    this.uiLayer = h('div', { class: 'ui-layer' });
    this.hintEl = h('div', { class: 'hint', hidden: true });
    this.fpsEl = h('div', { class: 'fps', hidden: true });
    this.root.append(this.canvas, this.overlay, this.uiLayer, this.fpsEl);
    if (typeof ResizeObserver !== 'undefined') {
      this.stripObserver = new ResizeObserver(() => this.updateStrip());
      this.stripObserver.observe(this.hintEl);
    }
    this.applySettings();
    // 表示を回しているときは、メニューなどのスクロールを指の向きに合わせて自分で動かす
    installRotatedScroll(this.root);
    // 横画面に固定する（縦向きのスマホでは表示ごと 90° 回す）。回し方が変わったら操作中の指を離し、描画サイズを合わせ直す
    lockLandscape(this.root, () => {
      this.controls?.releaseAll();
      this.world?.resize();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'hidden') return;
      this.autosave('hidden');
      // 共通市場: 画面を閉じる・切り替えるときに途中のセーブ（じろ7 4）
      void this.cloudSave('hidden');
    });
    // 通信が戻ったら、送信待ちの日を送る（じろ7 5-5）
    window.addEventListener('online', () => void this.retryPendingSend());
    window.addEventListener('pagehide', () => this.autosave('hidden'));
    // iOS の音声制限: 最初のタッチで有効化
    const unlock = () => this.sfx.unlock();
    window.addEventListener('pointerdown', unlock, { once: false, passive: true });
  }

  applySettings(): void {
    this.sfx.enabled = this.settings.sound;
    this.sfx.voice = this.settings.voice;
    this.sfx.setVolume(this.settings.volume);
    if (this.controls) this.controls.settings = { lookSensitivity: this.settings.lookSensitivity, invertY: this.settings.invertY };
    this.world?.setQuality(this.settings.quality);
    if (this.host) this.host.slow = slowConfigOf(this.settings);
  }

  // ───────────────── 画面 ─────────────────

  private show(el: HTMLElement | null): void {
    this.screenEl?.remove();
    this.screenEl = el;
    if (el) this.uiLayer.appendChild(el);
  }

  showTitle(): void {
    this.leaveGame();
    this.show(
      titleScreen(
        {
          onSingle: () => this.showSlots(),
          onTutorial: () => this.startTutorialOnly(),
          onMulti: () => this.showLobby(),
          onMarket: () => this.showMarketLobby(),
          onHelp: () => this.showHelp(() => this.showTitle()),
          onSettings: () => this.showSettings(() => this.showTitle()),
        },
        VERSION,
      ),
    );
    this.offerHomeScreenTip();
  }

  /** Safari で表示を回して遊んでいるときに一度だけ: ホーム画面から開くと Safari のバーが出ず、操作が安定する */
  private offerHomeScreenTip(): void {
    if (this.settings.homeTipShown || !isRotated() || isStandalone()) return;
    this.settings.homeTipShown = true;
    saveSettings(this.settings);
    void alertDialog(
      this.uiLayer,
      '全画面で遊ぶには',
      'Safari の共有ボタン（□に↑）→「ホーム画面に追加」で追加したアイコンから開くと、Safari のバーが出ない全画面で遊べます。画面の端を触ったときにバーが出てタップが効かなかったり、前のページに戻ったりすることがなくなります。',
      'わかった',
    );
  }

  showSlots(): void {
    const slots = listSlots(this.store);
    this.show(
      slotScreen(this.uiLayer, slots, {
        onBack: () => this.showTitle(),
        onDelete: (slot) => {
          deleteSlot(this.store, slot);
          this.showSlots();
        },
        onContinue: (slot) => {
          const r = loadFromSlot(this.store, slot);
          if (!r.ok) {
            toast(this.uiLayer, r.error, 'danger');
            return;
          }
          if (r.fromBackup) toast(this.uiLayer, '本体のデータが壊れていたため、バックアップから復旧しました', 'warn', 5000);
          if (r.migrated) toast(this.uiLayer, '古いバージョンのデータを変換しました', 'info');
          this.startLocal(r.file.state, slot);
        },
        onNew: async (slot, shopName) => {
          const tutorial = await confirmDialog(
            this.uiLayer,
            'チュートリアル（営業0日目）',
            'ラーメンの作り方と店の経営を、手順に沿って練習できます（10分ほど）。練習の売上や評判は本番に残りません。タイトルの「チュートリアル」からいつでもやり直せます。',
            'チュートリアルから始める',
            false,
            'スキップして1日目から',
          );
          const s = createGame({ shopName, playerName: this.settings.playerName, tutorial });
          // 1店目の場所を地図で選ぶ（オーナーの判断。「あとで決める」もできる。決めるまで標準の数字）
          const code = await this.pickHomeLocation();
          if (code) setStoreLocation(s, s.company.stores[0]!.id, code);
          this.slot = slot;
          const r = saveToSlot(this.store, slot, s);
          if (!r.ok) toast(this.uiLayer, r.error, 'danger');
          this.startLocal(s, slot);
          if (tutorial) {
            this.settings.tutorialSeen = true;
            saveSettings(this.settings);
          } else if (!this.settings.tutorialSeen) {
            this.settings.tutorialSeen = true;
            saveSettings(this.settings);
            this.showHelp(() => this.show(null));
          }
        },
      }),
    );
  }

  /** 1店目の場所を地図で選ぶ（選ばなければ null） */
  private pickHomeLocation(): Promise<string | null> {
    return new Promise((resolve) => {
      const map = openStoreMap(this.uiLayer, {
        title: '1店目の場所を選ぶ',
        mode: 'city',
        confirmLabel: 'この街で始める',
        closeLabel: 'あとで決める',
        cityInfo: (code) => ({ lines: ['人口の多い街は客が少し多く、家賃も少し高くなります。あとで変えられません（あとで決めることはできます）。'], problem: locationProblem(code) }),
        onPick: ({ code }) => {
          map.close();
          resolve(code);
        },
        onClose: () => resolve(null),
      });
    });
  }

  showHelp(back: () => void): void {
    this.show(helpScreen(back, this.controls?.isTouch ?? matchMedia('(pointer: coarse)').matches));
  }

  /** 設定の画面（タイトルへ戻るのは経営メニュー「セーブ・設定」のボタンだけ。爆発事故はランダムで起きるもの。起こすボタンは開発用の欄 ?debug=1 だけ） */
  showSettings(back: () => void, inGame = false): void {
    const remote = this.host?.mode === 'remote';
    this.show(
      settingsScreen(
        this.settings,
        (st) => {
          const renamed = st.playerName !== this.settings.playerName;
          this.settings = st;
          saveSettings(st);
          this.applySettings();
          // プレイヤー名: ひとりプレイでは店の中の名前もすぐ変える（以前は次に始めたときまで変わらなかった）
          if (renamed && inGame && this.host?.mode === 'local') {
            const me = this.host.state.players.find((p) => p.id === this.host!.playerId);
            if (me) me.name = st.playerName;
          }
        },
        back,
        inGame ? { nameNote: remote ? '共同経営の間に変えた名前は、次に参加したときから使われます。' : undefined } : undefined,
      ),
    );
  }

  showLobby(): void {
    this.leaveGame();
    const el = openLobby(this, () => this.showTitle());
    this.show(el);
  }

  /** オンライン市場の入口（作る・招待コードで入る・参加している市場） */
  showMarketLobby(): void {
    this.leaveGame();
    this.show(openMarketLobby(this, () => this.showTitle()));
  }

  /** オンライン市場の画面（サーバーの市場を読み直しながら経営する） */
  showMarket(api: Api, auth: Auth, marketId: string): void {
    this.leaveGame();
    const screen = new MarketScreen(
      this.uiLayer,
      api,
      auth,
      marketId,
      () => this.showMarketLobby(),
      () => void this.startMarketPlay(api, auth, marketId),
      () => this.showRanking(api, auth, marketId),
    );
    this.show(screen.el);
  }

  /**
   * 共通市場の企業を端末で営業する（サーバーの会社の状態を読み、その日の条件をもらって始める）。
   * 日の終わり（次の日へ）にその日を送る（commitMarketDay）
   */
  async startMarketPlay(api: Api, auth: Auth, marketId: string): Promise<void> {
    const session = new MarketSession(api, auth, marketId);
    let r: Awaited<ReturnType<MarketSession['begin']>>;
    try {
      r = await session.begin();
    } catch (e) {
      toast(this.uiLayer, (e as Error)?.message ?? '始められませんでした', 'danger', 5000);
      return;
    }
    if (!r.ok) {
      const waiting = r.code === 'sync_pending' || r.code === 'syncing';
      await alertDialog(
        this.uiLayer,
        waiting ? '0時の計算中です' : r.code === 'pending' ? '送信待ちの日があります' : '営業を始められません',
        waiting ? '日付が変わったので、全社の日付をそろえる計算をしています。終わるまで新しい日は始められません。' : r.message,
        'わかった',
      );
      return;
    }
    this.slot = 0;
    const me = r.state.players[0];
    if (me) {
      me.connected = true;
      me.lastMoveAt = 0;
      if (this.settings.playerName) me.name = this.settings.playerName;
    }
    this.startGame(new MarketHost(r.state, me?.id ?? 'p1', session));
    this.marketPlay = { session, api, auth, marketId };
    // 企業間の貸し借りのお金（すぐ反映）: 数秒ごとに受け取る
    session.onCredit = (rs) => {
      for (const r of rs) {
        const yen = `¥${Math.abs(r.amount).toLocaleString('ja-JP')}`;
        if (!r.applied) toast(this.uiLayer, `💴 ${r.memo}: お金が足りず、できませんでした（${yen} が要ります）`, 'warn', 4000);
        else toast(this.uiLayer, r.amount > 0 ? `💴 ${r.memo}: ${yen} が入りました` : `💴 ${r.memo}: ${yen} を払いました`, r.amount > 0 ? 'good' : 'info', 3500);
      }
    };
    if (this.creditTimer !== null) clearInterval(this.creditTimer);
    this.creditTimer = window.setInterval(() => {
      if (this.marketPlay?.session === session && this.host) void session.syncCredits(this.host.state);
    }, 5000);
    session.onStale = () => {
      if (this.marketPlay?.session !== session) return;
      toast(this.uiLayer, 'サーバーの会社の状態が新しくなっていたため、読み直します（企業間の貸し借りのお金など）', 'info', 4000);
      void this.startMarketPlay(api, auth, marketId);
    };
    // 送信待ちだった日を送った結果
    if (r.sentPending && !r.sentPending.ok) toast(this.uiLayer, `送信待ちだった日は受け取られませんでした（${r.sentPending.reason ?? ''}）。サーバーの状態から続けます`, 'warn', 6000);
    else if (r.sentPending?.gameDate) toast(this.uiLayer, `送信待ちだった${r.sentPending.gameDate}日目を送りました`, 'good', 3000);
    if (r.resumed) {
      const at = new Date(r.resumed.savedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
      toast(this.uiLayer, `途中のセーブ（${at}に保存・${r.resumed.day}日目）から続けます`, 'good', 4000);
    } else if (r.state.phase === 'closed') toast(this.uiLayer, `${r.state.day}日目の営業データは確定済みです。閉店後の作業のあと、次の日へ進めます`, 'info', 4000);
    else toast(this.uiLayer, `${r.ticket.gameDate}日目の営業（営業が終わったらサーバーへ送ります）`, 'info', 3000);
    // 途中のセーブ: 2分ごと（変わっていれば）。開店・次の日へ・画面を閉じるとき・手動でも保存する（じろ7 4-3）
    this.lastCloudVersion = r.resumed ? r.state.version : -1;
    if (this.cloudTimer !== null) clearInterval(this.cloudTimer);
    this.cloudTimer = window.setInterval(() => void this.cloudSave('auto'), 120_000);
  }

  /** 途中のセーブ（共通市場。じろ7 4）。保存がサーバーで確かめられるまで「保存しました」と出さない */
  private async cloudSave(kind: 'auto' | 'event' | 'manual' | 'hidden'): Promise<boolean> {
    const mp = this.marketPlay;
    const host = this.host;
    if (!mp || !host || this.cloudSaving) return false;
    if (host.state.phase === 'bankrupt') return false;
    if ((kind === 'auto' || kind === 'hidden') && host.state.version === this.lastCloudVersion) return true;
    if (!mp.session.ticket) {
      if (kind === 'manual') toast(this.uiLayer, 'その日の営業データを送ったあと、次の日を始めると保存できます', 'info', 4000);
      return false;
    }
    this.cloudSaving = true;
    this.setCloudStatus('saving', '☁ 保存中…');
    const v = host.state.version;
    try {
      const r = await mp.session.saveCheckpoint(host.state);
      if (this.host !== host) return false;
      if (r.ok) {
        this.lastCloudVersion = v;
        const at = new Date(r.savedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
        this.setCloudStatus('saved', `☁ 保存しました（${at}）`);
        if (kind === 'manual') toast(this.uiLayer, `途中の状態をサーバーに保存しました（${at}）`, 'good', 2500);
        return true;
      }
      if (r.code === 'network') this.setCloudStatus('error', '☁ 保存できません（通信を確かめてください。2分後にもう一度保存します）');
      else this.setCloudStatus('error', `☁ 保存できません: ${r.message}`);
      return false;
    } finally {
      this.cloudSaving = false;
    }
  }

  /** 途中のセーブの状態の表示（画面の左下。保存しましたは少しで消える） */
  private setCloudStatus(kind: 'saving' | 'saved' | 'error', text: string): void {
    if (!this.cloudStatusEl) {
      this.cloudStatusEl = h('div', { class: 'cloud-status', 'data-cloud-status': '', role: 'status' });
      this.uiLayer.appendChild(this.cloudStatusEl);
    }
    const el = this.cloudStatusEl;
    el.className = `cloud-status ${kind}`;
    el.dataset.cloudStatus = kind;
    el.textContent = text;
    el.hidden = false;
    if (this.cloudHide !== null) clearTimeout(this.cloudHide);
    this.cloudHide = kind === 'saved' ? window.setTimeout(() => (el.hidden = true), 4000) : null;
  }

  /** 営業の結果の送信の状態（結果の画面の上。じろ7 14-4: 集計中・送信中・サーバー確認中・確定済み・送信待ち） */
  private setSendStatus(kind: 'aggregate' | 'sending' | 'done' | 'pending' | 'error', text: string, retry = false): void {
    const el = this.sendStatusEl;
    if (!el) {
      if (kind === 'pending' || kind === 'error') toast(this.uiLayer, text, 'warn', 5000);
      return;
    }
    el.className = `send-status ${kind}`;
    el.dataset.sendStatus = kind;
    replace(el, h('span', null, text), retry ? h('button', { class: 'btn mini', 'data-send-retry': '', onclick: () => void this.finalizeAndSend() }, 'もう一度送る') : null);
  }

  /** 送信待ちの日があれば送る（通信が戻ったとき・一定時間ごと） */
  private async retryPendingSend(): Promise<void> {
    const mp = this.marketPlay;
    const host = this.host;
    if (!mp || !host || this.sending || !mp.session.hasPending()) return;
    if (host.state.phase === 'closed') await this.finalizeAndSend();
  }

  /**
   * 営業の終わり（閉店して精算したあと）に、その日の結果を確定して市場へ送る（じろ7 5-2）。
   * 集計（その日の結果を確定）→ 送る前に端末へ送信待ちとして残す → 送信 → サーバーが確かめて受け取る → 確定済み。
   * 送れなければ送信待ちのまま（通信が戻ったら・30秒ごとに送り直す）。受け取られたら次の日の条件をもらう。確定済みなら true
   */
  private async finalizeAndSend(): Promise<boolean> {
    const mp = this.marketPlay;
    const host = this.host;
    if (!mp || !host || host.state.phase !== 'closed') return false;
    const s = host.state;
    if (mp.session.committedDay === s.day && !mp.session.hasPending()) {
      this.setSendStatus('done', `確定済み: ${s.day}日目の営業データは市場に送ってあります`);
      return true;
    }
    if (this.sending) return false;
    this.sending = true;
    try {
      this.setSendStatus('aggregate', `集計中…（${s.day}日目の営業の結果を確定しています）`);
      if (s.finalizedDay !== s.day) {
        const f = await host.act({ type: 'finalizeDay' });
        if (!f.ok) {
          this.setSendStatus('error', f.reason ?? 'その日の結果を確定できませんでした');
          return false;
        }
      }
      this.setSendStatus('sending', '送信中…（サーバーが確かめています）');
      const pend = mp.session.pending();
      const r = pend ? await mp.session.flushPending() : await mp.session.commit(host.state);
      if (this.host !== host) return false;
      if (!r.ok && r.code === 'network') {
        this.setSendStatus('pending', `送信待ち: ${s.day}日目の営業データを送れていません（${r.reason}）。この端末に残してあり、通信が戻ると自動で送ります`, true);
        if (this.sendRetry === null) this.sendRetry = window.setInterval(() => void this.retryPendingSend(), 30_000);
        return false;
      }
      if (this.sendRetry !== null) clearInterval(this.sendRetry);
      this.sendRetry = null;
      if (!r.ok) {
        const reasons = 'reject' in r && r.reject ? r.reject.slice(0, 3).join('・') : '';
        this.setSendStatus('error', `受け取られませんでした: ${r.reason ?? ''}`);
        await alertDialog(this.uiLayer, 'この日は受け取られませんでした', `${r.reason ?? ''}${reasons ? `（${reasons}）` : ''}`, 'サーバーの状態からやり直す');
        await this.startMarketPlay(mp.api, mp.auth, mp.marketId);
        return false;
      }
      this.setSendStatus('done', `確定済み: ${r.gameDate ?? s.day}日目の営業データを市場に送りました${r.duplicate ? '（送信済みでした）' : ''}`);
      if (r.flags && r.flags.length > 0) toast(this.uiLayer, 'この日は上限を超える値があったため、順位には数えられません', 'warn', 6000);
      // 次の日の条件をもらう（0時の計算中なら、開店するときにもう一度もらう）
      const t = await mp.session.startTicket();
      if (this.host !== host) return true;
      if (!t.ok && t.code === 'stale') {
        await this.startMarketPlay(mp.api, mp.auth, mp.marketId);
        return false;
      }
      if (!t.ok && (t.code === 'sync_pending' || t.code === 'syncing')) toast(this.uiLayer, '0時の計算中です。次の日は、計算が終わってから開店できます', 'info', 5000);
      return true;
    } finally {
      this.sending = false;
    }
  }

  /** 共通市場の「翌日の仕込みへ」: 営業の結果を確定・送信してから、端末で次の日の朝へ進む（送るのは営業の終わり。じろ7 5） */
  private async marketNextDay(): Promise<void> {
    const host = this.host;
    if (!host) return;
    if (!(await this.finalizeAndSend())) {
      if (this.marketPlay?.session.hasPending()) toast(this.uiLayer, '送信待ちの日を送れるまで、次の日には進めません', 'warn', 4000);
      return;
    }
    const res = await host.act({ type: 'nextDay' });
    if (res.ok) {
      this.afterMarketNextDay();
      return;
    }
    // 破産した日はサーバーへ送ってから市場の画面へ
    if ((host.state.phase as string) === 'bankrupt') {
      await this.commitMarketDay();
      return;
    }
    if (host.state.phase === 'closed' && overdueShortfall(host.state)) {
      await this.resolveOverdue();
      return;
    }
    toast(this.uiLayer, res.reason ?? '進めません', 'danger', 5000);
    this.openManage('dash');
  }

  /** 端末で次の日の朝へ進んだあと（共通市場）: その日の条件を入れ、途中のセーブ */
  private afterMarketNextDay(): void {
    const mp = this.marketPlay;
    const host = this.host;
    if (!mp || !host) return;
    if (mp.session.ticket) prepareState(host.state, mp.session.ticket);
    void this.cloudSave('event');
  }

  /** ランキングの画面（コミュニティ・全体。閉じると市場の画面へ） */
  showRanking(api: Api, auth: Auth, marketId: string): void {
    this.leaveGame();
    const r = new RankingScreen(api, auth, marketId, 'この市場', () => this.showMarket(api, auth, marketId));
    this.show(r.el);
  }

  /** 市場の画面へ戻る（端末の営業をやめる） */
  private backToMarket(): void {
    const mp = this.marketPlay;
    if (!mp) {
      this.showTitle();
      return;
    }
    this.showMarket(mp.api, mp.auth, mp.marketId);
  }

  private setMarketBusy(text: string | null): void {
    this.marketBusy?.remove();
    this.marketBusy = null;
    if (text === null) return;
    this.marketBusy = h('div', { class: 'market-busy', 'data-market-busy': '' }, h('div', { class: 'card' }, h('p', null, text)));
    this.marketBusy.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.uiLayer.appendChild(this.marketBusy);
  }

  /**
   * その日の営業をサーバーへ送る（次の日へ進んだあと）。送れるまで次の日は始められない（判断 1d）。
   * 受け取られなければ、サーバーの前の日の状態からやり直す（判断 1b）
   */
  private async commitMarketDay(): Promise<void> {
    const mp = this.marketPlay;
    const host = this.host;
    if (!mp || !host) return;
    this.controls?.releaseAll();
    this.setMarketBusy('その日の営業をサーバーに送っています…');
    let r: Awaited<ReturnType<MarketSession['commit']>>;
    for (;;) {
      r = await mp.session.commit(host.state);
      if (r.ok || r.code !== 'network') break;
      this.setMarketBusy(null);
      const c = await choiceDialog(this.uiLayer, '送れませんでした', `${r.reason ?? '通信できません'}。通信できるところで、もう一度送ってください（送れるまで次の日は始められません）。`, [
        { label: '市場の画面へ（この日は送られていません）', value: 'leave', kind: 'ghost' },
        { label: 'もう一度送る', value: 'retry', kind: 'primary' },
      ]);
      if (this.host !== host) return;
      if (c !== 'retry') {
        this.backToMarket();
        return;
      }
      this.setMarketBusy('その日の営業をサーバーに送っています…');
    }
    this.setMarketBusy(null);
    if (this.host !== host) return;
    if (!r.ok) {
      const reasons = 'reject' in r && r.reject ? r.reject.slice(0, 3).join('・') : '';
      await alertDialog(this.uiLayer, 'この日は受け取られませんでした', `${r.reason ?? ''}${reasons ? `（${reasons}）` : ''}`, 'サーバーの状態からやり直す');
      await this.startMarketPlay(mp.api, mp.auth, mp.marketId);
      return;
    }
    if (r.bankrupt) {
      await alertDialog(this.uiLayer, '破産しました', '資金が尽きて、この企業は市場から消えました。', '市場の画面へ');
      this.backToMarket();
      return;
    }
    if (r.flags && r.flags.length > 0) toast(this.uiLayer, 'この日は上限を超える値があったため、順位には数えられません', 'warn', 6000);
    // 次の日の条件
    const t = await mp.session.startTicket();
    if (this.host !== host) return;
    if (!t.ok) {
      if (t.code === 'stale') {
        await this.startMarketPlay(mp.api, mp.auth, mp.marketId);
        return;
      }
      const waiting = t.code === 'sync_pending' || t.code === 'syncing';
      await alertDialog(this.uiLayer, waiting ? '0時の計算中です' : '次の日を始められません', waiting ? `${r.gameDate}日目までを送りました。日付が変わったので、全社の日付をそろえる計算をしています。終わるまで新しい日は始められません。` : t.message, '市場の画面へ');
      this.backToMarket();
      return;
    }
    prepareState(host.state, t.ticket);
    toast(this.uiLayer, `${r.gameDate}日目を送りました。${t.ticket.gameDate}日目の営業です`, 'good', 2500);
  }

  // ───────────────── ゲーム開始・終了 ─────────────────

  startLocal(state: GameState, slot: number): void {
    this.slot = slot;
    if (slot > 0) {
      this.settings.lastSlot = slot;
      saveSettings(this.settings);
    }
    // ローカルでは自分が唯一のプレイヤー
    const me = state.players[0];
    if (me) {
      me.connected = true;
      me.lastMoveAt = 0;
      if (this.settings.playerName) me.name = this.settings.playerName;
    }
    this.startGame(new LocalHost(state, me?.id ?? 'p1'));
    // 読み込んだ（または今保存した）状態から始める
    this.lastSavedVersion = state.version;
  }

  startGame(host: GameHost, onLeave?: () => void): void {
    this.leaveGame();
    this.onLeaveGame = onLeave ?? null;
    this.host = host;
    // 倍速は前の日・前に遊んだときの速さを続ける（イベントで等倍に戻ったら等倍。オーナーの判断 2026-11-13）
    host.slow = slowConfigOf(this.settings);
    if (host.mode === 'local') {
      const sp = [1, 2, 3, 5].includes(this.settings.gameSpeed) ? this.settings.gameSpeed : 1;
      const lim = host.speedLimit();
      host.speed = lim ? Math.min(sp, lim.cap) : sp;
    }
    this.lastSpeed = host.speed;
    this.show(null);
    this.world = new World(this.canvas, this.overlay, this.settings.quality);
    this.controls = new Controls(this.uiLayer, this.canvas);
    this.controls.settings = { lookSensitivity: this.settings.lookSensitivity, invertY: this.settings.invertY };
    if (this.controls.isTouch) this.root.classList.add('touch');
    this.hud = new Hud(this.uiLayer, host, {
      onMenu: () => this.openManage(),
      onOpenShop: () => void this.openShop(),
      onHelp: () => this.showHelp(() => this.show(null)),
      onFire: () => this.fireWeapon(),
    });
    this.hud.attachHint(this.hintEl);
    this.tutorial = new TutorialPanel(this.uiLayer, host, {
      onQuit: () => void this.quitTutorial(),
      onFinished: () => this.finishTutorial(),
    });
    this.stripObserver?.observe(this.tutorial.el);
    this.accidentUi = new AccidentOverlay(this.uiLayer, host);
    // ホストへの確認（YouTuber の撮影の許可・テレビ取材）
    this.requestPrompt = new RequestPrompt(this.uiLayer, host);
    this.lastAccidentId = host.state.events?.accident?.id ?? null;
    this.manage = new ManageMenu(this.uiLayer, host, {
      onClose: () => this.closeManage(),
      onLayoutEditor: () => this.openEditor(),
      onSave: () => this.saveNow(true),
      // クラウドへの保存は共通市場の企業だけ（ひとりプレイ・共同経営のクラウドセーブは廃止。オーナーの判断 2026-11-13）
      onCloudSave: () => {
        if (this.marketPlay) void this.cloudSave('manual');
      },
      onSettings: () => this.showSettings(() => this.show(null), true),
      onTitle: () => void this.returnToTitle(),
      onHelp: () => this.showHelp(() => this.show(null)),
    });
    const c = this.controls;
    c.onPrimary = (down) => this.hud?.pressIndex(0, down);
    c.onVerbKey = (i, down) => this.hud?.pressIndex(i, down);
    c.onCancel = () => void host.act({ type: 'cancelWork' });
    c.onFire = () => this.fireWeapon();
    c.fireMode = () => host.state.players.find((p) => p.id === host.playerId)?.hand.kind === 'weapon';
    c.onMenu = () => (this.manage?.isOpen ? this.closeManage() : this.openManage());
    c.onPause = () => (this.manage?.isOpen ? this.closeManage() : this.openManage());
    const me = host.state.players.find((p) => p.id === host.playerId);
    if (me) {
      this.localPos = { ...me.pos };
      c.yaw = me.yaw;
    }
    this.unsub.push(host.onEvents((ev) => this.sfx.onEvents(ev, host.playerId)));
    // 武器庫の演出（血しぶき・発砲・爆発。じろ1 5.12）
    this.unsub.push(host.onEvents((ev) => this.world?.onEvents(ev)));
    // 共同経営: ルームが終了した（ホストがタイトルに戻った など）ら、ゲストに知らせてタイトルへ戻す
    if (host.mode === 'remote') {
      let told = false;
      this.unsub.push(
        host.onStatus(() => {
          const rh = host as GameHost & { roomClosed?: boolean; lastError?: string };
          if (!rh.roomClosed || told || this.host !== host) return;
          told = true;
          void alertDialog(this.uiLayer, '共同経営が終了しました', `${rh.lastError || 'ホストがルームを終了しました'}。タイトル画面に戻ります。`, 'タイトル画面へ').then(() => {
            if (this.host === host) this.showTitle();
          });
        }),
      );
    }
    // 上部の表示（日・時刻・資金）は最初の 3D の描画を待たずに出す（重い端末では最初の描画に時間がかかる）
    this.hud.update(1);
    this.lastPhase = host.state.phase;
    this.lastT = performance.now();
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      const interval = (now - this.lastT) / 1000;
      this.lastT = now;
      const t0 = performance.now();
      this.frame(Math.min(0.1, interval), now / 1000, interval);
      this.updateFps(interval, performance.now() - t0);
    };
    // 毎フレームの処理は、下の付随する処理（音・結果画面の確認）が失敗しても必ず始める
    this.raf = requestAnimationFrame(loop);
    this.guard('ambience', () => this.sfx.startAmbience());
    this.guard('phaseScreens', () => this.checkPhaseScreens(true));
  }

  private reported = new Set<string>();

  /** 付随する処理の失敗でゲーム全体が止まらないようにする（同じ場所の失敗は一度だけ記録） */
  private guard(where: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      if (!this.reported.has(where)) {
        this.reported.add(where);
        console.error(`[jiro] ${where} failed`, e);
      }
    }
  }

  leaveGame(): void {
    cancelAnimationFrame(this.raf);
    this.marketPlay = null;
    this.setMarketBusy(null);
    if (this.cloudTimer !== null) clearInterval(this.cloudTimer);
    if (this.sendRetry !== null) clearInterval(this.sendRetry);
    if (this.creditTimer !== null) clearInterval(this.creditTimer);
    this.cloudTimer = this.sendRetry = this.creditTimer = null;
    this.cloudStatusEl?.remove();
    this.cloudStatusEl = null;
    this.sendStatusEl = null;
    this.lastCloudVersion = -1;
    for (const u of this.unsub) u();
    this.unsub = [];
    this.manage?.close();
    this.editor?.close();
    this.hud?.dispose();
    if (this.tutorial) this.stripObserver?.unobserve(this.tutorial.el);
    this.tutorial?.dispose();
    this.tutorial = null;
    this.tutorialHi = '';
    this.accidentUi?.dispose();
    this.accidentUi = null;
    this.requestPrompt?.dispose();
    this.requestPrompt = null;
    this.lastAccidentId = null;
    this.setAccidentMode(false);
    this.controls?.dispose();
    this.world?.dispose();
    this.host?.dispose();
    this.sfx.stopAmbience();
    this.hintEl.remove();
    this.fpsEl.hidden = true;
    this.manage = null;
    this.editor = null;
    this.hud = null;
    this.controls = null;
    this.world = null;
    this.host = null;
    this.root.classList.remove('touch');
    replace(this.overlay);
    const cb = this.onLeaveGame;
    this.onLeaveGame = null;
    cb?.();
  }

  /** 最後に保存した時点の状態の版（ひとりプレイ。保存していない進み具合があるかを見る） */
  private lastSavedVersion = -1;
  private leaving = false;

  /**
   * タイトル画面に戻る（第2版 21-1）。確認 →（保存していない進み具合があれば）保存するかを聞く → 終了処理 → タイトル。
   * 保存は既存の仕組み（saveNow: ひとりプレイはスロットへ、共同経営のホストはサーバーの状態をスロットへ）を使う。
   * 共同経営: ホストが戻るとサーバーがルームを終了してゲストに知らせる。ゲストが戻ってもホストとほかのゲストは続けられる
   */
  async returnToTitle(): Promise<void> {
    if (this.leaving) return;
    const host = this.host;
    if (!host) {
      this.showTitle();
      return;
    }
    if (this.marketPlay) {
      const mp = this.marketPlay;
      const committed = host.state.phase === 'closed' && mp.session.committedDay === host.state.day && !mp.session.hasPending();
      const ok = await confirmDialog(
        this.uiLayer,
        '市場の画面に戻りますか？',
        committed
          ? '今日の営業データは市場に送ってあります。閉店後の作業の続きは、サーバーに途中のセーブとして保存してから戻ります。'
          : mp.session.hasPending()
            ? '送信待ちの日があります（この端末に残してあり、次に始めるときに送ります）。'
            : '今の営業の途中の状態をサーバーに保存してから戻ります。次に始めるときは、この続きから営業できます。',
        '市場の画面に戻る',
        false,
        'キャンセル',
      );
      if (!ok || this.host !== host) return;
      // 途中のセーブ（じろ7 4「ゲーム終了・離脱時」）。保存できなければ、それでも戻るかを聞く
      const saved = mp.session.ticket ? await this.cloudSave('manual') : true;
      if (this.host !== host) return;
      if (!saved) {
        const again = await confirmDialog(this.uiLayer, '保存できませんでした', '途中の状態をサーバーに保存できませんでした。戻ると、この日はサーバーの前の日の状態（または前回の途中のセーブ）からやり直しになります。', 'それでも戻る', true, 'キャンセル');
        if (!again || this.host !== host) return;
      }
      this.backToMarket();
      return;
    }
    const remote = host.mode === 'remote';
    const body = remote
      ? host.isHost
        ? '共同経営を終了してタイトル画面に戻ります。ゲストにはお知らせが届き、ルームは終了します。'
        : '共同経営から退出してタイトル画面に戻ります。ホストとほかのゲストはそのまま続けられます。'
      : this.slot === 0
        ? 'タイトル画面に戻ります。タイトルから始めたチュートリアルは保存されません。'
        : 'タイトル画面に戻ります。';
    if (!(await confirmDialog(this.uiLayer, 'タイトル画面に戻りますか？', body, 'タイトル画面に戻る', false, 'キャンセル'))) return;
    if (this.host !== host) return;
    let save = false;
    const unsaved = this.slot !== 0 && (remote ? host.isHost : host.state.version !== this.lastSavedVersion);
    if (unsaved) {
      const c = await choiceDialog(
        this.uiLayer,
        '保存しますか？',
        remote ? `この共同経営の今の状態を、スロット${this.slot}に保存できます。` : '前回の保存のあとに進めた分（今日の売上・支出・在庫・従業員・お客さんの様子など）が保存されていません。',
        [
          { label: 'キャンセル', value: 'cancel', kind: 'ghost' },
          { label: '保存せずに戻る', value: 'discard' },
          { label: '保存して戻る', value: 'save', kind: 'primary' },
        ],
      );
      if (c === 'cancel' || this.host !== host) return;
      save = c === 'save';
    }
    this.leaving = true;
    try {
      if (save && !(await this.saveNowAsync())) {
        if (!(await confirmDialog(this.uiLayer, '保存できませんでした', '保存せずにタイトル画面に戻りますか？', '保存せずに戻る', true, 'キャンセル'))) return;
      }
      if (this.host === host) this.showTitle();
    } finally {
      this.leaving = false;
    }
  }

  /** 保存して結果を返す（タイトルへ戻る前など、保存を待つとき） */
  private async saveNowAsync(): Promise<boolean> {
    const host = this.host;
    if (!host || this.slot === 0) return false;
    if (host.mode === 'remote') {
      const rh = host as GameHost & { requestSave?: () => Promise<GameState | null> };
      const st = (await rh.requestSave?.()) ?? null;
      if (!st) return false;
      const r = saveToSlot(this.store, this.slot, st);
      if (r.ok) toast(this.uiLayer, `スロット${this.slot}に保存しました（ホスト）`, 'good');
      return r.ok;
    }
    const r = saveToSlot(this.store, this.slot, host.state);
    if (r.ok) {
      this.lastSavedVersion = host.state.version;
      toast(this.uiLayer, `スロット${this.slot}に保存しました`, 'good');
    }
    return r.ok;
  }

  /**
   * 手に持った武器を照準の先へ使う（撃つ・振る・投げる。FPS 式。オーナーの判断 2026-11-13）。
   * 今の位置を先に送ってから、向き（yaw）と上下（pitch）で使う。銃は撃つと反動で少し上を向く
   */
  private fireWeapon(): void {
    const host = this.host;
    const c = this.controls;
    if (!host || !c || !c.enabled) return;
    const me = host.state.players.find((p) => p.id === host.playerId);
    if (!me || me.hand.kind !== 'weapon') return;
    const w = WEAPONS[me.hand.weaponId];
    host.move(this.localPos.x, this.localPos.z, c.yaw);
    void host.act({ type: 'useWeapon', yaw: c.yaw, pitch: c.pitch }).then((r) => {
      if (!r.ok && r.reason && r.reason !== '少し待ってください') toast(this.uiLayer, r.reason, 'warn', 1600);
    });
    if (w?.kind === 'gun') c.pitch = Math.min(1.2, c.pitch + (w.spread ? 0.06 : 0.03));
  }

  /**
   * ゲーム速度を設定に残す（次の日・次に始めたときもそのまま）。珍しいことが起きて等倍に戻ったときは知らせる
   */
  private trackSpeed(host: GameHost): void {
    if (host.mode !== 'local' || host.speed === this.lastSpeed) return;
    // 珍しいことが起きて上限まで下がったとき（等倍か、設定で2倍）
    const lim = host.speed < this.lastSpeed ? host.speedLimit() : null;
    if (lim && host.speed === lim.cap) toast(this.uiLayer, `${lim.label}の間は${lim.cap <= 1 ? '等倍' : `×${lim.cap}`}にします`, 'info', 2500);
    this.lastSpeed = host.speed;
    if (this.settings.gameSpeed !== host.speed) {
      this.settings.gameSpeed = host.speed;
      saveSettings(this.settings);
    }
  }

  // ───────────────── 毎フレーム ─────────────────

  private frame(dt: number, t: number, interval: number): void {
    const host = this.host;
    const world = this.world;
    const c = this.controls;
    if (!host || !world || !c) return;
    const s = host.state;
    // 確認の画面（撮影の許可・取材）を開いている間も、ひとりプレイでは時間を止める
    this.requestPrompt?.update(s);
    const blocking = !!this.screenEl || this.manage?.isOpen || !!this.editor || !!this.requestPrompt?.isOpen;
    // 爆発事故: 気を失っている間は動けない。営業の画面は隠し、焼け跡を歩けるようにする
    const acc = s.events?.accident ?? null;
    const av = accidentView(acc);
    // 逮捕（オーナーの指示 2026-11-11）: 警察に取り押さえられた人は動けず、何もできない
    const arrest = arrestOf(s);
    const arrestedMe = !!arrest && arrest.attackerId === host.playerId;
    // 共同経営で仲間の武器に当たって倒れている間（5秒）は動けない
    const downedMe = playerDowned(s, host.playerId);
    c.enabled = !blocking && av.awake && !arrestedMe && !downedMe;
    this.setAccidentMode(acc?.stage === 'destroyed');
    this.setArrestMode(arrestedMe);
    // シングルプレイではメニュー中は時間を止める
    const pauseLocal = host.mode === 'local' && (blocking || s.phase === 'closed' || !!this.marketBusy);
    if (!pauseLocal) host.tick(dt);
    this.trackSpeed(host);
    c.update();
    const me = s.players.find((p) => p.id === host.playerId);
    let moving = false;
    if (me && c.enabled && !me.work) {
      const speed = BALANCE.player.walkSpeed;
      const fx = Math.sin(c.yaw);
      const fz = Math.cos(c.yaw);
      const rx = -Math.cos(c.yaw);
      const rz = Math.sin(c.yaw);
      const dx = (fx * c.forward + rx * c.strafe) * speed * dt;
      const dz = (fz * c.forward + rz * c.strafe) * speed * dt;
      if (Math.abs(dx) + Math.abs(dz) > 1e-5) {
        moving = true;
        const next = moveWithCollision(s, this.localPos, dx, dz, BALANCE.player.radius);
        this.localPos = next;
      }
    }
    if (me && arrestedMe && arrest) {
      // 視点: 警察官の方を向き、手錠をかけられるときは手元を見て、パトカーまで歩かされる。乗せられたら扉の前から車の中を見る
      const st = stageOf(s);
      const boarding = arrest.phase === 'board' || arrest.phase === 'fade';
      const door = policeCarDoor(st);
      const seat = policeCarSeat(st);
      const wantYaw = boarding ? Math.atan2(seat.x - door.x, seat.z - door.z) : me.yaw;
      const wantPitch = arrest.phase === 'cuff' ? -0.7 : arrest.phase === 'escort' ? -0.12 : boarding ? -0.2 : 0;
      const target = boarding ? door : me.pos;
      this.localPos = { x: this.localPos.x + (target.x - this.localPos.x) * Math.min(1, dt * 8), z: this.localPos.z + (target.z - this.localPos.z) * Math.min(1, dt * 8) };
      if (Math.hypot(target.x - this.localPos.x, target.z - this.localPos.z) > 3) this.localPos = { ...target };
      const dy = Math.atan2(Math.sin(wantYaw - c.yaw), Math.cos(wantYaw - c.yaw));
      c.yaw += dy * Math.min(1, dt * 3);
      c.pitch += (wantPitch - c.pitch) * Math.min(1, dt * 3);
      moving = arrest.phase === 'escort' && (me.pos.x !== this.lastArrestPos.x || me.pos.z !== this.lastArrestPos.z);
      this.lastArrestPos = { ...me.pos };
    } else if (me) {
      if (host.mode === 'local') {
        if (moving || Math.abs(me.yaw - c.yaw) > 0.01) {
          host.move(this.localPos.x, this.localPos.z, c.yaw);
          this.localPos = { ...me.pos };
        }
      } else {
        // リモート: 送信は間引き、サーバー確定位置と大きくずれたら合わせる
        this.moveSendAcc += dt;
        if (this.moveSendAcc > 0.08 && (moving || Math.abs(me.yaw - c.yaw) > 0.02)) {
          this.moveSendAcc = 0;
          host.move(this.localPos.x, this.localPos.z, c.yaw);
        }
        if (Math.hypot(me.pos.x - this.localPos.x, me.pos.z - this.localPos.z) > 1.5) this.localPos = { ...me.pos };
      }
    }
    // 横バウンスの客が店にいる間は、オリジナルのダンス曲を流す（じろ7 6-5）
    this.guard('dance', () => this.sfx.setDance(s.phase !== 'closed' && s.customers.some((x) => x.special?.kind === 'dancer' && x.state !== 'leaving' && x.state !== 'left' && x.state !== 'abandoned')));
    world.setAccident(acc);
    // 倒れている間は床から見上げる
    if (downedMe) world.setCameraFx(0, 0.32, 0.55);
    else world.setCameraFx(av.shake, av.eyeY, av.roll);
    world.setCamera(this.localPos.x, this.localPos.z, c.yaw, c.pitch, moving, dt);
    // 注視対象（自分の位置はローカル予測を使う）。1 秒に 10 回で足りる（HUD の更新も同じ間隔）
    this.focusAcc += dt;
    if (me && !blocking && !arrestedMe) {
      if (this.focusAcc >= 0.1) {
        this.focusAcc = 0;
        const actor = { ...me, pos: this.localPos };
        const eye: [number, number, number] = [this.localPos.x, 1.58, this.localPos.z];
        this.hud?.setFocus(findFocus(s, actor, eye, world.viewDir()));
      }
    } else {
      this.focusAcc = 0.1;
      this.hud?.setFocus(null);
    }
    // 経営メニューとレイアウト編集は画面全体を覆うので、その間は 3D を描かない（電池と CPU の節約）
    const covered = this.manage?.isOpen || !!this.editor;
    if (!covered) {
      // 3D の描画に失敗しても、HUD・操作・時間の進行は止めない
      this.guard('render', () => {
        world.update(s, host.playerId, t, dt, host.mode === 'remote');
        world.render();
        // 重い端末では描画の解像度を下げる
        world.adaptResolution(interval);
      });
    }
    this.hud?.update(dt);
    this.updateArrestFade(s, dt);
    this.accidentUi?.update(s, av);
    this.checkAccidentReset(s);
    this.updateTutorial(s, dt);
    this.updateHint(s, dt);
    this.checkPhaseScreens(false);
  }

  /** 逮捕された人は営業の画面（操作ボタン・案内など）を隠し、押していた指は離したことにする */
  private setArrestMode(on: boolean): void {
    if (on === this.arrestMode) return;
    this.arrestMode = on;
    this.root.classList.toggle('arrest-mode', on);
    if (on) this.controls?.releaseAll();
  }

  /**
   * 逮捕の最後: パトカーに乗せられたら画面が暗くなり、その日の営業は終わる（オーナーの指示 2026-11-11）。
   * 精算の画面が出たら暗さを消す
   */
  private updateArrestFade(s: GameState, dt: number): void {
    const a = incidentToday(s)?.arrest;
    let want = 0;
    if (a && s.phase !== 'closed') {
      if (a.done) want = 1;
      else if (a.phase === 'fade') want = Math.min(1, (s.t - a.since) / BALANCE.armory.arrest.fadeSec);
    }
    this.arrestFade = want >= this.arrestFade ? want : Math.max(want, this.arrestFade - dt * 1.6);
    if (this.arrestFade <= 0.001) {
      if (this.arrestFadeEl) this.arrestFadeEl.hidden = true;
      return;
    }
    if (!this.arrestFadeEl) {
      this.arrestFadeEl = h('div', { class: 'arrest-fade', 'data-arrest-fade': '1' }, h('p', null, ''));
      this.root.append(this.arrestFadeEl);
    }
    const el = this.arrestFadeEl;
    el.hidden = false;
    el.style.opacity = this.arrestFade.toFixed(3);
    const p = el.firstElementChild as HTMLElement;
    const who = a ? s.players.find((x) => x.id === a.attackerId) : undefined;
    const text = !a?.attackerId ? '今日の営業は終わりです' : a.attackerId === this.host?.playerId ? '逮捕された……今日の営業は終わりです' : `${who?.name ?? '店主'}さんが警察に連れて行かれました。今日の営業は終わりです`;
    if (p.textContent !== text) p.textContent = text;
  }

  /** 事故の間は営業の画面（伝票・操作ボタン・案内など）を隠す */
  private setAccidentMode(on: boolean): void {
    if (on === this.accidentMode) return;
    this.accidentMode = on;
    this.root.classList.toggle('accident-mode', on);
    // 爆発の瞬間に押していた指は離したことにする（歩き続けないように）
    if (on) this.controls?.releaseAll();
  }

  /** リセットで事故が消えたら、仕込みの開始時点の位置へ視点を戻す */
  private checkAccidentReset(s: GameState): void {
    const id = s.events?.accident?.id ?? null;
    if (id === this.lastAccidentId) return;
    const was = this.lastAccidentId;
    this.lastAccidentId = id;
    if (!was || id) return;
    const me = s.players.find((p) => p.id === this.host?.playerId);
    if (me) {
      this.localPos = { ...me.pos };
      if (this.controls) {
        this.controls.yaw = me.yaw;
        this.controls.pitch = -0.12;
      }
    }
    this.controls?.releaseAll();
    toast(this.uiLayer, `${s.day}日目の仕込みの開始時点に戻りました`, 'good', 3500);
  }

  private hintAcc = 0;
  /** 案内は 0.25 秒ごとに更新する（フレーム数で数えると、描画の遅い端末で古い案内が長く残る） */
  private updateHint(s: GameState, dt: number): void {
    this.hintAcc += dt;
    if (this.hintAcc < 0.25 || !this.host) return;
    this.hintAcc = 0;
    const show = s.career.daysPlayed < 3 && !this.screenEl && !this.manage?.isOpen && !s.tutorial;
    const text = show ? nextHint(s, this.host.playerId) : null;
    const label = text ? `💡 ${text}` : '';
    if (this.hintEl.textContent !== label) this.hintEl.textContent = label;
    if (this.hintEl.hidden !== !text) this.hintEl.hidden = !text;
  }

  /** 下の帯（案内かチュートリアル）の高さ。開店ボタンなどをその上に置く（帯の大きさが変わったときだけ呼ばれる） */
  private updateStrip(): void {
    const strip = this.tutorial?.visible ? this.tutorial.el.offsetHeight : !this.hintEl.hidden ? this.hintEl.offsetHeight : 0;
    if (strip === this.stripH) return;
    this.stripH = strip;
    this.root.style.setProperty('--strip-h', `${strip}px`);
  }

  /** 動作の重さの表示（設定の「動作の重さを表示」） */
  private updateFps(interval: number, workMs: number): void {
    if (!this.settings.showFps) {
      if (!this.fpsEl.hidden) this.fpsEl.hidden = true;
      return;
    }
    if (interval > 0 && interval < 1) {
      this.fpsAcc += interval;
      this.fpsFrames++;
      this.fpsWork += workMs;
    }
    if (this.fpsAcc < 1) return;
    const fps = Math.round(this.fpsFrames / this.fpsAcc);
    const ms = (this.fpsWork / Math.max(1, this.fpsFrames)).toFixed(1);
    this.fpsEl.textContent = `${fps} fps ・ 処理 ${ms}ms ・ 解像度 ×${(this.world?.pixelRatio ?? 0).toFixed(2)}`;
    this.fpsEl.hidden = false;
    this.fpsAcc = 0;
    this.fpsFrames = 0;
    this.fpsWork = 0;
  }

  private checkPhaseScreens(initial: boolean): void {
    const host = this.host;
    if (!host) return;
    const s = host.state;
    if (s.phase === this.lastPhase && !initial) return;
    const prev = this.lastPhase;
    this.lastPhase = s.phase;
    if (s.phase === 'closed') {
      this.controls?.releaseAll();
      // 営業中の知らせ（客が帰った など）は、結果の画面にかぶらないように消す
      for (const t of Array.from(this.root.querySelectorAll('.toasts'))) t.replaceChildren();
      if (prev !== 'closed' || initial) this.autosave('dayEnd');
      this.showResults();
    } else if (s.phase === 'bankrupt' && this.marketPlay) {
      // 共通市場: 破産の日はサーバーへ送ってから市場の画面へ（commitMarketDay が知らせる）
      this.controls?.releaseAll();
    } else if (s.phase === 'bankrupt') {
      this.controls?.releaseAll();
      this.autosave('dayEnd');
      this.show(
        bankruptScreen(s, {
          onTitle: () => this.showTitle(),
          onRetry: () => {
            const n = createGame({ shopName: s.shopName, playerName: this.settings.playerName });
            saveToSlot(this.store, this.slot, n);
            this.startLocal(n, this.slot);
          },
        }),
      );
    } else if (s.phase === 'prep' && (prev === 'closed' || initial)) {
      this.show(null);
      const me = s.players.find((p) => p.id === host.playerId);
      if (me) this.localPos = { ...me.pos };
      void this.offerStaffTutorial();
      this.showCritics(s);
    }
  }

  private showResults(): void {
    const host = this.host;
    if (!host) return;
    const s = host.state;
    // 店を移った日は、入った店の今日の日報がないことがある（出店したばかりの店）。今日営業した店の日報を見せ、
    // どれもなければ次の日へ進むボタンだけの画面にする（新しい店に移ると次の日へ進めなかった。オーナーの指示 2026-11-13）
    const last = s.history[s.history.length - 1];
    const r = last && last.day === s.day ? last : (s.company?.stores.map((x) => storeReport(s, x, s.day)).find((x) => !!x) ?? null);
    const build = r ? (cb: ResultCallbacks) => resultScreen(s, r, host.isHost, cb) : (cb: ResultCallbacks) => noReportScreen(s, host.isHost, cb);
    const screenEl = build({
        onNextDay: async () => {
          // 練習の日（営業0日目）の結果は残さず、1日目を新しく始める
          if (s.tutorial?.kind === 'basics') {
            this.finishTutorial();
            return;
          }
          // 共通市場: 営業の結果は営業の終わりに送る。送れていれば端末で次の日へ（じろ7 5）
          if (this.marketPlay) {
            await this.marketNextDay();
            return;
          }
          const res = await host.act({ type: 'nextDay' });
          if (!res.ok) {
            // 期限を過ぎた未払金を払えずに進めないときは、どうするかを選んでもらう（オーナーの指示 2026-11-12）
            if (host.state.phase === 'closed' && overdueShortfall(host.state)) {
              await this.resolveOverdue();
              return;
            }
            toast(this.uiLayer, res.reason ?? '進めません', 'danger', 5000);
            this.openManage('dash');
          }
        },
        onManage: () => this.openManage(),
        saveTitleLabel: this.marketPlay ? '市場の画面へ' : undefined,
        onSaveTitle: () => {
          if (this.marketPlay) {
            void this.returnToTitle();
            return;
          }
          this.saveNow(true);
          this.showTitle();
        },
      });
    // 共通市場: 営業の結果の送信の状態を結果の画面の上に出し、すぐに送る（じろ7 5・14-4）
    if (this.marketPlay) {
      const st = h('div', { class: 'send-status', 'data-send-status': '', role: 'status' });
      const head = screenEl.querySelector('h2');
      if (head) head.after(st);
      else screenEl.prepend(st);
      this.sendStatusEl = st;
    } else this.sendStatusEl = null;
    this.show(screenEl);
    if (this.marketPlay) void this.finalizeAndSend();
  }

  /**
   * 期限を過ぎた未払金を払えず、次の日に進めないとき（オーナーの指示 2026-11-12「破産など何かしらの選択肢を出して」）。
   * 銀行の融資で払う・設備を売る・ほかの会社から借りる（オンライン市場）・破産する・あとで決める、から選ぶ
   */
  private async resolveOverdue(): Promise<void> {
    const host = this.host;
    if (!host) return;
    const yen = (v: number) => `¥${Math.round(v).toLocaleString('ja-JP')}`;
    for (let round = 0; round < 4; round++) {
      const f = overdueShortfall(host.state);
      if (!f || host.state.phase !== 'closed') return;
      const lines = [
        `期限を過ぎた未払金 ${yen(f.overdue)} を払わないと、次の日に進めません。`,
        `手元の現金 ${yen(f.money)}・足りない額 ${yen(f.shortfall)}`,
        '',
        f.loanMax > 0 ? `・銀行の融資: 今借りられるのは ${yen(f.loanMax)} まで（${yen(f.loanPick)} を借りて払えます）` : '・銀行の融資: 今は借りられません（借入の上限・評判）',
        f.sellable > 0 ? `・設備を売る: 全部売ると最大 ${yen(f.sellable)}（売った設備は使えなくなります）` : null,
        this.marketPlay ? '・ほかの会社から借りる: 企業間の貸し借り（相手の承認が要ります）' : null,
        '・破産する: この店の経営を終えます（元に戻せません）',
      ].filter((x): x is string => x !== null);
      const choices: { label: string; value: string; kind?: 'primary' | 'danger' | 'ghost' }[] = [];
      if (f.loanPick > 0) choices.push({ label: `🏦 ${yen(f.loanPick)} を借りて払う`, value: 'loan', kind: 'primary' });
      if (f.sellable > 0) choices.push({ label: '🔧 設備を売る', value: 'equip', kind: 'ghost' });
      if (this.marketPlay) choices.push({ label: '🤝 ほかの会社から借りる', value: 'credit', kind: 'ghost' });
      // 共通市場の企業は、自分で破産を選べない（払えないまま次の日へ進むと、市場の決まりで破産になる）
      if (!this.marketPlay) choices.push({ label: '💀 破産する', value: 'bankrupt', kind: 'danger' });
      choices.push({ label: 'あとで決める', value: 'later', kind: 'ghost' });
      const v = await choiceDialog(this.uiLayer, '⚠ 支払いの期限が過ぎています', lines.join('\n'), choices);
      if (v === 'loan') {
        const r = await host.act({ type: 'takeLoan', amount: f.loanPick });
        if (!r.ok) {
          toast(this.uiLayer, r.reason ?? '借りられませんでした', 'danger', 5000);
          continue;
        }
        await host.act({ type: 'payArrears' });
        const res = await host.act({ type: 'nextDay' });
        if (res.ok || (host.state.phase as string) === 'bankrupt') {
          toast(this.uiLayer, `${yen(f.loanPick)} を借りて未払金を払いました`, 'good', 3000);
          if (this.marketPlay && res.ok) this.afterMarketNextDay();
          else if (this.marketPlay) await this.commitMarketDay();
          return;
        }
        // まだ足りなければ、もう一度選ぶ
        continue;
      }
      if (v === 'equip') {
        this.openManage('equip');
        toast(this.uiLayer, '売る設備を選んでください。売ったら「翌日の仕込みへ →」をもう一度押すと、未払金を払って次の日へ進みます', 'info', 7000);
        return;
      }
      if (v === 'credit') {
        this.openManage('company');
        toast(this.uiLayer, '「企業間の貸し借り」で、ほかの会社の申し込みを承認すると借りられます（借りられるのは同時に1社まで）', 'info', 7000);
        return;
      }
      if (v === 'bankrupt') {
        const ok = await confirmDialog(this.uiLayer, '破産する', `期限を過ぎた未払金 ${yen(f.overdue)} を払えないので、この店の経営を終えます。\n元に戻せません（セーブデータは残り、記録を見られます）。`, '破産する', true);
        if (!ok) continue;
        await host.act({ type: 'giveUp' });
        if (this.marketPlay) await this.commitMarketDay();
        return;
      }
      return;
    }
  }

  // ───────────────── メニュー ─────────────────

  openManage(tab?: Parameters<ManageMenu['open']>[0]): void {
    if (!this.manage) return;
    this.controls?.releaseAll();
    this.screenEl?.classList.add('behind');
    this.manage.open(tab);
  }

  closeManage(): void {
    this.manage?.close();
    this.screenEl?.classList.remove('behind');
    // 閉店後の結果画面に戻る
    if (this.host?.state.phase === 'closed') this.showResults();
  }

  private openEditor(): void {
    if (!this.host) return;
    this.manage?.close();
    this.screenEl?.classList.add('behind');
    const remote = this.host as GameHost & { setLayoutLock?: (on: boolean) => void };
    this.editor = new LayoutEditor(
      this.uiLayer,
      this.host,
      () => {
        this.editor = null;
        this.screenEl?.classList.remove('behind');
        this.openManage('layout');
      },
      remote.setLayoutLock?.bind(remote),
    );
    this.editor.open();
  }

  private async openShop(): Promise<void> {
    this.sfx.unlock();
    const r = await this.host?.act({ type: 'openShop' });
    if (r && !r.ok) toast(this.uiLayer, r.reason ?? '開店できません', 'warn');
    // 共通市場: 開店したら途中のセーブ（大事な状態の変わり目。じろ7 4）
    else if (r?.ok) void this.cloudSave('event');
  }

  // ───────────────── チュートリアル ─────────────────

  /** タイトルから: 営業0日目の練習だけを遊ぶ（セーブしない。終わったらタイトルへ） */
  private startTutorialOnly(): void {
    this.startLocal(createGame({ playerName: this.settings.playerName, tutorial: true }), 0);
  }

  private updateTutorial(s: GameState, dt: number): void {
    const panel = this.tutorial;
    if (!panel) return;
    const manageOpen = !!this.manage?.isOpen;
    panel.update(dt, {
      manageOpen,
      manageTab: manageOpen ? this.manage!.currentTab : null,
      editorOpen: !!this.editor,
      covered: !!this.screenEl || manageOpen || !!this.editor,
    });
    const tg = s.tutorial && !s.tutorial.finished ? tutorialTarget(s) : null;
    const id = tg && 'id' in tg ? tg.id : null;
    const ui = tg && 'ui' in tg && (tg.ui === 'menu' || tg.ui === 'open') ? tg.ui : null;
    const tab = s.tutorial ? panel.highlightTab : null;
    const key = `${id}|${ui}|${tab}|${manageOpen ? this.manage!.currentTab : ''}`;
    if (key === this.tutorialHi) return;
    this.tutorialHi = key;
    this.world?.setTutorialTarget(id);
    this.hud?.setTutorialHighlight(ui);
    this.manage?.highlightTab(tab);
  }

  /** 最後の手順まで終えた: 営業0日目なら練習をリセットして1日目を始める（タイトルからならタイトルへ） */
  private finishTutorial(): void {
    const s = this.host?.state;
    if (!s) return;
    if (this.slot === 0) {
      this.showTitle();
      toast(this.uiLayer, 'チュートリアルを終えました', 'good', 3000);
      return;
    }
    const n = createGame({ shopName: s.shopName, playerName: this.settings.playerName });
    const r = saveToSlot(this.store, this.slot, n);
    if (!r.ok) toast(this.uiLayer, r.error, 'danger');
    this.startLocal(n, this.slot);
    toast(this.uiLayer, '1日目の営業を始めます。資金は¥300,000です', 'good', 4000);
  }

  private async quitTutorial(): Promise<void> {
    const s = this.host?.state;
    if (!s?.tutorial) return;
    if (s.tutorial.kind === 'staff') {
      await this.host?.act({ type: 'tutorial', op: 'quit' });
      return;
    }
    const body = this.slot === 0 ? 'タイトルに戻ります。' : '練習を終えて、1日目から始めます（練習の結果は残りません）。';
    if (!(await confirmDialog(this.uiLayer, 'チュートリアルをやめますか？', body, 'やめる'))) return;
    this.finishTutorial();
  }

  /** 3日目（以降）の準備時間に、従業員のチュートリアルを受けるかを聞く（ひとりプレイで一度だけ） */
  /** 朝に公開された覆面調査員（グルメ評論家）の記事を見せる */
  private showCritics(s: GameState): void {
    for (const r of s.events?.critics ?? []) {
      if (!r.published || r.publishDay !== s.day || this.shownCritics.has(r.id)) continue;
      this.shownCritics.add(r.id);
      showCriticReport(this.uiLayer, r);
    }
  }

  private async offerStaffTutorial(): Promise<void> {
    const host = this.host;
    // オンライン市場の営業では案内しない（オーナーの指示 2026-11-11: 市場で営業を始めるたびに出ていた不具合）
    if (!host || host.mode !== 'local' || host instanceof MarketHost) return;
    const s = host.state;
    if (s.tutorial || s.day < 3 || s.phase !== 'prep' || s.career.staffTutorialOffered) return;
    const take = await confirmDialog(
      this.uiLayer,
      '従業員のチュートリアル',
      '従業員の雇い方と、仕事の任せ方を案内します。受けますか？（雇うかどうかは途中で選べます）',
      '受ける',
      false,
      '受けない',
    );
    if (this.host !== host) return;
    await host.act({ type: 'tutorial', op: take ? 'staffStart' : 'staffDecline' });
  }

  // ───────────────── テスト用 ─────────────────

  /** E2E テスト用: 自分を対象の正面に立たせ、対象の方を向かせる */
  debugFace(targetId: string): boolean {
    const host = this.host;
    if (!host || !this.controls) return false;
    const s = host.state;
    const t = resolveTarget(s, targetId);
    if (!t) return false;
    const pts = targetPoints(s, t);
    // 厨房側の位置を優先（席はカウンター越し）
    const p0 = pts[pts.length - 1];
    if (!p0) return false;
    // 店の前の喫煙客は、店側から少し離れて向き合う
    const p = t.kind === 'customer' ? { x: p0.x + 0.2, z: Math.min(-0.3, p0.z + 0.9) } : p0;
    // 照準を対象の箱の中心に合わせる（席はカウンターの天板）
    const b = interactableBoxes(s).find((x) => x.id === targetId);
    const c = b
      ? { x: (b.min[0] + b.max[0]) / 2, y: (b.min[1] + b.max[1]) / 2, z: (b.min[2] + b.max[2]) / 2 }
      : { ...(t.kind === 'equipment' ? equipmentCenter(t.e) : t.kind === 'seat' ? seatCounterPoint(s, t.seat) : t.kind === 'dirt' ? t.dirt.pos : p), y: 0.8 };
    this.localPos = { x: p.x, z: p.z };
    const me = s.players.find((x) => x.id === host.playerId);
    if (me && host.mode === 'local') me.pos = { x: p.x, z: p.z };
    this.controls.yaw = Math.atan2(c.x - p.x, c.z - p.z);
    this.controls.pitch = Math.atan2(c.y - 1.58, Math.hypot(c.x - p.x, c.z - p.z));
    host.move(p.x, p.z, this.controls.yaw);
    return true;
  }

  // ───────────────── セーブ ─────────────────

  saveNow(notify: boolean): void {
    const host = this.host;
    if (!host) return;
    if (this.marketPlay) {
      // 共通市場: 営業の途中のセーブをサーバーへ（じろ7 4）
      void this.cloudSave(notify ? 'manual' : 'event');
      return;
    }
    if (this.slot === 0) {
      if (notify) toast(this.uiLayer, 'タイトルから始めたチュートリアルは保存されません', 'info');
      return;
    }
    if (host.mode === 'remote') {
      const rh = host as GameHost & { requestSave?: () => Promise<GameState | null> };
      void rh.requestSave?.().then((st) => {
        if (!st) {
          toast(this.uiLayer, '保存に失敗しました', 'danger');
          return;
        }
        const r = saveToSlot(this.store, this.slot, st);
        toast(this.uiLayer, r.ok ? `スロット${this.slot}に保存しました（ホスト）` : r.error, r.ok ? 'good' : 'danger');
      });
      return;
    }
    const r = saveToSlot(this.store, this.slot, host.state);
    if (r.ok) this.lastSavedVersion = host.state.version;
    if (notify || !r.ok) toast(this.uiLayer, r.ok ? `スロット${this.slot}に保存しました` : r.error, r.ok ? 'good' : 'danger');
  }

  private autosave(reason: 'dayEnd' | 'hidden'): void {
    if (!this.host || this.host.mode !== 'local' || this.slot === 0) return;
    const r = saveToSlot(this.store, this.slot, this.host.state);
    if (r.ok) this.lastSavedVersion = this.host.state.version;
    if (!r.ok && reason === 'dayEnd') toast(this.uiLayer, `自動保存に失敗: ${r.error}`, 'danger', 5000);
  }
}
