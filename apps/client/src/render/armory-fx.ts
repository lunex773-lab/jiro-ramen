// 隠し扉と武器庫の演出（じろ1 5.12。オーナーの判断: 本物の武器・血の表現あり）。
// 物置と扉の開け閉め・投げた爆弾・血しぶき・発砲の光と弾の線・爆発・警察（パトカーの赤色灯）
import * as THREE from 'three';
import { BALANCE, incidentToday, policeCarPos, policeSpawn, STAGES, stageOf, type GameEvent, type GameState } from '@jiro/core';
import { canvasTexture, JP_FONT } from './models/textures';
import { createArmory, createWeapon, type ArmoryModel } from './models/weapons';

interface Particle {
  mesh: THREE.Mesh;
  v: THREE.Vector3;
  life: number;
  max: number;
  kind: 'blood' | 'spark' | 'flash' | 'tracer';
}

const EYE = 1.45;

export class ArmoryFx {
  private model: ArmoryModel | null = null;
  private stage = -1;
  private bombs = new Map<string, THREE.Object3D>();
  private parts: Particle[] = [];
  private police: THREE.Group | null = null;
  private policeLight: THREE.Mesh | null = null;
  private policeDoor: THREE.Group | null = null;
  private policeFrontDoor: THREE.Group | null = null;
  private doorAngle = 0;
  private frontAngle = 0;
  private last: GameState | null = null;
  private bloodGeo = new THREE.SphereGeometry(0.025, 6, 4);
  private bloodMat = new THREE.MeshBasicMaterial({ color: '#8a0d0d' });
  private sparkMat = new THREE.MeshBasicMaterial({ color: '#ffd27a' });
  private blastMat = new THREE.MeshBasicMaterial({ color: '#ff8a2a', transparent: true, opacity: 0.85 });

  constructor(private scene: THREE.Scene) {}

  update(s: GameState, dt: number, t: number): void {
    this.last = s;
    // 物置（店の大きさが変わったら作り直す）
    if (this.stage !== s.career.stage || !this.model) {
      if (this.model) this.scene.remove(this.model.group);
      this.model = createArmory(STAGES[s.career.stage] ?? stageOf(s));
      this.stage = s.career.stage;
      this.scene.add(this.model.group);
    }
    this.model.setOpen(!!s.armory?.doorOpen, dt);
    // 投げた爆弾
    const seen = new Set<string>();
    for (const b of s.armory?.bombs ?? []) {
      seen.add(b.id);
      let o = this.bombs.get(b.id);
      if (!o) {
        o = createWeapon('bomb');
        this.bombs.set(b.id, o);
        this.scene.add(o);
      }
      o.position.set(b.pos.x, 0.07, b.pos.z);
      o.rotation.y = t * 3;
    }
    for (const [id, o] of this.bombs) {
      if (seen.has(id)) continue;
      this.scene.remove(o);
      this.bombs.delete(id);
    }
    // 警察（その日の事件で通報されたら、警察が来る少し前にパトカーが道を走って来て店の前に止まる）
    const inc = incidentToday(s);
    const arrive = BALANCE.armory.carArriveSec;
    const showPolice = !!inc && (inc.police || s.t >= inc.policeAt - arrive);
    if (showPolice && !this.police) this.addPolice(s);
    if (!showPolice && this.police) {
      this.scene.remove(this.police);
      this.police = null;
      this.policeLight = null;
      this.policeDoor = null;
      this.policeFrontDoor = null;
    }
    if (this.police && inc) {
      const c = policeCarPos(stageOf(s));
      // 右から走って来て、止まる前にゆっくりになる
      const k = inc.police ? 0 : Math.max(0, Math.min(1, (inc.policeAt - s.t) / arrive));
      this.police.position.set(c.x + k * k * 26, 0, c.z);
      // 扉: 警察官が乗り降りするとき・犯人を乗せるときに開き、みんな乗ったら閉まる
      const st = stageOf(s);
      const a = inc.arrest;
      const near = (i: number, extra: { x: number; z: number }[] = []) => {
        const p = policeSpawn(st, i);
        return [...(a?.officers ?? []).filter((o) => !o.inCar).map((o) => o.pos), ...extra].some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 1.2);
      };
      const attacker = a?.attackerId ? s.players.find((x) => x.id === a.attackerId) : undefined;
      const rearOpen = !!a && !a.done && (a.phase === 'escort' || (a.phase === 'board' && !a.officers.every((o) => o.inCar)) || near(1, attacker ? [attacker.pos] : []));
      const frontOpen = !!a && !a.done && near(0);
      this.doorAngle += ((rearOpen ? -1.15 : 0) - this.doorAngle) * Math.min(1, dt * 4);
      this.frontAngle += ((frontOpen ? -1.1 : 0) - this.frontAngle) * Math.min(1, dt * 4);
      if (this.policeDoor) this.policeDoor.rotation.y = this.doorAngle;
      if (this.policeFrontDoor) this.policeFrontDoor.rotation.y = this.frontAngle;
    }
    if (this.policeLight) (this.policeLight.material as THREE.MeshBasicMaterial).color.set(Math.floor(t * 4) % 2 ? '#ff2020' : '#7a0808');
    // 粒
    for (const p of this.parts) {
      p.life += dt;
      if (p.kind === 'blood' || p.kind === 'spark') {
        p.v.y -= 9.8 * dt;
        p.mesh.position.addScaledVector(p.v, dt);
        if (p.mesh.position.y < 0.01) {
          p.mesh.position.y = 0.01;
          p.v.set(0, 0, 0);
        }
      } else if (p.kind === 'flash') {
        const k = p.life / p.max;
        p.mesh.scale.setScalar(0.3 + 3 * k);
        (p.mesh.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - k);
      }
    }
    for (const p of this.parts.filter((x) => x.life >= x.max)) this.scene.remove(p.mesh);
    this.parts = this.parts.filter((x) => x.life < x.max);
  }

  onEvents(events: GameEvent[]): void {
    const s = this.last;
    if (!s) return;
    for (const ev of events) {
      switch (ev.type) {
        case 'hurt':
          if (ev.pos) this.blood(ev.pos.x, ev.pos.z);
          break;
        case 'gunshot': {
          // 弾道: 撃った人から弾の行き先（当たった人・外れたら照準の先）まで
          const a = [...s.players, ...s.employees].find((x) => x.id === ev.actorId);
          const c = s.customers.find((x) => x.id === ev.targetId) ?? s.employees.find((x) => x.id === ev.targetId) ?? s.players.find((x) => x.id === ev.targetId);
          const end = ev.pos ?? c?.pos;
          if (a && end) this.tracer(a.pos.x, a.pos.z, end.x, end.z);
          break;
        }
        case 'bombBlast':
          if (ev.pos) this.blast(ev.pos.x, ev.pos.z);
          break;
        default:
          break;
      }
    }
  }

  private blood(x: number, z: number): void {
    for (let i = 0; i < 16; i++) {
      const m = new THREE.Mesh(this.bloodGeo, this.bloodMat);
      m.position.set(x, 1.1 + Math.random() * 0.3, z);
      const a = Math.random() * Math.PI * 2;
      const sp = 0.6 + Math.random() * 1.6;
      this.scene.add(m);
      this.parts.push({ mesh: m, v: new THREE.Vector3(Math.cos(a) * sp, 1 + Math.random() * 2, Math.sin(a) * sp), life: 0, max: 1.2, kind: 'blood' });
    }
  }

  private tracer(x0: number, z0: number, x1: number, z1: number): void {
    const from = new THREE.Vector3(x0, EYE - 0.25, z0);
    const to = new THREE.Vector3(x1, 1.15, z1);
    const len = from.distanceTo(to);
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.012, len), this.sparkMat);
    m.position.copy(from).add(to).multiplyScalar(0.5);
    m.lookAt(to);
    this.scene.add(m);
    this.parts.push({ mesh: m, v: new THREE.Vector3(), life: 0, max: 0.08, kind: 'tracer' });
  }

  private blast(x: number, z: number): void {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 12), this.blastMat.clone());
    m.position.set(x, 0.5, z);
    this.scene.add(m);
    this.parts.push({ mesh: m, v: new THREE.Vector3(), life: 0, max: 0.6, kind: 'flash' });
    for (let i = 0; i < 24; i++) {
      const sp = new THREE.Mesh(this.bloodGeo, this.sparkMat);
      sp.position.set(x, 0.3, z);
      const a = Math.random() * Math.PI * 2;
      const v = 2 + Math.random() * 4;
      this.scene.add(sp);
      this.parts.push({ mesh: sp, v: new THREE.Vector3(Math.cos(a) * v, 2 + Math.random() * 3, Math.sin(a) * v), life: 0, max: 1.0, kind: 'spark' });
    }
  }

  /** パトカー（白黒。車体は x の向きに長く、前は -x。店の側（+z）の後ろの扉が開く） */
  private addPolice(s: GameState): void {
    const c = policeCarPos(stageOf(s));
    const g = new THREE.Group();
    const white = new THREE.MeshStandardMaterial({ color: '#f2f2f2', roughness: 0.35 });
    const black = new THREE.MeshStandardMaterial({ color: '#121212', roughness: 0.35 });
    const glass = new THREE.MeshStandardMaterial({ color: '#1e2a33', roughness: 0.1, metalness: 0.4 });
    const tire = new THREE.MeshStandardMaterial({ color: '#0b0b0b', roughness: 0.9 });
    const box = (m: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number) => {
      const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      o.position.set(x, y, z);
      g.add(o);
      return o;
    };
    // 下は白（扉の面）、ボンネット・屋根・トランクは黒
    box(white, 4.3, 0.5, 1.7, 0, 0.55, 0);
    box(black, 4.3, 0.18, 1.72, 0, 0.33, 0);
    box(black, 1.1, 0.06, 1.66, -1.6, 0.83, 0);
    box(black, 0.8, 0.06, 1.66, 1.75, 0.83, 0);
    box(glass, 2.3, 0.5, 1.5, -0.05, 1.08, 0);
    box(black, 2.1, 0.08, 1.46, 0, 1.36, 0);
    const bar = box(new THREE.MeshBasicMaterial({ color: '#ff2020' }), 0.95, 0.12, 0.32, -0.1, 1.46, 0);
    for (const [x, z] of [[-1.35, 0.78], [1.35, 0.78], [-1.35, -0.78], [1.35, -0.78]] as const) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.24, 16), tire);
      w.rotation.x = Math.PI / 2;
      w.position.set(x, 0.33, z);
      g.add(w);
    }
    // 前の扉の「警察」の文字（店の側）
    const tex = canvasTexture(256, 96, (ctx, w, h) => {
      ctx.fillStyle = '#f2f2f2';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#111';
      ctx.font = `900 64px ${JP_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('警 察', w / 2, h / 2 + 4);
    });
    // 前の扉（蝶番は前の縁。警察官が乗り降りするときに開く）。「警察」の文字は扉に
    const front = new THREE.Group();
    front.position.set(-1.0, 0, 0.88);
    const fdoor = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 0.04), white);
    fdoor.position.set(0.45, 0.55, 0);
    const fwin = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.42, 0.03), glass);
    fwin.position.set(0.45, 1.06, -0.01);
    const label = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.3), new THREE.MeshBasicMaterial({ map: tex }));
    label.position.set(0.45, 0.6, 0.022);
    front.add(fdoor, fwin, label);
    g.add(front);
    box(new THREE.MeshStandardMaterial({ color: '#1a1a1a', roughness: 1 }), 0.86, 0.48, 0.006, -0.55, 0.55, 0.856);
    // 後ろの扉（蝶番は前の縁）。乗せるときに開く
    const hinge = new THREE.Group();
    hinge.position.set(0.1, 0, 0.88);
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 0.04), white);
    door.position.set(0.45, 0.55, 0);
    const win = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.42, 0.03), glass);
    win.position.set(0.45, 1.06, -0.01);
    hinge.add(door, win);
    g.add(hinge);
    // 開いた扉の奥（後ろの席）は暗く
    box(new THREE.MeshStandardMaterial({ color: '#1a1a1a', roughness: 1 }), 0.86, 0.48, 0.006, 0.55, 0.55, 0.856);
    g.position.set(c.x, 0, c.z);
    this.scene.add(g);
    this.police = g;
    this.policeLight = bar;
    this.policeDoor = hinge;
    this.policeFrontDoor = front;
    this.doorAngle = 0;
    this.frontAngle = 0;
  }

  dispose(): void {
    if (this.model) this.scene.remove(this.model.group);
    for (const o of this.bombs.values()) this.scene.remove(o);
    for (const p of this.parts) this.scene.remove(p.mesh);
    if (this.police) this.scene.remove(this.police);
  }
}
