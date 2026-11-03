// 従業員の見た目の個性（オーナーの指示「従業員の見た目にも個性を持たせよう」）。描画に依存しない純粋な計算（単体テストできる）。
// 店の制服の範囲で、Tシャツの色・袖・胸の文字、前掛けの色、頭（タオルの鉢巻・バンダナ・調理帽・キャップ・頭に巻いたタオル・なし）、
// メガネ、ひげ、首のタオル、リストバンドを、従業員ごとの見た目の番号（profile.look。古いセーブは id から）で決める。
// 顔・体格・髪型・肌の色は人物の共通の選び方（character.ts）で、同じ番号から決まる。
// 同じ番号なら必ず同じ見た目（採用の候補のときと採用したあとで変わらない。共同経営の全員で同じ）。

export type StaffHeadwear = 'towel' | 'bandana' | 'cookcap' | 'cap' | 'wrap' | 'none';
export type StaffBeard = 'none' | 'stubble' | 'goatee' | 'mustache' | 'full';

export interface StaffLook {
  /** 女性の従業員（体格・髪型は人物の共通の選び方で、この値に合わせる） */
  female: boolean;
  shirt: string;
  shirtName: string;
  longSleeve: boolean;
  /** 胸と背中の店の文字（なければ null） */
  print: string | null;
  apron: string;
  apronName: string;
  headwear: StaffHeadwear;
  /** 頭に付ける物の色（なしのときは使わない） */
  headColor: string;
  headName: string;
  /** メガネのフレームの色（かけていなければ null） */
  glasses: string | null;
  beard: StaffBeard;
  neckTowel: boolean;
  /** リストバンドの色（なければ null） */
  wristband: string | null;
  /** 女性の従業員は後ろで髪を結ぶことがある */
  ponytail: boolean;
}

interface Choice {
  color: string;
  name: string;
  w: number;
}

const SHIRTS: Choice[] = [
  { color: '#151515', name: '黒', w: 0.24 },
  { color: '#4a4b50', name: '灰色', w: 0.1 },
  { color: '#22335a', name: '紺', w: 0.1 },
  { color: '#7a2430', name: 'えんじ', w: 0.11 },
  { color: '#e0b02e', name: '黄色', w: 0.12 },
  { color: '#ecebe6', name: '白', w: 0.12 },
  { color: '#2f5a3a', name: '緑', w: 0.1 },
  { color: '#6a4a30', name: '茶色', w: 0.08 },
  { color: '#c8582a', name: 'オレンジ', w: 0.05 },
];
const APRONS: Choice[] = [
  { color: '#232a36', name: '紺', w: 0.26 },
  { color: '#141414', name: '黒', w: 0.2 },
  { color: '#c9b88e', name: '生成り', w: 0.14 },
  { color: '#6a4426', name: '茶色', w: 0.14 },
  { color: '#2f4a7a', name: '藍色', w: 0.12 },
  { color: '#33503a', name: '深緑', w: 0.08 },
  { color: '#9a2a2a', name: '赤', w: 0.06 },
];
const HEADWEAR: { kind: StaffHeadwear; w: number }[] = [
  { kind: 'towel', w: 0.34 },
  { kind: 'bandana', w: 0.2 },
  { kind: 'wrap', w: 0.14 },
  { kind: 'cookcap', w: 0.1 },
  { kind: 'cap', w: 0.1 },
  { kind: 'none', w: 0.12 },
];
const BANDANAS: Choice[] = [
  { color: '#141414', name: '黒', w: 1 },
  { color: '#a62626', name: '赤', w: 1 },
  { color: '#1f2f5a', name: '紺', w: 1 },
  { color: '#6a1e26', name: 'えんじ', w: 0.6 },
  { color: '#2d5a3a', name: '緑', w: 0.5 },
  { color: '#d9a92a', name: '黄色', w: 0.4 },
];
const TOWELS: Choice[] = [
  { color: '#f4f4f0', name: '白', w: 3 },
  { color: '#2b3f66', name: '藍色', w: 0.6 },
  { color: '#141414', name: '黒', w: 0.5 },
  { color: '#d9a92a', name: '黄色', w: 0.4 },
];
const CAPS: Choice[] = [
  { color: '#141414', name: '黒', w: 2 },
  { color: '#1f2a44', name: '紺', w: 1 },
  { color: '#ecebe6', name: '白', w: 0.6 },
  { color: '#7a1f1f', name: 'えんじ', w: 0.5 },
];
const FRAMES: Choice[] = [
  { color: '#1c1c1c', name: '黒', w: 3 },
  { color: '#5a3a22', name: '茶色', w: 1 },
  { color: '#9aa0a6', name: '銀', w: 1 },
  { color: '#a02828', name: '赤', w: 0.4 },
];
const BEARDS: { kind: StaffBeard; w: number }[] = [
  { kind: 'none', w: 0.52 },
  { kind: 'stubble', w: 0.16 },
  { kind: 'goatee', w: 0.12 },
  { kind: 'mustache', w: 0.09 },
  { kind: 'full', w: 0.11 },
];
const BANDS: Choice[] = [
  { color: '#f0f0ee', name: '白', w: 1 },
  { color: '#141414', name: '黒', w: 1 },
  { color: '#a62626', name: '赤', w: 0.6 },
];

export const BEARD_NAME: Record<StaffBeard, string> = { none: '', stubble: '無精ひげ', goatee: 'あごひげ', mustache: '口ひげ', full: 'ひげ' };

/** mulberry32（見た目専用。ゲームの乱数とは別） */
function rng(seed: number): () => number {
  let a = (Math.floor(seed) ^ 0x5bd1e995) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weighted<T extends { w: number }>(r: () => number, arr: readonly T[]): T {
  let x = r() * arr.reduce((a, b) => a + b.w, 0);
  for (const it of arr) {
    x -= it.w;
    if (x <= 0) return it;
  }
  return arr[arr.length - 1]!;
}

/** 文字列の id から見た目の番号を作る（古いセーブの従業員など、番号を持たない人用） */
export function lookSeedOfId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 1_000_000;
}

/** 従業員・採用の候補の見た目の番号（profile.look。古いセーブは id から） */
export function lookSeedOf(e: { id: string; profile: { look?: number } }): number {
  return e.profile.look ?? lookSeedOfId(e.id);
}

/** 従業員の見た目を決める（同じ番号なら必ず同じ） */
export function staffLook(seed: number): StaffLook {
  const r = rng(seed * 31 + 7);
  const female = r() < 0.25;
  const shirt = weighted(r, SHIRTS);
  const longSleeve = r() < 0.2;
  // 胸の文字は白か黒（シャツの明るさで決める）
  const light = shirt.name === '白' || shirt.name === '黄色' || shirt.name === 'オレンジ';
  const print = r() < 0.45 ? (light ? '#1a1a1a' : '#f2f2ee') : null;
  let apron = weighted(r, APRONS);
  // 前掛けがシャツと同じ色で見分けにくいときは、ひとつずらす
  if (apron.color === shirt.color || (apron.name === '黒' && shirt.name === '黒' && r() < 0.5)) apron = APRONS[(APRONS.indexOf(apron) + 1) % APRONS.length]!;
  const headwear = weighted(r, HEADWEAR).kind;
  const head =
    headwear === 'bandana'
      ? weighted(r, BANDANAS)
      : headwear === 'towel' || headwear === 'wrap'
        ? weighted(r, TOWELS)
        : headwear === 'cap'
          ? weighted(r, CAPS)
          : headwear === 'cookcap'
            ? { color: '#f6f6f2', name: '白', w: 1 }
            : { color: '#000000', name: '', w: 1 };
  const glasses = r() < 0.26 ? weighted(r, FRAMES).color : null;
  const beardPick = weighted(r, BEARDS).kind;
  const beard: StaffBeard = female ? 'none' : beardPick;
  const neckTowel = headwear !== 'towel' && headwear !== 'wrap' && r() < 0.22;
  const wristband = r() < 0.14 ? weighted(r, BANDS).color : null;
  const ponytail = female && headwear !== 'wrap' && headwear !== 'cookcap' && r() < 0.6;
  const headName =
    headwear === 'towel'
      ? `${head.name}タオルの鉢巻`
      : headwear === 'bandana'
        ? `${head.name}のバンダナ`
        : headwear === 'wrap'
          ? `頭に${head.name}タオル`
          : headwear === 'cookcap'
            ? '白い調理帽'
            : headwear === 'cap'
              ? `${head.name}のキャップ`
              : '帽子なし';
  return {
    female,
    shirt: shirt.color,
    shirtName: shirt.name,
    longSleeve,
    print,
    apron: apron.color,
    apronName: apron.name,
    headwear,
    headColor: head.color,
    headName,
    glasses,
    beard,
    neckTowel,
    wristband,
    ponytail,
  };
}

/** 経営メニューに出す見た目の説明（例: 「黒の長袖・紺の前掛け・赤のバンダナ・メガネ・あごひげ」） */
export function staffLookText(l: StaffLook): string {
  const parts = [`${l.shirtName}の${l.longSleeve ? '長袖' : 'Tシャツ'}`, `${l.apronName}の前掛け`, l.headName];
  if (l.glasses) parts.push('メガネ');
  if (l.beard !== 'none') parts.push(BEARD_NAME[l.beard]);
  if (l.neckTowel) parts.push('首にタオル');
  if (l.wristband) parts.push('リストバンド');
  if (l.ponytail) parts.push('髪を結ぶ');
  return parts.join('・');
}

/** 見た目の違いの目安（同じ組み合わせかを比べる。テスト用） */
export function staffLookKey(l: StaffLook): string {
  return [l.shirt, l.longSleeve, l.apron, l.headwear, l.headColor, l.glasses, l.beard, l.neckTowel].join('|');
}
