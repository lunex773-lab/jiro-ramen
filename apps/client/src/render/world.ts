// 3D シーン: ゲーム状態を描画オブジェクトへ同期する。ゲームのルールはここに置かない（設計書 3）。

import * as THREE from 'three';

import {
  CELL,
  EQUIPMENT,
  equipmentCenter,
  seatCounterPoint,
  seatPos,
  stageOf,
  STAGES,
  type Bowl,
  type Customer,
  type Employee,
  type GameState,
  type Hand,
  type Player,
} from '@jiro/core';
import {
  createBowl,
  createCharacter,
  createDirt,
  createEquipment,
  createHeldItem,
  createLostItem,
  createShopShell,
  createStool,
  tickModels,
  type BowlModel,
  type CharacterModel,
  type CharacterPose,
  type EquipmentModel,
  type HeldKind,
  type ShopShell,
} from './models';

/** 横の画角（度）。縦の画角はこれと画面の縦横比から決める */
const HORIZONTAL_FOV = 100;

export type Quality = 'low' | 'medium' | 'high';

export const EYE_HEIGHT = 1.58;
export const COUNTER_TOP = 1.0;

interface CharEntry {
  model: CharacterModel;
  shown: THREE.Vector3;
  lastTarget: THREE.Vector3;
  moving: number;
  yaw: number;
  kind: 'customer' | 'employee' | 'player';
}

interface Bubble {
  el: HTMLElement;
  text: string;
}

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private shell: ShopShell | null = null;
  private shellStage = -1;
  private shellName = '';
  private lights: THREE.Light[] = [];
  private equip = new Map<string, { model: EquipmentModel; type: string }>();
  private stools = new Map<string, THREE.Object3D>();
  private stoolKey = '';
  private chars = new Map<string, CharEntry>();
  private bowls = new Map<string, BowlModel>();
  private dirt = new Map<string, THREE.Object3D>();
  private lost = new Map<string, THREE.Object3D>();
  private view: { kind: string; obj: THREE.Object3D; bowl: BowlModel | null } | null = null;
  private bubbles = new Map<string, Bubble>();
  private tmpV = new THREE.Vector3();
  private bob = 0;
  private overlayAcc = 0;
  private quality: Quality;

  constructor(
    private canvas: HTMLCanvasElement,
    private overlay: HTMLElement,
    quality: Quality,
  ) {
    this.quality = quality;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: quality !== 'low', powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = quality === 'high';
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.camera = new THREE.PerspectiveCamera(72, 1, 0.05, 80);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);
    this.scene.background = new THREE.Color('#bcd3e6');
    this.scene.fog = new THREE.Fog('#bcd3e6', 18, 60);
    const hemi = new THREE.HemisphereLight('#fff6e8', '#5b4a3a', 0.85);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight('#fff1d6', 1.2);
    sun.position.set(-6, 12, -10);
    sun.castShadow = quality === 'high';
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -14;
    sun.shadow.camera.right = 14;
    sun.shadow.camera.top = 14;
    sun.shadow.camera.bottom = -14;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.resize();
  }

  setQuality(q: Quality): void {
    this.quality = q;
    this.resize();
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const hgt = this.canvas.clientHeight || window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    const ratio = this.quality === 'low' ? 1 : this.quality === 'medium' ? Math.min(1.5, dpr) : Math.min(2, dpr);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, hgt, false);
    this.camera.aspect = w / Math.max(1, hgt);
    // 横に長い画面（iPhone の横向きは約 2.2:1）で縦の画角を固定すると左右が大きく引き伸ばされるので、
    // 横の画角を約 100° に保つよう縦の画角を決める（PC の 16:10 では従来とほぼ同じ 73°）
    const halfH = Math.atan(Math.tan(THREE.MathUtils.degToRad(HORIZONTAL_FOV / 2)) / this.camera.aspect);
    this.camera.fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(halfH * 2), 55, 75);
    this.camera.updateProjectionMatrix();
  }

  // ───────────────── 同期 ─────────────────

  private syncShell(s: GameState): void {
    const st = s.career.stage;
    if (this.shell && this.shellStage === st) {
      if (this.shellName !== s.shopName) {
        this.shell.setShopName(s.shopName);
        this.shellName = s.shopName;
      }
      return;
    }
    if (this.shell) {
      this.scene.remove(this.shell.group);
      this.shell.dispose();
    }
    for (const l of this.lights) this.scene.remove(l);
    this.lights = [];
    const stage = STAGES[st]!;
    this.shell = createShopShell(stage, s.shopName);
    this.shellStage = st;
    this.shellName = s.shopName;
    this.scene.add(this.shell.group);
    const spots = (this.shell as ShopShell & { lightSpots?: THREE.Vector3[] }).lightSpots ?? [];
    const maxLights = this.quality === 'low' ? 2 : 4;
    const chosen = spots.length > 0 ? spots.filter((_, i) => i % Math.max(1, Math.ceil(spots.length / maxLights)) === 0).slice(0, maxLights) : [new THREE.Vector3((stage.w * CELL) / 2, 2.4, (stage.d * CELL) / 2)];
    for (const p of chosen) {
      const l = new THREE.PointLight('#ffe2b8', 6, 9, 1.6);
      l.position.copy(p);
      this.scene.add(l);
      this.lights.push(l);
    }
  }

  private syncEquipment(s: GameState, t: number, dt: number): void {
    const seen = new Set<string>();
    for (const e of s.equipment) {
      const def = EQUIPMENT[e.type];
      if (!e.placed || !def || def.w === 0) continue;
      seen.add(e.id);
      let entry = this.equip.get(e.id);
      if (!entry || entry.type !== e.type) {
        if (entry) {
          this.scene.remove(entry.model.group);
          entry.model.dispose();
        }
        entry = { model: createEquipment(e.type), type: e.type };
        this.equip.set(e.id, entry);
        this.scene.add(entry.model.group);
      }
      const c = equipmentCenter(e);
      entry.model.group.position.set(c.x, 0, c.z);
      entry.model.group.rotation.y = -e.rot * (Math.PI / 2);
      entry.model.update(e, s, t, dt);
    }
    for (const [id, entry] of this.equip) {
      if (seen.has(id)) continue;
      this.scene.remove(entry.model.group);
      entry.model.dispose();
      this.equip.delete(id);
    }
  }

  private syncStools(s: GameState): void {
    const st = stageOf(s);
    const key = `${s.career.stage}|${s.seats.map((x) => `${x.installed ? 1 : 0}${x.offset.x.toFixed(2)},${x.offset.z.toFixed(2)}`).join(';')}`;
    if (key === this.stoolKey) return;
    this.stoolKey = key;
    for (const o of this.stools.values()) this.scene.remove(o);
    this.stools.clear();
    for (const seat of s.seats) {
      if (!seat.installed || seat.index >= st.seats.length) continue;
      const o = createStool();
      const p = seatPos(s, seat);
      o.position.set(p.x, 0, p.z);
      this.scene.add(o);
      this.stools.set(seat.id, o);
    }
  }

  private charEntry(id: string, kind: 'customer' | 'employee' | 'player', seed: number, color?: string): CharEntry {
    let c = this.chars.get(id);
    if (!c) {
      const model = createCharacter({ kind, seed, color });
      c = { model, shown: new THREE.Vector3(), lastTarget: new THREE.Vector3(Number.NaN, 0, 0), moving: 0, yaw: 0, kind };
      this.chars.set(id, c);
      this.scene.add(model.group);
    }
    return c;
  }

  private placeChar(c: CharEntry, x: number, z: number, yaw: number | null, dt: number, smooth: boolean): void {
    const target = this.tmpV.set(x, 0, z);
    if (Number.isNaN(c.lastTarget.x)) {
      c.shown.copy(target);
      c.lastTarget.copy(target);
    }
    const moved = target.distanceTo(c.lastTarget);
    c.lastTarget.copy(target);
    c.moving = Math.max(0, c.moving - dt) + (moved > 0.002 ? 0.25 : 0);
    if (smooth) c.shown.lerp(target, Math.min(1, dt * 12));
    else c.shown.copy(target);
    c.model.group.position.copy(c.shown);
    if (yaw !== null) c.yaw = yaw;
    else if (moved > 0.002) {
      const d = new THREE.Vector3().subVectors(target, c.model.group.position);
      if (d.lengthSq() > 1e-6) c.yaw = Math.atan2(d.x, d.z);
    }
    // 向きはなめらかに
    const cur = c.model.group.rotation.y;
    let diff = c.yaw - cur;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    c.model.group.rotation.y = cur + diff * Math.min(1, dt * 10);
  }

  private syncCharacters(s: GameState, myId: string, t: number, dt: number, smooth: boolean): void {
    const seen = new Set<string>();
    for (const cu of s.customers) {
      if (cu.state === 'left' || cu.state === 'abandoned') continue;
      seen.add(cu.id);
      const c = this.charEntry(cu.id, 'customer', cu.appearance);
      const seated = cu.state === 'seated' || cu.state === 'eating' || cu.state === 'complaint';
      if (seated && cu.seatId) {
        const seat = s.seats.find((x) => x.id === cu.seatId);
        const p = seat ? seatPos(s, seat) : cu.pos;
        this.placeChar(c, p.x, p.z, 0, dt, smooth);
      } else {
        this.placeChar(c, cu.pos.x, cu.pos.z, cu.state === 'queue' || cu.state === 'waitingSeat' ? (cu.path.length === 0 ? waitYaw(cu) : null) : null, dt, smooth);
      }
      const pose: CharacterPose = cu.state === 'eating' ? 'eat' : seated ? 'sit' : c.moving > 0 ? 'walk' : 'stand';
      c.model.update(pose, t, dt);
    }
    for (const e of s.employees) {
      if (!e.presentToday) continue;
      seen.add(e.id);
      const c = this.charEntry(e.id, 'employee', hashId(e.id));
      this.placeChar(c, e.pos.x, e.pos.z, e.ai.state === 'working' || e.work ? e.yaw : null, dt, smooth);
      c.model.setHeld(heldKind(e.hand));
      const pose: CharacterPose = e.work ? 'work' : c.moving > 0 ? (e.hand.kind !== 'none' ? 'carry' : 'walk') : 'stand';
      c.model.update(pose, t, dt);
    }
    for (const p of s.players) {
      if (p.id === myId || !p.connected) continue;
      seen.add(p.id);
      const c = this.charEntry(p.id, 'player', hashId(p.id), p.color);
      c.model.setLabel(p.name);
      this.placeChar(c, p.pos.x, p.pos.z, p.yaw, dt, true);
      c.model.setHeld(heldKind(p.hand));
      const pose: CharacterPose = p.work ? 'work' : c.moving > 0 ? (p.hand.kind !== 'none' ? 'carry' : 'walk') : 'stand';
      c.model.update(pose, t, dt);
    }
    for (const [id, c] of this.chars) {
      if (seen.has(id)) continue;
      this.scene.remove(c.model.group);
      c.model.dispose();
      this.chars.delete(id);
    }
  }

  private bowlPosition(s: GameState, b: Bowl, myId: string, out: THREE.Vector3): boolean {
    const loc = b.loc;
    if (loc.at === 'station') {
      const entry = this.equip.get(loc.stationId);
      const anchor = entry?.model.bowlAnchors[loc.slot];
      if (!entry || !anchor) return false;
      out.copy(anchor);
      entry.model.group.localToWorld(out);
      return true;
    }
    if (loc.at === 'seat') {
      const seat = s.seats.find((x) => x.id === loc.seatId);
      if (!seat) return false;
      const p = seatCounterPoint(s, seat);
      // 食べ終わった丼は上げ台へ
      if (b.state === 'dirty') out.set(p.x, COUNTER_TOP + 0.16, p.z + 0.18);
      else out.set(p.x, COUNTER_TOP, p.z - 0.06);
      return true;
    }
    if (loc.at === 'hand' && loc.actorId !== myId) {
      const c = this.chars.get(loc.actorId);
      if (!c) return false;
      const g = c.model.group;
      out.set(Math.sin(g.rotation.y) * 0.32, 1.02, Math.cos(g.rotation.y) * 0.32).add(g.position);
      return true;
    }
    return false;
  }

  private syncBowls(s: GameState, myId: string): void {
    const seen = new Set<string>();
    const camPos = this.camera.position;
    for (const b of s.bowls) {
      if (b.loc.at === 'rack' || b.loc.at === 'sink') continue;
      if (b.loc.at === 'hand' && b.loc.actorId === myId) continue;
      if (!this.bowlPosition(s, b, myId, this.tmpV)) continue;
      seen.add(b.id);
      let m = this.bowls.get(b.id);
      if (!m) {
        m = createBowl();
        this.bowls.set(b.id, m);
        this.scene.add(m.group);
        (m as BowlModel & { _key?: string })._key = '';
      }
      m.group.position.copy(this.tmpV);
      const near = this.tmpV.distanceTo(camPos) < 2.2;
      const key = `${b.state}|${b.contents ? `${b.contents.steps.length}|${b.contents.buta}|${b.contents.noodleG}|${Object.values(b.contents.toppings).join(',')}|${b.contents.tare}|${Math.round(b.contents.heat / 10)}` : 'x'}|${near ? 'h' : 'l'}`;
      const mm = m as BowlModel & { _key?: string };
      if (mm._key !== key) {
        mm._key = key;
        m.setDetail(near ? 'high' : 'low');
        m.setContents(b.state === 'dirty' ? null : b.contents, { dirty: b.state === 'dirty' });
      }
    }
    for (const [id, m] of this.bowls) {
      if (seen.has(id)) continue;
      this.scene.remove(m.group);
      m.dispose();
      this.bowls.delete(id);
    }
  }

  private syncDirtAndLost(s: GameState): void {
    const seenD = new Set<string>();
    for (const d of s.dirt) {
      seenD.add(d.id);
      let o = this.dirt.get(d.id);
      if (!o) {
        o = createDirt(d.kind);
        this.dirt.set(d.id, o);
        this.scene.add(o);
      }
      o.position.set(d.pos.x, 0.005, d.pos.z);
      const sc = 0.7 + Math.min(3, d.amount) * 0.25;
      o.scale.set(sc, 1, sc);
    }
    for (const [id, o] of this.dirt) {
      if (seenD.has(id)) continue;
      this.scene.remove(o);
      this.dirt.delete(id);
    }
    const seenL = new Set<string>();
    for (const l of s.lostItems) {
      if (l.state !== 'lying') continue;
      const seat = s.seats.find((x) => x.id === l.seatId);
      if (!seat) continue;
      seenL.add(l.id);
      let o = this.lost.get(l.id);
      if (!o) {
        o = createLostItem(l.kind);
        this.lost.set(l.id, o);
        this.scene.add(o);
      }
      const p = seatCounterPoint(s, seat);
      o.position.set(p.x + 0.22, COUNTER_TOP + 0.01, p.z - 0.05);
    }
    for (const [id, o] of this.lost) {
      if (seenL.has(id)) continue;
      this.scene.remove(o);
      this.lost.delete(id);
    }
  }

  /** 一人称の手元（持っている物） */
  private syncViewModel(s: GameState, me: Player | undefined, t: number): void {
    const hand = me?.hand ?? { kind: 'none' as const };
    const kind = hand.kind;
    if (this.view && this.view.kind !== kind) {
      this.camera.remove(this.view.obj);
      this.view.bowl?.dispose();
      this.view = null;
    }
    if (kind === 'none') return;
    if (!this.view) {
      if (kind === 'bowl') {
        const bowl = createBowl();
        bowl.setDetail('high');
        this.view = { kind, obj: bowl.group, bowl };
      } else {
        const hk = heldKind(hand);
        if (!hk) return;
        this.view = { kind, obj: createHeldItem(hk), bowl: null };
      }
      this.camera.add(this.view.obj);
    }
    const o = this.view.obj;
    o.position.set(0.16, -0.36 + Math.sin(this.bob * 2) * 0.008, -0.48);
    o.rotation.set(0.35, 0, 0);
    if (this.view.bowl && hand.kind === 'bowl') {
      const b = s.bowls.find((x) => x.id === hand.bowlId);
      const key = b?.contents ? `${b.contents.steps.length}|${b.contents.buta}|${Object.values(b.contents.toppings).join(',')}|${b.contents.tare}|${Math.round(b.contents.heat / 10)}` : 'x';
      const vb = this.view.bowl as BowlModel & { _key?: string };
      if (vb._key !== key) {
        vb._key = key;
        vb.setContents(b?.contents ?? null);
      }
    }
    void t;
  }

  /** カメラ（一人称） */
  setCamera(x: number, z: number, yaw: number, pitch: number, moving: boolean, dt: number): void {
    if (moving) this.bob += dt * 7;
    const bobY = moving ? Math.sin(this.bob * 2) * 0.025 : 0;
    this.camera.position.set(x, EYE_HEIGHT + bobY, z);
    this.camera.rotation.set(pitch, yaw + Math.PI, 0);
  }

  /** 視線の方向（正規化） */
  viewDir(): [number, number, number] {
    const d = new THREE.Vector3();
    this.camera.getWorldDirection(d);
    return [d.x, d.y, d.z];
  }

  update(s: GameState, myId: string, t: number, dt: number, smooth: boolean): void {
    this.syncShell(s);
    this.syncEquipment(s, t, dt);
    this.syncStools(s);
    this.syncCharacters(s, myId, t, dt, smooth);
    this.syncBowls(s, myId);
    this.syncDirtAndLost(s);
    this.syncViewModel(s, s.players.find((p) => p.id === myId), t);
    for (const m of this.bowls.values()) (m as BowlModel & { tick?: (t: number) => void }).tick?.(t);
    tickModels(t);
    this.overlayAcc += dt;
    if (this.overlayAcc > 0.08) {
      this.overlayAcc = 0;
      this.updateOverlay(s);
    }
  }

  /** 吹き出し（客のセリフ）と席番号 */
  private updateOverlay(s: GameState): void {
    const w = this.canvas.clientWidth;
    const hgt = this.canvas.clientHeight;
    const seen = new Set<string>();
    const show = (id: string, text: string, pos: THREE.Vector3, cls: string) => {
      const v = pos.clone().project(this.camera);
      if (v.z > 1 || v.z < -1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) return;
      if (pos.distanceTo(this.camera.position) > 9) return;
      seen.add(id);
      let b = this.bubbles.get(id);
      if (!b) {
        b = { el: document.createElement('div'), text: '' };
        this.overlay.appendChild(b.el);
        this.bubbles.set(id, b);
      }
      if (b.text !== text) {
        b.text = text;
        b.el.textContent = text;
      }
      b.el.className = cls;
      b.el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * hgt}px) translate(-50%, -100%)`;
    };
    for (const cu of s.customers) {
      const c = this.chars.get(cu.id);
      if (!c) continue;
      const head = c.model.group.position.clone();
      const seated = cu.state === 'seated' || cu.state === 'eating' || cu.state === 'complaint';
      head.y += seated ? 1.45 : 1.95;
      if (cu.say && cu.sayUntil > s.t) show(`say:${cu.id}`, cu.say, head, `bubble ${cu.state === 'complaint' ? 'angry' : ''}`);
      else if (cu.state === 'seated') {
        const seat = s.seats.find((x) => x.id === cu.seatId);
        const ratio = cu.patience / 150;
        if (seat) show(`seat:${cu.id}`, `${seat.index + 1}`, head, `seatno ${ratio < 0.25 ? 'late' : ratio < 0.5 ? 'warn' : ''}`);
      }
    }
    for (const [id, b] of this.bubbles) {
      if (seen.has(id)) continue;
      b.el.remove();
      this.bubbles.delete(id);
    }
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    for (const e of this.equip.values()) e.model.dispose();
    for (const c of this.chars.values()) c.model.dispose();
    for (const b of this.bowls.values()) b.dispose();
    this.shell?.dispose();
    for (const b of this.bubbles.values()) b.el.remove();
    this.renderer.dispose();
  }
}

function heldKind(h: Hand): HeldKind | null {
  switch (h.kind) {
    case 'none':
      return null;
    case 'bowl':
      return 'bowl';
    case 'clean':
      return 'clean';
    case 'dirty':
      return 'dirty';
    case 'mop':
      return 'mop';
    case 'lostItem':
      return 'lostItem';
    case 'trash':
      return 'trash';
  }
}

function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** 並んでいる客は入口・券売機の方（-x）を向く */
function waitYaw(_c: Customer): number {
  return -Math.PI / 2;
}

export type { Employee };
