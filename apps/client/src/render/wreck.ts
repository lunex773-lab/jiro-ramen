// 爆発のあとの店内の散らかり方（オーナーの指示「爆発後も店内をもっとぐちゃぐちゃに」）。描画に依存しない純粋な計算（単体テストできる）。
// 同じ事故（id）・同じ店なら必ず同じ散らかり方（共同経営の全員で同じ、何度見ても同じ）。
// 爆心に近いほど多く、強く散らばる。設備は爆心から離れる向きに押され、傾き、いくつかは横倒しになる。

export type DebrisKind =
  /** 落ちた天井の板（大きな板） */
  | 'panel'
  /** 折れた木の板・カウンターの破片 */
  | 'plank'
  /** 壁・床のかけら */
  | 'chunk'
  /** 割れたガラスの破片 */
  | 'shard'
  /** 床の焦げ跡 */
  | 'scorch'
  /** こぼれたスープの水たまり */
  | 'puddle'
  /** 散らばった麺 */
  | 'noodle'
  /** 垂れ下がった電線 */
  | 'wire'
  /** 焦げた紙（食券・メニュー） */
  | 'paper';

export interface Debris {
  kind: DebrisKind;
  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  rz: number;
  /** 大きさ（種類ごとの基準に掛ける） */
  sx: number;
  sy: number;
  sz: number;
}

export interface WreckOpts {
  /** 店の内側の大きさ（m） */
  w: number;
  d: number;
  /** 爆心 */
  blast: { x: number; z: number };
  /** 天井の高さ（m） */
  ceiling: number;
  /** 事故の id（散らかり方の種） */
  seed: string;
}

export interface EquipmentWreck {
  /** 位置のずれ（m） */
  dx: number;
  dz: number;
  /** 傾き（rad） */
  rx: number;
  rz: number;
  /** 向きのずれ（rad） */
  ry: number;
  /** 横倒し */
  toppled: boolean;
}

/** 0..1 の決定的な疑似乱数列（mulberry32） */
function rng(seedStr: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 種類ごとの数（店の広さで増える） */
export const DEBRIS_COUNT: Record<DebrisKind, number> = {
  panel: 7,
  plank: 26,
  chunk: 60,
  shard: 70,
  scorch: 16,
  puddle: 10,
  noodle: 26,
  wire: 6,
  paper: 30,
};

/**
 * 散らばる物の一覧。爆心のまわりに多く、店の内側（壁から少し内側）に収める
 */
export function wreckLayout(o: WreckOpts): Debris[] {
  const r = rng(`wreck:${o.seed}`);
  const area = Math.max(1, (o.w * o.d) / 32);
  const out: Debris[] = [];
  const margin = 0.15;
  const clampX = (x: number) => Math.min(o.w - margin, Math.max(margin, x));
  const clampZ = (z: number) => Math.min(o.d - margin, Math.max(margin, z));
  /** 爆心の近くに寄せた位置（near 0..1: 1 ほど爆心に集まる） */
  const place = (near: number) => {
    if (r() < near) {
      const ang = r() * Math.PI * 2;
      const rad = Math.pow(r(), 0.7) * Math.min(o.w, o.d) * 0.55;
      return { x: clampX(o.blast.x + Math.cos(ang) * rad), z: clampZ(o.blast.z + Math.sin(ang) * rad) };
    }
    return { x: clampX(margin + r() * (o.w - margin * 2)), z: clampZ(margin + r() * (o.d - margin * 2)) };
  };
  const n = (k: DebrisKind) => Math.round(DEBRIS_COUNT[k] * (k === 'panel' || k === 'wire' ? Math.sqrt(area) : area));
  for (let i = 0; i < n('panel'); i++) {
    const p = place(0.6);
    // 片側が床、片側が天井のほうに残って斜めに垂れ下がる板と、床に落ちた板
    const hanging = r() < 0.45;
    out.push({ kind: 'panel', x: p.x, y: hanging ? o.ceiling * 0.55 : 0.04 + r() * 0.06, z: p.z, rx: hanging ? 0.9 + r() * 0.4 : (r() - 0.5) * 0.25, ry: r() * Math.PI, rz: (r() - 0.5) * (hanging ? 0.4 : 0.2), sx: 0.8 + r() * 0.5, sy: 1, sz: 0.5 + r() * 0.4 });
  }
  for (let i = 0; i < n('plank'); i++) {
    const p = place(0.55);
    out.push({ kind: 'plank', x: p.x, y: 0.03 + r() * 0.12, z: p.z, rx: (r() - 0.5) * 0.8, ry: r() * Math.PI * 2, rz: (r() - 0.5) * 0.9, sx: 0.4 + r() * 0.9, sy: 1, sz: 0.7 + r() * 0.6 });
  }
  for (let i = 0; i < n('chunk'); i++) {
    const p = place(0.5);
    const s = 0.05 + Math.pow(r(), 2) * 0.22;
    out.push({ kind: 'chunk', x: p.x, y: s * 0.4, z: p.z, rx: r() * 6.28, ry: r() * 6.28, rz: r() * 6.28, sx: s, sy: s * (0.6 + r() * 0.6), sz: s * (0.7 + r() * 0.5) });
  }
  for (let i = 0; i < n('shard'); i++) {
    // ガラスは正面（z=0 側）の窓の近くに多い
    const front = r() < 0.65;
    const p = front ? { x: clampX(margin + r() * (o.w - margin * 2)), z: clampZ(0.15 + Math.pow(r(), 1.5) * 1.6) } : place(0.4);
    const s = 0.04 + r() * 0.12;
    out.push({ kind: 'shard', x: p.x, y: 0.012, z: p.z, rx: -Math.PI / 2 + (r() - 0.5) * 0.3, ry: 0, rz: r() * 6.28, sx: s, sy: s * (0.5 + r()), sz: 1 });
  }
  for (let i = 0; i < n('scorch'); i++) {
    const p = i < 3 ? { x: clampX(o.blast.x + (r() - 0.5) * 0.8), z: clampZ(o.blast.z + (r() - 0.5) * 0.8) } : place(0.7);
    const s = (i < 3 ? 1.1 : 0.35) + r() * 0.7;
    out.push({ kind: 'scorch', x: p.x, y: 0.006 + i * 0.0004, z: p.z, rx: -Math.PI / 2, ry: 0, rz: r() * 6.28, sx: s, sy: s * (0.6 + r() * 0.5), sz: 1 });
  }
  for (let i = 0; i < n('puddle'); i++) {
    const p = place(0.5);
    const s = 0.25 + r() * 0.45;
    out.push({ kind: 'puddle', x: p.x, y: 0.009 + i * 0.0004, z: p.z, rx: -Math.PI / 2, ry: 0, rz: r() * 6.28, sx: s, sy: s * (0.5 + r() * 0.5), sz: 1 });
  }
  for (let i = 0; i < n('noodle'); i++) {
    const p = place(0.4);
    out.push({ kind: 'noodle', x: p.x, y: 0.012, z: p.z, rx: Math.PI / 2, ry: 0, rz: r() * 6.28, sx: 1, sy: 0.12 + r() * 0.25, sz: 1 });
  }
  for (let i = 0; i < n('wire'); i++) {
    const p = place(0.5);
    const len = 0.7 + r() * 1.2;
    out.push({ kind: 'wire', x: p.x, y: o.ceiling - len / 2, z: p.z, rx: (r() - 0.5) * 0.5, ry: 0, rz: (r() - 0.5) * 0.5, sx: 1, sy: len, sz: 1 });
  }
  for (let i = 0; i < n('paper'); i++) {
    const p = place(0.3);
    out.push({ kind: 'paper', x: p.x, y: 0.008, z: p.z, rx: -Math.PI / 2 + (r() - 0.5) * 0.4, ry: 0, rz: r() * 6.28, sx: 0.08 + r() * 0.06, sy: 0.05 + r() * 0.05, sz: 1 });
  }
  return out;
}

/**
 * 設備の壊れ方。爆心に近いほど遠くへ押され、大きく傾く。いくつかは横倒し（爆心の近くほど多い）
 */
export function equipmentWreck(id: string, center: { x: number; z: number }, blast: { x: number; z: number }, seed: string): EquipmentWreck {
  const r = rng(`eq:${seed}:${id}`);
  let dx = center.x - blast.x;
  let dz = center.z - blast.z;
  const d = Math.hypot(dx, dz);
  if (d < 1e-3) {
    const a = r() * Math.PI * 2;
    dx = Math.cos(a);
    dz = Math.sin(a);
  } else {
    dx /= d;
    dz /= d;
  }
  const force = Math.exp(-d / 3.2);
  const push = 0.12 + 0.55 * force + r() * 0.15;
  const toppled = r() < 0.18 + 0.45 * force;
  return {
    dx: dx * push,
    dz: dz * push,
    rx: toppled ? 0 : (r() - 0.5) * (0.25 + 0.5 * force),
    rz: toppled ? (r() < 0.5 ? -1 : 1) * (1.25 + r() * 0.3) : (r() - 0.5) * (0.35 + 0.6 * force),
    ry: (r() - 0.5) * (0.4 + 1.2 * force),
    toppled,
  };
}

/** 爆発のあとも燃え残っている設備（燃えていた設備のうち、爆心に近いものから数台） */
export function lingeringFires(burning: readonly string[], max = 5): string[] {
  return burning.slice(0, max);
}
