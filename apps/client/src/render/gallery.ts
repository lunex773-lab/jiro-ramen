// モデル確認用ギャラリー（model-gallery.html）。
// #bowls / #people / #equipment / #shop / #closeup をハッシュで切り替える。
// ドラッグで回転、ホイール/ピンチで拡大縮小。Playwright のスクリーンショット用に window.__galleryReady を立てる。

import * as THREE from 'three';
import {
  CELL,
  EQUIPMENT,
  EQUIPMENT_IDS,
  PLAYER_COLORS,
  STAGES,
  createGame,
  emptyContents,
  equipmentCenter,
  seatCounterPoint,
  seatPos,
  type BowlContents,
  type GameState,
} from '@jiro/core';
import * as Models from './models';

type Section = 'bowls' | 'people' | 'equipment' | 'shop' | 'closeup';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.02, 200);

// ───────────────────────── UI ─────────────────────────

const SECTIONS: Section[] = ['bowls', 'people', 'equipment', 'shop', 'closeup'];
const SECTION_LABEL: Record<Section, string> = { bowls: '丼', people: '人物', equipment: '設備', shop: '店舗', closeup: '一杯アップ' };

const ui = document.createElement('div');
ui.style.cssText = 'position:fixed;left:0;top:0;right:0;display:flex;gap:6px;padding:8px;flex-wrap:wrap;z-index:2;pointer-events:none';
document.body.appendChild(ui);
for (const s of SECTIONS) {
  const a = document.createElement('a');
  a.href = '#' + s;
  a.textContent = SECTION_LABEL[s];
  a.style.cssText = 'pointer-events:auto;padding:6px 10px;border-radius:6px;background:rgba(0,0,0,.55);color:#fff;text-decoration:none;font:600 13px sans-serif';
  ui.appendChild(a);
}
const stats = document.createElement('div');
stats.style.cssText = 'position:fixed;right:8px;bottom:8px;padding:4px 8px;border-radius:6px;background:rgba(0,0,0,.55);color:#cfc;font:12px monospace;z-index:2';
document.body.appendChild(stats);
const labelLayer = document.createElement('div');
labelLayer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:1;overflow:hidden';
document.body.appendChild(labelLayer);
const labels: { el: HTMLDivElement; pos: THREE.Vector3 }[] = [];

function addLabel(text: string, pos: THREE.Vector3): void {
  const el = document.createElement('div');
  el.textContent = text;
  el.style.cssText = 'position:absolute;left:0;top:0;padding:2px 6px;border-radius:4px;background:rgba(0,0,0,.6);color:#fff;font:600 11px sans-serif;white-space:nowrap;transform-origin:0 0';
  labelLayer.appendChild(el);
  labels.push({ el, pos: pos.clone() });
}

// ───────────────────────── カメラ操作（自作の簡易オービット） ─────────────────────────

const orbit = { target: new THREE.Vector3(), dist: 3, yaw: 0, pitch: 0.5, minDist: 0.2, maxDist: 60 };
function applyOrbit(): void {
  const cp = Math.cos(orbit.pitch);
  camera.position.set(
    orbit.target.x + Math.sin(orbit.yaw) * cp * orbit.dist,
    orbit.target.y + Math.sin(orbit.pitch) * orbit.dist,
    orbit.target.z - Math.cos(orbit.yaw) * cp * orbit.dist,
  );
  camera.lookAt(orbit.target);
}
const pointers = new Map<number, { x: number; y: number }>();
let pinchDist = 0;
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
});
canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  if (pointers.size === 1) {
    orbit.yaw -= (e.clientX - p.x) * 0.006;
    orbit.pitch = THREE.MathUtils.clamp(orbit.pitch + (e.clientY - p.y) * 0.005, -0.2, 1.5);
  } else if (pointers.size === 2) {
    const ps = [...pointers.values()];
    const a = ps[0]!;
    const b = ps[1]!;
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchDist > 0) orbit.dist = THREE.MathUtils.clamp(orbit.dist * (pinchDist / d), orbit.minDist, orbit.maxDist);
    pinchDist = d;
  }
  p.x = e.clientX;
  p.y = e.clientY;
});
const endPointer = (e: PointerEvent) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchDist = 0;
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    orbit.dist = THREE.MathUtils.clamp(orbit.dist * Math.exp(e.deltaY * 0.001), orbit.minDist, orbit.maxDist);
  },
  { passive: false },
);

// ───────────────────────── 照明 ─────────────────────────

function addLights(o: { sunPos?: THREE.Vector3; target?: THREE.Vector3; extent?: number; hemi?: number; sun?: number } = {}): THREE.DirectionalLight {
  const hemi = new THREE.HemisphereLight('#fff4e6', '#5a4a3c', o.hemi ?? 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight('#fff0d8', o.sun ?? 1.6);
  sun.position.copy(o.sunPos ?? new THREE.Vector3(-3, 8, -4));
  sun.target.position.copy(o.target ?? new THREE.Vector3());
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const ex = o.extent ?? 4;
  sun.shadow.camera.left = -ex;
  sun.shadow.camera.right = ex;
  sun.shadow.camera.top = ex;
  sun.shadow.camera.bottom = -ex;
  sun.shadow.camera.near = 0.1;
  sun.shadow.camera.far = 40;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.01;
  sun.shadow.radius = 4;
  scene.add(sun, sun.target);
  return sun;
}

function floorPlane(size: number, color: string): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshStandardMaterial({ color, roughness: 0.9 }));
  m.rotation.x = -Math.PI / 2;
  m.receiveShadow = true;
  scene.add(m);
  return m;
}

// ───────────────────────── 中身のサンプル ─────────────────────────

function contents(o: {
  tare?: number;
  soupL?: number;
  noodleG?: number;
  yasai?: number;
  ninniku?: number;
  abura?: number;
  ichimi?: number;
  buta?: number;
  heat?: number;
}): BowlContents {
  const c = emptyContents(0);
  c.tare = o.tare ?? 1;
  c.soupL = o.soupL ?? 0.35;
  c.noodleG = o.noodleG ?? 300;
  c.toppings.yasai = o.yasai ?? 1;
  c.toppings.ninniku = o.ninniku ?? 0;
  c.toppings.abura = o.abura ?? 0;
  c.toppings.ichimi = o.ichimi ?? 0;
  c.buta = o.buta ?? 2;
  c.heat = o.heat ?? 90;
  return c;
}

const tickers: ((t: number, dt: number) => void)[] = [];

// ───────────────────────── セクション ─────────────────────────

function counterSlab(w: number, d: number, y: number): void {
  const top = new THREE.Mesh(new THREE.BoxGeometry(w, 0.04, d), Models.galleryMaterials.counter());
  top.position.set(0, y - 0.02, 0);
  top.receiveShadow = true;
  scene.add(top);
  const edge = new THREE.Mesh(new THREE.BoxGeometry(w, 0.05, 0.09), Models.galleryMaterials.lightWood());
  edge.position.set(0, y - 0.015, -d / 2 + 0.045);
  edge.receiveShadow = true;
  edge.castShadow = true;
  scene.add(edge);
}

function buildBowls(): void {
  scene.background = new THREE.Color('#2b2622');
  addLights({ sunPos: new THREE.Vector3(-1.5, 4, -2.5), extent: 1.5 });
  counterSlab(3.2, 1.2, 0);
  const list: [string, BowlContents | null, boolean][] = [
    ['空の丼（きれい）', null, false],
    ['食べ終わり（汚れ）', null, true],
    ['小・そのまま', contents({ yasai: 1, buta: 2 }), false],
    ['ヤサイマシマシ ニンニク アブラマシ 唐辛子マシ', contents({ yasai: 3, ninniku: 1, abura: 2, ichimi: 2, buta: 2 }), false],
    ['大豚W カラメ 450g', contents({ tare: 2, noodleG: 450, soupL: 0.4, yasai: 1, ninniku: 1, buta: 8 }), false],
    ['乳化・巻き豚 ニンニクマシ 唐辛子', contents({ yasai: 1, ninniku: 2, abura: 1, ichimi: 1, buta: 5 }), false],
    ['ヤサイ抜き カラカラ', contents({ tare: 3, yasai: 0, ninniku: 1, buta: 2, ichimi: 1 }), false],
    ['タレのみ（盛り付け途中）', contents({ soupL: 0, noodleG: 0, yasai: 0, buta: 0, heat: 20 }), false],
  ];
  const cols = 4;
  list.forEach(([name, c, dirty], i) => {
    const b = Models.createBowl();
    b.setDetail('high');
    b.setContents(c, { dirty });
    const x = ((i % cols) - (cols - 1) / 2) * 0.36;
    const z = (Math.floor(i / cols) - 0.5) * 0.42;
    b.group.position.set(-x, 0, z);
    scene.add(b.group);
    addLabel(name, new THREE.Vector3(-x, 0.28, z));
  });
  orbit.target.set(0, 0.05, 0);
  orbit.dist = 1.75;
  orbit.pitch = 0.75;
  orbit.yaw = 0;
}

function buildCloseup(): void {
  scene.background = new THREE.Color('#3a2f27');
  addLights({ sunPos: new THREE.Vector3(0.4, 3, 0.6), extent: 0.5, hemi: 1.25, sun: 1.7 });
  // 手前上からの柔らかい補助光（店の天井照明のイメージ）
  const fill = new THREE.DirectionalLight('#fff6ea', 0.9);
  fill.position.set(-0.3, 1.2, -1.2);
  scene.add(fill);
  counterSlab(1.6, 0.8, 0);
  // 奥の壁
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(3, 1.5), new THREE.MeshStandardMaterial({ color: '#5a4b3e', roughness: 0.9 }));
  wall.position.set(0, 0.5, 0.45);
  wall.rotation.y = Math.PI;
  scene.add(wall);
  const b = Models.createBowl();
  b.setDetail('high');
  b.setContents(contents({ yasai: 2, ninniku: 2, abura: 1, ichimi: 2, buta: 3 }));
  scene.add(b.group);
  orbit.target.set(0, 0.075, 0.0);
  orbit.dist = 0.4;
  orbit.pitch = 0.88;
  orbit.yaw = 0;
}

function buildPeople(): void {
  scene.background = new THREE.Color('#8fa4b4');
  addLights({ sunPos: new THREE.Vector3(-3, 6, -4), extent: 5 });
  floorPlane(30, '#7c7468');
  const poses: Models.CharacterPose[] = ['stand', 'walk', 'sit', 'eat', 'work', 'carry', 'stand', 'walk'];
  const held: (Models.HeldKind | null)[] = [null, null, null, null, null, 'clean', 'mop', 'trash'];
  const row: { m: Models.CharacterModel; pose: Models.CharacterPose }[] = [];
  for (let i = 0; i < 8; i++) {
    const m = Models.createCharacter({ kind: 'customer', seed: i + 1 });
    const pose = poses[i]!;
    m.group.position.set(-(i - 3.5) * 0.85, 0, 0);
    if (pose === 'sit' || pose === 'eat') {
      const st = Models.createStool();
      st.position.copy(m.group.position);
      scene.add(st);
    }
    m.setHeld(held[i] ?? null);
    scene.add(m.group);
    row.push({ m, pose });
    addLabel(`客 seed${i + 1} ${pose}`, new THREE.Vector3(-(i - 3.5) * 0.85, 2.05, 0));
  }
  const emp = Models.createCharacter({ kind: 'employee', seed: 3 });
  emp.group.position.set(1.7, 0, 1.6);
  emp.setHeld('dirty');
  scene.add(emp.group);
  row.push({ m: emp, pose: 'carry' });
  addLabel('従業員', new THREE.Vector3(1.7, 2.05, 1.6));
  PLAYER_COLORS.forEach((col, i) => {
    const p = Models.createCharacter({ kind: 'player', seed: 10 + i, color: col });
    p.group.position.set(0.85 - i * 0.85, 0, 1.6);
    p.setLabel(['店主', 'たろう', 'はなこ', 'ジロ吉'][i] ?? 'P');
    if (i === 1) p.setHeld('bowl');
    scene.add(p.group);
    row.push({ m: p, pose: i === 2 ? 'work' : i === 1 ? 'carry' : 'stand' });
  });
  tickers.push((t, dt) => {
    for (const r of row) r.m.update(r.pose, t, dt);
  });
  orbit.target.set(0, 0.9, 0.6);
  orbit.dist = 7.2;
  orbit.pitch = 0.22;
  orbit.yaw = 0;
}

function fakeState(): GameState {
  const s = createGame({ seed: 1 });
  s.phase = 'open';
  for (const e of s.equipment) {
    if (e.type === 'noodle_boiler') {
      const mk = (elapsed: number) => ({ orderId: 'o', grams: 300, elapsed, ideal: 25, quality: 1, freshness: 1, unitCost: 1 });
      e.slots = [mk(8), mk(18), mk(25), mk(45)];
    }
    if (e.type === 'braise_pot') e.process = { recipeId: 'braise_pork', elapsed: 30, duration: 80, cost: 0, quality: 1, freshness: 1, startedBy: 'p1' };
    if (e.type === 'veg_boiler') e.status = 'broken';
    if (e.type === 'sink') e.status = 'faulty';
    if (e.type === 'trash') e.fill = 18;
  }
  // 洗い場に汚れた丼を3つ
  const sink = s.equipment.find((e) => e.type === 'sink');
  s.bowls.slice(0, 3).forEach((b) => {
    b.state = 'dirty';
    if (sink) b.loc = { at: 'sink', stationId: sink.id };
  });
  return s;
}

function buildEquipment(): void {
  scene.background = new THREE.Color('#9aa7b0');
  addLights({ sunPos: new THREE.Vector3(-6, 12, -8), extent: 9 });
  floorPlane(40, '#77736c');
  const s = fakeState();
  const types = EQUIPMENT_IDS.filter((id) => (EQUIPMENT[id]?.w ?? 0) > 0);
  const cols = 7;
  const models: { m: Models.EquipmentModel; e: GameState['equipment'][number] }[] = [];
  types.forEach((type, i) => {
    const m = Models.createEquipment(type);
    const x = ((i % cols) - (cols - 1) / 2) * 2.0;
    const z = Math.floor(i / cols) * 2.2 - 3;
    m.group.position.set(-x, 0, z);
    scene.add(m.group);
    let e = s.equipment.find((q) => q.type === type);
    if (!e) {
      e = { ...s.equipment[0]!, id: 'g' + i, type, slots: [], process: null, soupL: 0, status: 'normal', bowlSlots: [], washing: [], washElapsed: 0, fill: 0 };
      if (type === 'noodle_boiler_l') {
        e.slots = Array.from({ length: 6 }, (_, k) => (k % 2 === 0 ? { orderId: 'o', grams: 450, elapsed: k * 7, ideal: 25, quality: 1, freshness: 1, unitCost: 1 } : null));
      }
      if (type === 'soup_pot_l') {
        e.soupL = 40;
        e.process = { recipeId: 'simmer_soup', elapsed: 10, duration: 70, cost: 0, quality: 1, freshness: 1, startedBy: 'p1' };
      }
      if (type === 'dishwasher') e.washElapsed = 5;
      if (type === 'fridge_l') e.status = 'repairing';
      if (type === 'noodle_maker') e.process = { recipeId: 'make_noodles', elapsed: 20, duration: 40, cost: 0, quality: 1, freshness: 1, startedBy: 'p1' };
      if (type === 'assembly_l') e.bowlSlots = Array.from({ length: 6 }, () => null);
    }
    models.push({ m, e });
    addLabel(`${EQUIPMENT[type]?.name ?? type}`, new THREE.Vector3(-x, (EQUIPMENT[type]?.h ?? 1) + 0.45, z));
    // 盛り付け台には丼を置く
    if (type === 'assembly' || type === 'assembly_l') {
      m.bowlAnchors.forEach((a, k) => {
        const b = Models.createBowl();
        b.setDetail('low');
        b.setContents(k === 0 ? null : contents({ yasai: k % 3, ninniku: k % 2, buta: 2 + k, ichimi: k > 2 ? 1 : 0 }));
        b.group.position.copy(a);
        m.group.add(b.group);
      });
    }
  });
  tickers.push((t, dt) => {
    s.t = t;
    for (const { m, e } of models) {
      for (const sl of e.slots) if (sl) sl.elapsed = (sl.elapsed + dt) % 50;
      if (e.process) e.process.elapsed = (e.process.elapsed + dt) % e.process.duration;
      m.update(e, s, t, dt);
    }
  });
  orbit.target.set(0, 0.4, 0);
  orbit.dist = 15;
  orbit.pitch = 0.62;
  orbit.yaw = 0;
}

function buildShop(): void {
  scene.background = new THREE.Color('#b9cfe2');
  scene.fog = new THREE.Fog('#b9cfe2', 25, 70);
  const st = STAGES[0]!;
  const s = fakeState();
  addLights({ sunPos: new THREE.Vector3(-4, 14, -10), target: new THREE.Vector3(4, 0, 3), extent: 12, hemi: 0.75, sun: 1.3 });
  const shell = Models.createShopShell(st, s.shopName);
  scene.add(shell.group);
  for (const p of shell.lightSpots.slice(0, 4)) {
    const l = new THREE.PointLight('#ffe2b8', 6, 9, 1.6);
    l.position.copy(p);
    scene.add(l);
  }
  const models: { m: Models.EquipmentModel; e: GameState['equipment'][number] }[] = [];
  for (const e of s.equipment) {
    const def = EQUIPMENT[e.type];
    if (!def || def.w === 0 || !e.placed) continue;
    const m = Models.createEquipment(e.type);
    const c = equipmentCenter(e);
    m.group.position.set(c.x, 0, c.z);
    m.group.rotation.y = -e.rot * (Math.PI / 2);
    scene.add(m.group);
    models.push({ m, e });
  }
  for (const seat of s.seats) {
    if (!seat.installed) continue;
    const p = seatPos(s, seat);
    const stool = Models.createStool();
    stool.position.set(p.x, 0, p.z);
    scene.add(stool);
  }
  // 客2人と丼
  const sitters: Models.CharacterModel[] = [];
  [1, 4, 5].forEach((idx, k) => {
    const seat = s.seats[idx]!;
    const p = seatPos(s, seat);
    const ch = Models.createCharacter({ kind: 'customer', seed: 20 + k });
    ch.group.position.set(p.x, 0, p.z);
    scene.add(ch.group);
    sitters.push(ch);
    const cp = seatCounterPoint(s, seat);
    const b = Models.createBowl();
    b.setDetail('low');
    b.setContents(contents({ yasai: k + 1, ninniku: 1, ichimi: k, buta: 2 + k * 2 }));
    b.group.position.set(cp.x, Models.COUNTER_TOP_Y, cp.z - 0.06);
    scene.add(b.group);
  });
  // 上げ台に返された丼
  {
    const seat = s.seats[6]!;
    const cp = seatCounterPoint(s, seat);
    const b = Models.createBowl();
    b.setDetail('low');
    b.setContents(null, { dirty: true });
    b.group.position.set(cp.x, Models.COUNTER_SHELF_Y, cp.z + 0.18);
    scene.add(b.group);
  }
  // 厨房の従業員と店主
  const emp = Models.createCharacter({ kind: 'employee', seed: 7 });
  emp.group.position.set(5.0, 0, 3.05);
  emp.group.rotation.y = 0;
  scene.add(emp.group);
  const me = Models.createCharacter({ kind: 'player', seed: 2, color: PLAYER_COLORS[0] });
  me.group.position.set(2.6, 0, 3.0);
  me.group.rotation.y = Math.PI;
  me.setLabel('店主');
  scene.add(me.group);
  // 床の汚れと忘れ物
  const d1 = Models.createDirt('grime');
  d1.position.set(3.4, 0.005, 1.0);
  scene.add(d1);
  const d2 = Models.createDirt('spill');
  d2.position.set(5.2, 0.005, 3.0);
  scene.add(d2);
  const lostSeat = s.seats[3]!;
  const lp = seatCounterPoint(s, lostSeat);
  const lost = Models.createLostItem('文庫本');
  lost.position.set(lp.x + 0.22, Models.COUNTER_TOP_Y + 0.01, lp.z - 0.05);
  scene.add(lost);
  tickers.push((t, dt) => {
    s.t = t;
    for (const { m, e } of models) {
      for (const sl of e.slots) if (sl) sl.elapsed = (sl.elapsed + dt) % 50;
      if (e.process) e.process.elapsed = (e.process.elapsed + dt) % e.process.duration;
      m.update(e, s, t, dt);
    }
    sitters.forEach((c, i) => c.update(i === 1 ? 'sit' : 'eat', t, dt));
    emp.update('work', t, dt);
    me.update('stand', t, dt);
  });
  orbit.target.set((st.w * CELL) / 2, 0.8, (st.d * CELL) / 2 - 0.5);
  orbit.dist = 11;
  orbit.pitch = 0.72;
  orbit.yaw = 0.35;
}

// ───────────────────────── 起動 ─────────────────────────

const section = (location.hash.replace('#', '') || 'bowls') as Section;
window.addEventListener('hashchange', () => location.reload());

switch (section) {
  case 'people':
    buildPeople();
    break;
  case 'equipment':
    buildEquipment();
    break;
  case 'shop':
    buildShop();
    break;
  case 'closeup':
    buildCloseup();
    break;
  default:
    buildBowls();
}

// 縦長画面では少し引く
function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.fov = w < h ? 62 : 45;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();
if (window.innerWidth < window.innerHeight && section !== 'closeup') orbit.dist *= 1.5;

const timer = new THREE.Timer();
let frames = 0;
let t = 0;
const tmpV = new THREE.Vector3();
function frame(now: number): void {
  timer.update(now);
  const dt = Math.min(0.05, timer.getDelta());
  t += dt;
  for (const f of tickers) f(t, dt);
  Models.tickModels(t);
  applyOrbit();
  renderer.render(scene, camera);
  const info = renderer.info.render;
  stats.textContent = `tris ${info.triangles.toLocaleString()} / calls ${info.calls}`;
  const w = window.innerWidth;
  const h = window.innerHeight;
  for (const l of labels) {
    tmpV.copy(l.pos).project(camera);
    const vis = tmpV.z < 1 && Math.abs(tmpV.x) < 1.05 && Math.abs(tmpV.y) < 1.05;
    l.el.style.display = vis ? 'block' : 'none';
    if (vis) l.el.style.transform = `translate(${((tmpV.x + 1) / 2) * w}px, ${((1 - tmpV.y) / 2) * h}px) translate(-50%, -100%)`;
  }
  frames++;
  if (frames === 8) (window as unknown as { __galleryReady: boolean }).__galleryReady = true;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
