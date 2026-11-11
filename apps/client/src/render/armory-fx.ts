// 隠し扉と武器庫の演出（じろ1 5.12。オーナーの判断: 本物の武器・血の表現あり）。
// 物置と扉の開け閉め・投げた爆弾・血しぶき・発砲の光と弾の線・爆発・警察（パトカーの赤色灯）
import * as THREE from 'three';
import { incidentToday, STAGES, stageOf, type GameEvent, type GameState } from '@jiro/core';
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
    // 警察（その日の事件で警察が来たら、店の前にパトカー）
    const inc = incidentToday(s);
    const showPolice = !!inc?.police && s.phase !== 'prep';
    if (showPolice && !this.police) this.addPolice(s);
    if (!showPolice && this.police) {
      this.scene.remove(this.police);
      this.police = null;
      this.policeLight = null;
    }
    if (this.policeLight) (this.policeLight.material as THREE.MeshBasicMaterial).color.set(Math.floor(t * 4) % 2 ? '#ff2020' : '#2050ff');
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
          const a = [...s.players, ...s.employees].find((x) => x.id === ev.actorId);
          const c = s.customers.find((x) => x.id === ev.targetId);
          if (a && c) this.tracer(a.pos.x, a.pos.z, c.pos.x, c.pos.z);
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

  private addPolice(s: GameState): void {
    const W = stageOf(s).w * 0.5;
    const g = new THREE.Group();
    const white = new THREE.MeshStandardMaterial({ color: '#f2f2f2', roughness: 0.4 });
    const black = new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.4 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.7, 1.7), black);
    body.position.y = 0.55;
    const doors = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.72, 1.72), white);
    doors.position.y = 0.55;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.55, 1.5), white);
    cabin.position.set(-0.2, 1.15, 0);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.12, 0.3), new THREE.MeshBasicMaterial({ color: '#ff2020' }));
    bar.position.set(-0.2, 1.5, 0);
    g.add(body, doors, cabin, bar);
    g.position.set(W + 2.5, 0, -6.2);
    this.scene.add(g);
    this.police = g;
    this.policeLight = bar;
  }

  dispose(): void {
    if (this.model) this.scene.remove(this.model.group);
    for (const o of this.bombs.values()) this.scene.remove(o);
    for (const p of this.parts) this.scene.remove(p.mesh);
    if (this.police) this.scene.remove(this.police);
  }
}
