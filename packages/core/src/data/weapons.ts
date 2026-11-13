// 隠し扉の奥の武器庫に置く武器（じろ1 5.12。オーナーの判断: 本物の武器・血の表現あり・罰は軽い。2026-11-11）。
// reach = ふつうの手の届く距離に足す距離（m）。銃と爆弾は離れていても狙える。
// じろ2（改修設計書05。オーナーの判断「もっと高く（案の2倍）」→ 2026-11-13「半額に」）: 武器は武器庫で買う。一度買った武器は武器庫に残る。
// 銃は弾（1発ずつ買う）がないと撃てない。爆弾は1個ずつ買い、投げるとなくなる
export type WeaponKind = 'melee' | 'gun' | 'bomb';

export interface WeaponDef {
  id: string;
  name: string;
  kind: WeaponKind;
  /** 操作の名前（斬る・殴る・撃つ・投げる） */
  verb: string;
  reach: number;
  /** 散弾銃: 狙った客からこの距離（m）の中の客にも当たる */
  spread?: number;
  /** 爆弾: 爆発の半径（m）と、投げてから爆発するまで（営業の秒） */
  radius?: number;
  fuse?: number;
  /** 値段（円。爆弾は1個の値段） */
  price: number;
  /** 銃の弾1発の値段 */
  ammoPrice?: number;
  /** 使うとなくなる（爆弾） */
  consumable?: boolean;
}

// オーナーの指示 2026-11-13「武器の値段を半額に」（弾・爆弾も半額）
export const WEAPONS: Record<string, WeaponDef> = {
  katana: { id: 'katana', name: '日本刀', kind: 'melee', verb: '斬る', reach: 0.6, price: 300_000 },
  knife: { id: 'knife', name: '包丁', kind: 'melee', verb: '刺す', reach: 0.15, price: 30_000 },
  bat: { id: 'bat', name: '金属バット', kind: 'melee', verb: '殴る', reach: 0.5, price: 50_000 },
  pipe: { id: 'pipe', name: '鉄パイプ', kind: 'melee', verb: '殴る', reach: 0.5, price: 40_000 },
  pistol: { id: 'pistol', name: '拳銃', kind: 'gun', verb: '撃つ', reach: 9, price: 1_000_000, ammoPrice: 50_000 },
  shotgun: { id: 'shotgun', name: '散弾銃', kind: 'gun', verb: '撃つ', reach: 6, spread: 1.0, price: 1_500_000, ammoPrice: 80_000 },
  bomb: { id: 'bomb', name: '爆弾', kind: 'bomb', verb: '投げる', reach: 6, radius: 2.5, fuse: 2, price: 500_000, consumable: true },
};

export const WEAPON_IDS = Object.keys(WEAPONS);
