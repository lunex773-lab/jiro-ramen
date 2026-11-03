// 3D シーン: ゲーム状態を描画オブジェクトへ同期する。ゲームのルールはここに置かない（設計書 3）。

import * as THREE from 'three';
import { ResolutionGovernor } from './resolution';
import { Aftermath, hash01 } from './aftermath';
import { eatenContents, eatenStep, eatMotion, eatProgress } from './eat-motion';
import { createSteam } from './models/fx';
import { layoutBubbles, type BubbleBox } from '../ui/bubble-layout';
import { createAutographs } from './autograph';
import { signSlots } from './sign-slots';

import {
  CELL,
  EQUIPMENT,
  equipmentCenter,
  seatCounterPoint,
  seatPos,
  stageOf,
  STAGES,
  type AccidentState,
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
/** 描画の解像度を自動で下げるときの下限 */
const MIN_PIXEL_RATIO = 0.75;
export const COUNTER_TOP = 1.0;

interface CharEntry {
  model: CharacterModel;
  shown: THREE.Vector3;
  lastTarget: THREE.Vector3;
  moving: number;
  yaw: number;
  kind: 'customer' | 'employee' | 'player';
  /** タバコの煙（店の前の喫煙客） */
  smoke?: THREE.Object3D | null;
}

interface Bubble {
  el: HTMLElement;
  text: string;
  /** 測った大きさ（px） */
  w: number;
  h: number;
}

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private shell: ShopShell | null = null;
  private shellStage = -1;
  /** 壁に飾った芸能人のサイン */
  private autographs: { group: THREE.Group; dispose(): void } | null = null;
  private autographKey = '';
  /** YouTuber がカウンターに置いて撮っているスマホ */
  private filmPhones = new Map<string, THREE.Object3D>();
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
  /** 描画の大きさ（CSS ピクセル。resize で更新し、毎回レイアウトを読まない） */
  private viewW = 1;
  private viewH = 1;
  /** 描画の解像度の倍率（端末の速さに合わせて自動で上げ下げする） */
  private res: ResolutionGovernor;
  private edgeShown = false;
  /** チュートリアルの目印（対象の上で上下する矢印。物に隠れても見える） */
  private tutMarker: THREE.Group;
  private tutTargetId: string | null = null;
  private tutPos: THREE.Vector3 | null = null;
  /** 目印が画面の外にあるときに、画面の端で向きを示す矢印 */
  private tutEdge: HTMLElement;
  private hemi: THREE.HemisphereLight;
  private sun: THREE.DirectionalLight;
  /** 爆発事故の演出（予兆・焼け跡） */
  private after: Aftermath;
  private accident: AccidentState | null = null;
  /** 焼け跡を表示中（人物は倒れ、椅子は倒れ、丼は床に散らばる） */
  private burned = false;
  /** カメラの演出（揺れ・目の高さ・傾き。爆発で倒れて、目覚めて起き上がる） */
  private camFx = { shake: 0, eyeY: EYE_HEIGHT, roll: 0 };

  constructor(
    private canvas: HTMLCanvasElement,
    private overlay: HTMLElement,
    quality: Quality,
  ) {
    this.quality = quality;
    this.res = new ResolutionGovernor(() => this.ratioCap(), MIN_PIXEL_RATIO);
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
    this.hemi = hemi;
    const sun = new THREE.DirectionalLight('#fff1d6', 1.2);
    this.sun = sun;
    sun.position.set(-6, 12, -10);
    sun.castShadow = quality === 'high';
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -14;
    sun.shadow.camera.right = 14;
    sun.shadow.camera.top = 14;
    sun.shadow.camera.bottom = -14;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.tutMarker = makeTutorialMarker();
    this.tutMarker.visible = false;
    this.scene.add(this.tutMarker);
    this.tutEdge = document.createElement('div');
    this.tutEdge.className = 'tut-edge';
    this.tutEdge.textContent = '➤';
    this.overlay.appendChild(this.tutEdge);
    this.after = new Aftermath(this.scene);
    this.resize();
  }

  /** 爆発事故の状態（なければ null）。毎フレーム渡す */
  setAccident(acc: AccidentState | null): void {
    this.accident = acc;
  }

  /** カメラの演出（揺れの大きさ m・目の高さ m・傾き rad） */
  setCameraFx(shake: number, eyeY: number, roll: number): void {
    this.camFx.shake = shake;
    this.camFx.eyeY = eyeY;
    this.camFx.roll = roll;
  }

  /** チュートリアルで見てほしい物（設備・席・床の汚れの ID）。null で消す */
  setTutorialTarget(id: string | null): void {
    this.tutTargetId = id;
  }

  private tutorialTargetPos(s: GameState): THREE.Vector3 | null {
    const id = this.tutTargetId;
    if (!id) return null;
    const e = s.equipment.find((x) => x.id === id && x.placed);
    if (e) {
      const c = equipmentCenter(e);
      return new THREE.Vector3(c.x, (EQUIPMENT[e.type]?.h ?? 1) + 0.45, c.z);
    }
    const seat = s.seats.find((x) => x.id === id);
    if (seat) {
      const c = seatCounterPoint(s, seat);
      return new THREE.Vector3(c.x, 1.45, c.z);
    }
    const d = s.dirt.find((x) => x.id === id);
    if (d) return new THREE.Vector3(d.pos.x, 0.7, d.pos.z);
    return null;
  }

  private updateTutorialMarker(s: GameState, t: number): void {
    this.tutPos = this.tutorialTargetPos(s);
    this.tutMarker.visible = !!this.tutPos;
    if (!this.tutPos) return;
    this.tutMarker.position.copy(this.tutPos);
    this.tutMarker.position.y += Math.sin(t * 4) * 0.06;
    this.tutMarker.rotation.y = t * 1.5;
  }

  /** 目印が画面の外（後ろ・横）にあるときは、画面の端に向きを示す矢印を出す */
  private updateTutorialEdge(): void {
    const p = this.tutPos;
    if (!p) {
      this.showEdge(false);
      return;
    }
    const v = p.clone().project(this.camera);
    const behind = v.z > 1;
    let x = behind ? -v.x : v.x;
    let y = behind ? -v.y : v.y;
    if (!behind && Math.abs(x) <= 0.92 && Math.abs(y) <= 0.86) {
      this.showEdge(false);
      return;
    }
    if (behind && Math.abs(x) < 0.05) x = 0.05; // 真後ろなら横に寄せて向きを示す
    const k = 1 / Math.max(Math.abs(x) / 0.88, Math.abs(y) / 0.78, 1e-6);
    x *= k;
    y *= k;
    const w = this.viewW;
    const hgt = this.viewH;
    this.showEdge(true);
    this.tutEdge.style.left = `${((x + 1) / 2) * w}px`;
    this.tutEdge.style.top = `${((1 - y) / 2) * hgt}px`;
    this.tutEdge.style.transform = `translate(-50%, -50%) rotate(${-Math.atan2(y, x)}rad)`;
  }

  setQuality(q: Quality): void {
    this.quality = q;
    this.res.reset();
    this.resize();
  }

  /** 画質ごとの解像度の上限 */
  private ratioCap(): number {
    const dpr = window.devicePixelRatio || 1;
    return this.quality === 'low' ? 1 : this.quality === 'medium' ? Math.min(1.5, dpr) : Math.min(2, dpr);
  }

  /** 今の解像度の倍率（性能表示用） */
  get pixelRatio(): number {
    return this.res.ratio;
  }

  /** 描いたフレームごとに、前のフレームからの実際の間隔（秒）を渡す。重い端末では描画の解像度を下げる（render/resolution.ts） */
  adaptResolution(interval: number): void {
    if (this.res.sample(interval, performance.now() / 1000)) this.resize();
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const hgt = this.canvas.clientHeight || window.innerHeight;
    this.viewW = w;
    this.viewH = hgt;
    this.renderer.setPixelRatio(Math.min(this.res.ratio, this.ratioCap()));
    this.renderer.setSize(w, hgt, false);
    this.camera.aspect = w / Math.max(1, hgt);
    // 横に長い画面（iPhone の横向きは約 2.2:1）で縦の画角を固定すると左右が大きく引き伸ばされるので、
    // 横の画角を約 100° に保つよう縦の画角を決める（PC の 16:10 では従来とほぼ同じ 73°）
    const halfH = Math.atan(Math.tan(THREE.MathUtils.degToRad(HORIZONTAL_FOV / 2)) / this.camera.aspect);
    this.camera.fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(halfH * 2), 55, 75);
    this.camera.updateProjectionMatrix();
  }

  // ───────────────── 同期 ─────────────────

  /** 芸能人のサインを壁の決まった場所に飾る（店の段階が変わったら場所を作り直す。レイアウトの変更には影響されない） */
  private syncAutographs(s: GameState): void {
    const signs = s.events?.signs ?? [];
    const key = `${s.career.stage}|${signs.map((x) => `${x.celebId}:${x.visits}`).join(',')}`;
    if (key === this.autographKey) return;
    this.autographKey = key;
    this.autographs?.dispose();
    this.autographs = null;
    if (signs.length === 0) return;
    this.autographs = createAutographs(signs, signSlots(STAGES[s.career.stage]!));
    this.scene.add(this.autographs.group);
  }

  /** 撮影中の YouTuber のスマホ（カウンターの丼の横に立てて置く） */
  private syncFilmPhones(s: GameState): void {
    const want = new Set<string>();
    for (const c of s.customers) {
      const f = c.special?.film;
      if (!f || f.filming !== 'filming' || !c.seatId || (c.state !== 'seated' && c.state !== 'eating')) continue;
      const seat = s.seats.find((x) => x.id === c.seatId);
      if (!seat) continue;
      want.add(c.id);
      let m = this.filmPhones.get(c.id);
      if (!m) {
        m = createHeldItem('phone');
        this.filmPhones.set(c.id, m);
        this.scene.add(m);
      }
      const p = seatCounterPoint(s, seat);
      m.position.set(p.x + 0.2, COUNTER_TOP + 0.13, p.z + 0.05);
      m.rotation.set(0, Math.PI, 0);
    }
    for (const [id, m] of this.filmPhones) {
      if (want.has(id)) continue;
      m.removeFromParent();
      this.filmPhones.delete(id);
    }
  }

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
      // 焼け跡では設備が少し傾き、壊れたように見せる
      entry.model.group.rotation.z = this.burned ? (hash01(e.id, 1) - 0.5) * 0.22 : 0;
      entry.model.group.rotation.x = this.burned ? (hash01(e.id, 2) - 0.5) * 0.1 : 0;
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

  private charEntry(id: string, kind: 'customer' | 'employee' | 'player', seed: number, color?: string, look?: Customer['look']): CharEntry {
    let c = this.chars.get(id);
    if (!c) {
      const model = createCharacter({ kind, seed, color, look });
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

  /** タバコの煙を出す・消す */
  private setSmoke(c: CharEntry, on: boolean): void {
    if (on && !c.smoke) {
      const plume = createSteam({ count: 5, radius: 0.03, rise: 0.7, size: 0.16, speed: 0.35, spread: 0.05, color: '#d8d8d8', opacity: 0.4, seed: 17 });
      plume.position.set(0.12, 1.55, 0.22);
      c.model.group.add(plume);
      c.smoke = plume;
    } else if (!on && c.smoke) {
      c.smoke.removeFromParent();
      const m = c.smoke as THREE.Mesh;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      c.smoke = null;
    }
  }

  private syncCharacters(s: GameState, myId: string, t: number, dt: number, smooth: boolean): void {
    const seen = new Set<string>();
    for (const cu of s.customers) {
      if (cu.state === 'left' || cu.state === 'abandoned') continue;
      seen.add(cu.id);
      const c = this.charEntry(cu.id, 'customer', cu.appearance, undefined, cu.look);
      const seated = cu.state === 'seated' || cu.state === 'eating' || cu.state === 'complaint' || cu.state === 'afterMeal';
      if (this.burned) {
        // 焼け跡: 座っていた客は椅子から後ろへ倒れ、ほかの客もその場に倒れて動かない
        const seat = seated && cu.seatId ? s.seats.find((x) => x.id === cu.seatId) : undefined;
        const p = seat ? seatPos(s, seat) : cu.pos;
        this.placeChar(c, p.x, p.z, seat ? (hash01(cu.id, 6) - 0.5) * 0.6 : hash01(cu.id, 7) * Math.PI * 2, dt, false);
        c.model.setHeld(null);
        c.model.update('down', t, dt);
        continue;
      }
      if (seated && cu.seatId) {
        const seat = s.seats.find((x) => x.id === cu.seatId);
        const p = seat ? seatPos(s, seat) : cu.pos;
        this.placeChar(c, p.x, p.z, 0, dt, smooth);
      } else {
        this.placeChar(c, cu.pos.x, cu.pos.z, cu.state === 'queue' || cu.state === 'waitingSeat' ? (cu.path.length === 0 ? waitYaw(cu) : null) : null, dt, smooth);
      }
      // SNS を見て来た客は、並んでいる間スマホを見ている。店の前の喫煙客はタバコ
      const smoking = cu.state === 'smoking' && cu.path.length === 0;
      const held: HeldKind | null =
        smoking ? 'cigarette'
        : cu.state === 'crew' && cu.special?.kind === 'tv_camera' ? 'tvcamera'
        : cu.fromBuzz && (cu.state === 'arriving' || cu.state === 'queue' || cu.state === 'waitingSeat') ? 'phone'
        : null;
      c.model.setHeld(held);
      this.setSmoke(c, smoking);
      // 食事の動き（顔を近づける・麺を持ち上げる・すする・スープ・具・箸を置く）。食後の団体は話している
      if (cu.state === 'eating') c.model.setEat(eatMotion(eatProgress(cu.eatLeft, cu.eatTotal), t, hash01(cu.id, 3), !!cu.messy && !cu.messy.calmed));
      // テレビ取材: カメラマンは出演者の方を向いてカメラをかつぎ、スタッフは店の方を向いて待つ
      if (cu.state === 'crew') {
        const kind = cu.special?.kind;
        if (c.moving <= 0) {
          let yaw = 0;
          if (kind === 'tv_camera') {
            const p = s.customers.find((x) => x.special?.kind === 'tv_performer' && x.special.eventId === cu.special?.eventId && x.seatId);
            const seat = p ? s.seats.find((x) => x.id === p.seatId) : undefined;
            if (seat) {
              const sp = seatPos(s, seat);
              yaw = Math.atan2(sp.x - cu.pos.x, sp.z - cu.pos.z);
            }
          }
          this.placeChar(c, cu.pos.x, cu.pos.z, yaw, dt, smooth);
        }
      }
      const groupChat = cu.state === 'afterMeal' && !!cu.group && cu.group.size > 1;
      const pose: CharacterPose = cu.state === 'eating' ? 'eat' : groupChat ? 'chat' : seated ? 'sit' : c.moving > 0 ? 'walk' : 'stand';
      c.model.update(pose, t, dt);
    }
    for (const e of s.employees) {
      if (!e.presentToday) continue;
      seen.add(e.id);
      const c = this.charEntry(e.id, 'employee', hashId(e.id));
      if (this.burned) {
        this.placeChar(c, e.pos.x, e.pos.z, hash01(e.id, 7) * Math.PI * 2, dt, false);
        c.model.setHeld(null);
        c.model.update('down', t, dt);
        continue;
      }
      this.placeChar(c, e.pos.x, e.pos.z, e.ai.state === 'working' || e.work ? e.yaw : null, dt, smooth);
      // サボっている従業員はスマホを見ている
      c.model.setHeld(e.ai.state === 'slacking' && e.hand.kind === 'none' ? 'phone' : heldKind(e.hand));
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
    const st = stageOf(s);
    for (const b of s.bowls) {
      if (this.burned) {
        // 焼け跡: 丼は床に散らばる（場所は丼ごとに決まっている）
        this.tmpV.set(0.4 + hash01(b.id, 4) * (st.w * CELL - 0.8), 0.05, 0.4 + hash01(b.id, 5) * (st.d * CELL - 0.8));
      } else {
        if (b.loc.at === 'rack' || b.loc.at === 'sink') continue;
        if (b.loc.at === 'hand' && b.loc.actorId === myId) continue;
        if (!this.bowlPosition(s, b, myId, this.tmpV)) continue;
      }
      seen.add(b.id);
      let m = this.bowls.get(b.id);
      if (!m) {
        m = createBowl();
        this.bowls.set(b.id, m);
        this.scene.add(m.group);
        (m as BowlModel & { _key?: string })._key = '';
      }
      m.group.position.copy(this.tmpV);
      if (this.burned) m.group.rotation.set((hash01(b.id, 8) - 0.5) * 2.6, hash01(b.id, 9) * 6.28, 1.2 + hash01(b.id, 10) * 0.6);
      else if (m.group.rotation.z !== 0) m.group.rotation.set(0, 0, 0);
      const near = this.tmpV.distanceTo(camPos) < 2.2;
      // 食べている客の丼は、食べた分だけ中身を減らして見せる（5段階）
      let eaten = 0;
      if (b.state === 'served' && b.loc.at === 'seat') {
        const seatId = b.loc.seatId;
        const eater = s.customers.find((x) => x.seatId === seatId && x.state === 'eating');
        if (eater) eaten = eatenStep(eatProgress(eater.eatLeft, eater.eatTotal));
      }
      const key = this.burned
        ? `burned|${near ? 'h' : 'l'}`
        : `${b.state}|${b.contents ? `${b.contents.steps.length}|${b.contents.buta}|${b.contents.noodleG}|${Object.values(b.contents.toppings).join(',')}|${b.contents.tare}|${Math.round(b.contents.heat / 10)}` : 'x'}|${near ? 'h' : 'l'}|${eaten}`;
      const mm = m as BowlModel & { _key?: string };
      if (mm._key !== key) {
        mm._key = key;
        m.setDetail(near ? 'high' : 'low');
        if (this.burned) m.setContents(null, { dirty: true });
        else m.setContents(b.state === 'dirty' ? null : b.contents && eaten > 0 ? eatenContents(b.contents, eaten) : b.contents, { dirty: b.state === 'dirty' });
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
    const fx = this.camFx;
    const sx = fx.shake > 0 ? (Math.random() - 0.5) * fx.shake : 0;
    const sy = fx.shake > 0 ? (Math.random() - 0.5) * fx.shake : 0;
    this.camera.position.set(x + sx, fx.eyeY + bobY + sy, z + sx * 0.5);
    this.camera.rotation.set(pitch + sy * 0.3, yaw + Math.PI, fx.roll);
  }

  /** 視線の方向（正規化） */
  viewDir(): [number, number, number] {
    const d = new THREE.Vector3();
    this.camera.getWorldDirection(d);
    return [d.x, d.y, d.z];
  }

  update(s: GameState, myId: string, t: number, dt: number, smooth: boolean): void {
    this.syncShell(s);
    this.syncAutographs(s);
    this.syncFilmPhones(s);
    this.updateAccident(s, t, dt);
    this.syncEquipment(s, t, dt);
    this.syncStools(s);
    this.tipStools();
    this.syncCharacters(s, myId, t, dt, smooth);
    this.syncBowls(s, myId);
    this.syncDirtAndLost(s);
    this.syncViewModel(s, s.players.find((p) => p.id === myId), t);
    this.updateTutorialMarker(s, t);
    for (const m of this.bowls.values()) (m as BowlModel & { tick?: (t: number) => void }).tick?.(t);
    tickModels(t);
    this.overlayAcc += dt;
    if (this.overlayAcc > 0.08) {
      this.overlayAcc = 0;
      this.updateOverlay(s);
      this.updateTutorialEdge();
    }
  }

  /** 爆発事故: 予兆の火花・ガス、焼け跡への切り替えと戻し */
  private updateAccident(s: GameState, t: number, dt: number): void {
    const acc = this.accident;
    const burned = acc?.stage === 'destroyed';
    if (burned && !this.after.burned) {
      const st = stageOf(s);
      this.after.enter([this.hemi, this.sun, ...this.lights], { w: st.w * CELL, d: st.d * CELL }, acc.pos);
    } else if (!burned && this.after.burned) {
      this.after.exit();
    }
    this.burned = burned;
    this.after.setWarning(acc?.stage === 'warning', acc?.pos ?? null, t);
    if (acc?.stage === 'warning') this.after.tickWarning(dt);
    this.after.update(t, dt, burned ? acc.pos : null);
  }

  /** 焼け跡では椅子を倒す（戻ったら起こす） */
  private tipStools(): void {
    for (const [id, o] of this.stools) {
      const want = this.burned ? (hash01(id, 3) > 0.5 ? 1 : -1) * 1.45 : 0;
      if (o.rotation.z === want) continue;
      o.rotation.z = want;
      o.position.y = this.burned ? 0.17 : 0;
    }
  }

  private showEdge(on: boolean): void {
    if (this.edgeShown === on) return;
    this.edgeShown = on;
    this.tutEdge.style.display = on ? 'block' : 'none';
  }

  /** 吹き出し（客のセリフ）と席番号。画面からはみ出さず、重ならないように置く（第2版 13-3） */
  private updateOverlay(s: GameState): void {
    const w = this.viewW;
    const hgt = this.viewH;
    const seen = new Set<string>();
    const items: BubbleBox[] = [];
    const show = (id: string, text: string, pos: THREE.Vector3, cls: string, priority: number) => {
      const v = pos.clone().project(this.camera);
      if (v.z > 1 || v.z < -1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) return;
      if (pos.distanceTo(this.camera.position) > 9) return;
      seen.add(id);
      let b = this.bubbles.get(id);
      if (!b) {
        b = { el: document.createElement('div'), text: '', w: 0, h: 0 };
        this.overlay.appendChild(b.el);
        this.bubbles.set(id, b);
      }
      let changed = false;
      if (b.text !== text) {
        b.text = text;
        b.el.textContent = text;
        changed = true;
      }
      if (b.el.className !== cls) {
        b.el.className = cls;
        changed = true;
      }
      // 大きさは文字・種類が変わったときだけ測る（毎フレーム測らない）
      if (changed || b.w === 0) {
        b.w = b.el.offsetWidth;
        b.h = b.el.offsetHeight + (cls.startsWith('bubble') ? 6 : 0);
      }
      items.push({ id, x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * hgt, w: b.w, h: b.h, priority });
    };
    for (const cu of s.customers) {
      const c = this.chars.get(cu.id);
      if (!c || this.burned) continue;
      const head = c.model.group.position.clone();
      const seated = cu.state === 'seated' || cu.state === 'eating' || cu.state === 'complaint' || cu.state === 'afterMeal';
      head.y += seated ? 1.45 : 1.95;
      if (cu.say && cu.sayUntil > s.t) {
        // イベントのセリフ（団体の会話・クレーム・トラブル・珍しい客・取材など）は縁を変え、少し長く出す。通常のコメント・コールは今までどおり
        const cls = ['bubble', cu.state === 'complaint' ? 'angry' : '', cu.sayStyle === 'whisper' ? 'whisper' : '', cu.sayEvent ? 'event' : ''].filter(Boolean).join(' ');
        show(`say:${cu.id}`, cu.say, head, cls, cu.sayEvent ? 2 : 1);
      } else if (cu.state === 'seated') {
        const seat = s.seats.find((x) => x.id === cu.seatId);
        const ratio = cu.patience / 150;
        if (seat) show(`seat:${cu.id}`, `${seat.index + 1}`, head, `seatno ${ratio < 0.25 ? 'late' : ratio < 0.5 ? 'warn' : ''}`, 0);
      }
    }
    // 従業員の吹き出し（クレームで言い返したときなど。イベントの吹き出し）
    for (const e of s.employees) {
      if (!e.say || e.say.until <= s.t || this.burned) continue;
      const c = this.chars.get(e.id);
      if (!c) continue;
      const head = c.model.group.position.clone();
      head.y += 1.95;
      show(`say:${e.id}`, e.say.text, head, 'bubble angry staff event', 2);
    }
    // 上部の表示（日付・時刻・資金・メニュー）の下から置く
    for (const p of layoutBubbles(items, w, hgt, 6, 46)) {
      const b = this.bubbles.get(p.id);
      if (b) b.el.style.transform = `translate(${Math.round(p.left)}px, ${Math.round(p.top)}px)`;
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
    this.after.dispose();
    for (const e of this.equip.values()) e.model.dispose();
    for (const c of this.chars.values()) c.model.dispose();
    for (const b of this.bowls.values()) b.dispose();
    this.shell?.dispose();
    for (const b of this.bubbles.values()) b.el.remove();
    this.tutEdge.remove();
    this.renderer.dispose();
  }
}

/** チュートリアルの目印: 下を向いた黄色い矢印と輪。物に隠れても見えるよう最前面に描く */
function makeTutorialMarker(): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: '#ffd21f', depthTest: false, transparent: true, opacity: 0.95 });
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.24, 16), mat);
  cone.rotation.x = Math.PI; // 先を下に
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.18, 10), mat);
  stem.position.y = 0.2;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.018, 8, 32), mat);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = -0.2;
  for (const m of [cone, stem, ring]) {
    m.renderOrder = 999;
    g.add(m);
  }
  return g;
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
