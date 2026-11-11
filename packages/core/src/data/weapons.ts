// 隠し扉の奥の武器庫に置く武器（じろ1 5.12。オーナーの判断: 本物の武器・血の表現あり・罰は軽い。2026-11-11）。
// reach = ふつうの手の届く距離に足す距離（m）。銃と爆弾は離れていても狙える
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
}

export const WEAPONS: Record<string, WeaponDef> = {
  katana: { id: 'katana', name: '日本刀', kind: 'melee', verb: '斬る', reach: 0.6 },
  knife: { id: 'knife', name: '包丁', kind: 'melee', verb: '刺す', reach: 0.15 },
  bat: { id: 'bat', name: '金属バット', kind: 'melee', verb: '殴る', reach: 0.5 },
  pipe: { id: 'pipe', name: '鉄パイプ', kind: 'melee', verb: '殴る', reach: 0.5 },
  pistol: { id: 'pistol', name: '拳銃', kind: 'gun', verb: '撃つ', reach: 9 },
  shotgun: { id: 'shotgun', name: '散弾銃', kind: 'gun', verb: '撃つ', reach: 6, spread: 1.0 },
  bomb: { id: 'bomb', name: '爆弾', kind: 'bomb', verb: '投げる', reach: 6, radius: 2.5, fuse: 2 },
};

export const WEAPON_IDS = Object.keys(WEAPONS);
