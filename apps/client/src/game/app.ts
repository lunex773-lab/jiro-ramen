// アプリ全体の流れ: タイトル → スロット選択 → 店内（一人称）→ 営業終了 → 経営 → 翌日 …

import {
  BALANCE,
  createGame,
  equipmentCenter,
  resolveTarget,
  seatCounterPoint,
  targetPoints,
  deleteSlot,
  listSlots,
  loadFromSlot,
  moveWithCollision,
  saveToSlot,
  type GameState,
  type SaveStore,
} from '@jiro/core';
import { Sfx } from '../audio/sfx';
import { World } from '../render/world';
import { confirmDialog, h, replace, toast } from '../ui/dom';
import { Hud } from '../ui/hud';
import { LayoutEditor } from '../ui/layout-editor';
import { ManageMenu } from '../ui/manage';
import { bankruptScreen, helpScreen, resultScreen, settingsScreen, slotScreen, titleScreen } from '../ui/screens';
import { Controls } from './controls';
import { nextHint } from './guide';
import { LocalHost, type GameHost } from './host';
import { loadSettings, saveSettings, type Settings } from './settings';
import { findFocus } from './targeting';
import { openLobby } from '../ui/lobby';

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
  private pausedForMenu = false;
  private localPos = { x: 0, z: 0 };
  private moveSendAcc = 0;
  private unsub: (() => void)[] = [];
  private onLeaveGame: (() => void) | null = null;

  constructor(mount: HTMLElement) {
    this.root = mount;
    this.root.classList.add('app');
    this.canvas = h('canvas', { class: 'game-canvas' });
    this.overlay = h('div', { class: 'overlay3d' });
    this.uiLayer = h('div', { class: 'ui-layer' });
    this.hintEl = h('div', { class: 'hint' });
    this.root.append(this.canvas, this.overlay, this.uiLayer);
    this.applySettings();
    window.addEventListener('resize', () => this.world?.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.autosave('hidden');
    });
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
          onMulti: () => this.showLobby(),
          onHelp: () => this.showHelp(() => this.showTitle()),
          onSettings: () => this.showSettings(() => this.showTitle()),
        },
        VERSION,
      ),
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
        onNew: (slot, shopName) => {
          const s = createGame({ shopName, playerName: this.settings.playerName });
          this.slot = slot;
          const r = saveToSlot(this.store, slot, s);
          if (!r.ok) toast(this.uiLayer, r.error, 'danger');
          this.startLocal(s, slot);
          if (!this.settings.tutorialSeen) {
            this.settings.tutorialSeen = true;
            saveSettings(this.settings);
            this.showHelp(() => this.show(null));
          }
        },
      }),
    );
  }

  showHelp(back: () => void): void {
    this.show(helpScreen(back, this.controls?.isTouch ?? matchMedia('(pointer: coarse)').matches));
  }

  showSettings(back: () => void): void {
    this.show(
      settingsScreen(
        this.settings,
        (st) => {
          this.settings = st;
          saveSettings(st);
          this.applySettings();
        },
        back,
      ),
    );
  }

  showLobby(): void {
    this.leaveGame();
    const el = openLobby(this, () => this.showTitle());
    this.show(el);
  }

  // ───────────────── ゲーム開始・終了 ─────────────────

  startLocal(state: GameState, slot: number): void {
    this.slot = slot;
    this.settings.lastSlot = slot;
    saveSettings(this.settings);
    // ローカルでは自分が唯一のプレイヤー
    const me = state.players[0];
    if (me) {
      me.connected = true;
      me.lastMoveAt = 0;
      if (this.settings.playerName) me.name = this.settings.playerName;
    }
    this.startGame(new LocalHost(state, me?.id ?? 'p1'));
  }

  startGame(host: GameHost, onLeave?: () => void): void {
    this.leaveGame();
    this.onLeaveGame = onLeave ?? null;
    this.host = host;
    this.show(null);
    this.world = new World(this.canvas, this.overlay, this.settings.quality);
    this.controls = new Controls(this.uiLayer, this.canvas);
    this.controls.settings = { lookSensitivity: this.settings.lookSensitivity, invertY: this.settings.invertY };
    if (this.controls.isTouch) this.root.classList.add('touch');
    this.hud = new Hud(this.uiLayer, host, {
      onMenu: () => this.openManage(),
      onOpenShop: () => void this.openShop(),
      onHelp: () => this.showHelp(() => this.show(null)),
    });
    this.uiLayer.appendChild(this.hintEl);
    this.manage = new ManageMenu(this.uiLayer, host, {
      onClose: () => this.closeManage(),
      onLayoutEditor: () => this.openEditor(),
      onSave: () => this.saveNow(true),
      onSettings: () => this.showSettings(() => this.show(null)),
      onTitle: () => void this.backToTitle(),
      onHelp: () => this.showHelp(() => this.show(null)),
    });
    const c = this.controls;
    c.onPrimary = (down) => this.hud?.pressIndex(0, down);
    c.onVerbKey = (i, down) => this.hud?.pressIndex(i, down);
    c.onCancel = () => void host.act({ type: 'cancelWork' });
    c.onMenu = () => (this.manage?.isOpen ? this.closeManage() : this.openManage());
    c.onPause = () => (this.manage?.isOpen ? this.closeManage() : this.openManage());
    const me = host.state.players.find((p) => p.id === host.playerId);
    if (me) {
      this.localPos = { ...me.pos };
      c.yaw = me.yaw;
    }
    this.unsub.push(host.onEvents((ev) => this.sfx.onEvents(ev, host.playerId)));
    this.sfx.startAmbience();
    this.lastPhase = host.state.phase;
    this.checkPhaseScreens(true);
    this.lastT = performance.now();
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - this.lastT) / 1000);
      this.lastT = now;
      this.frame(dt, now / 1000);
    };
    this.raf = requestAnimationFrame(loop);
  }

  leaveGame(): void {
    cancelAnimationFrame(this.raf);
    for (const u of this.unsub) u();
    this.unsub = [];
    this.manage?.close();
    this.editor?.close();
    this.hud?.dispose();
    this.controls?.dispose();
    this.world?.dispose();
    this.host?.dispose();
    this.sfx.stopAmbience();
    this.hintEl.remove();
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

  private async backToTitle(): Promise<void> {
    if (this.host?.mode === 'local') this.saveNow(false);
    else if (!(await confirmDialog(this.uiLayer, '退出', '共同経営から退出します。', '退出する'))) return;
    this.showTitle();
  }

  // ───────────────── 毎フレーム ─────────────────

  private frame(dt: number, t: number): void {
    const host = this.host;
    const world = this.world;
    const c = this.controls;
    if (!host || !world || !c) return;
    const s = host.state;
    const blocking = !!this.screenEl || this.manage?.isOpen || !!this.editor;
    c.enabled = !blocking;
    // シングルプレイではメニュー中は時間を止める
    const pauseLocal = host.mode === 'local' && (blocking || s.phase === 'closed');
    if (!pauseLocal) host.tick(dt);
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
    if (me) {
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
    world.setCamera(this.localPos.x, this.localPos.z, c.yaw, c.pitch, moving, dt);
    // 注視対象（自分の位置はローカル予測を使う）
    if (me && !blocking) {
      const actor = { ...me, pos: this.localPos };
      const eye: [number, number, number] = [this.localPos.x, 1.58, this.localPos.z];
      const f = findFocus(s, actor, eye, world.viewDir());
      this.hud?.setFocus(f?.target ?? null);
    } else this.hud?.setFocus(null);
    world.update(s, host.playerId, t, dt, host.mode === 'remote');
    world.render();
    this.hud?.update(dt);
    this.updateHint(s);
    this.checkPhaseScreens(false);
  }

  private hintAcc = 0;
  private updateHint(s: GameState): void {
    this.hintAcc++;
    if (this.hintAcc % 15 !== 0 || !this.host) return;
    const show = s.career.daysPlayed < 3 && !this.screenEl && !this.manage?.isOpen;
    const text = show ? nextHint(s, this.host.playerId) : null;
    this.hintEl.textContent = text ? `💡 ${text}` : '';
    this.hintEl.style.display = text ? 'block' : 'none';
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
      if (prev !== 'closed' || initial) this.autosave('dayEnd');
      this.showResults();
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
    }
  }

  private showResults(): void {
    const host = this.host;
    if (!host) return;
    const s = host.state;
    const r = s.history[s.history.length - 1];
    if (!r) {
      this.show(null);
      return;
    }
    this.show(
      resultScreen(s, r, host.isHost, {
        onNextDay: async () => {
          const res = await host.act({ type: 'nextDay' });
          if (!res.ok) {
            toast(this.uiLayer, res.reason ?? '進めません', 'danger', 5000);
            this.openManage('dash');
          }
        },
        onManage: () => this.openManage(),
        onSaveTitle: () => {
          this.saveNow(true);
          this.showTitle();
        },
      }),
    );
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
    const p = pts[pts.length - 1];
    if (!p) return false;
    const c = t.kind === 'equipment' ? equipmentCenter(t.e) : t.kind === 'seat' ? seatCounterPoint(s, t.seat) : t.kind === 'dirt' ? t.dirt.pos : p;
    this.localPos = { x: p.x, z: p.z };
    const me = s.players.find((x) => x.id === host.playerId);
    if (me && host.mode === 'local') me.pos = { x: p.x, z: p.z };
    this.controls.yaw = Math.atan2(c.x - p.x, c.z - p.z);
    this.controls.pitch = t.kind === 'dirt' ? -0.9 : -0.35;
    host.move(p.x, p.z, this.controls.yaw);
    return true;
  }

  // ───────────────── セーブ ─────────────────

  saveNow(notify: boolean): void {
    const host = this.host;
    if (!host) return;
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
    if (notify || !r.ok) toast(this.uiLayer, r.ok ? `スロット${this.slot}に保存しました` : r.error, r.ok ? 'good' : 'danger');
  }

  private autosave(reason: 'dayEnd' | 'hidden'): void {
    if (!this.host || this.host.mode !== 'local') return;
    const r = saveToSlot(this.store, this.slot, this.host.state);
    if (!r.ok && reason === 'dayEnd') toast(this.uiLayer, `自動保存に失敗: ${r.error}`, 'danger', 5000);
  }
}
