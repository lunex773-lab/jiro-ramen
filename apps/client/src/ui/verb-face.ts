// 操作ボタン（小さな丸いボタン）に出す絵文字と短い名前。
// 正式な名前（core の label。例: 「麺を入れる（2玉）」）は、ボタンの読み上げ名と、押せない理由の表示に使う。

const FACES: Record<string, [icon: string, short: string]> = {
  noodles_in: ['🍜', '麺入れ'],
  noodles_up: ['🥢', '麺上げ'],
  noodles_discard: ['🗑️', '麺捨て'],
  bowls_take: ['🥣', '丼取る'],
  bowls_return: ['↩️', '丼戻す'],
  bowls_place: ['🥣', '並べる'],
  tare: ['🫗', 'タレ'],
  soup: ['🍲', 'スープ'],
  toppings: ['🥬', '盛る'],
  bowl_take: ['✋', '持つ'],
  bowl_discard: ['🗑️', '捨てる'],
  dishes_drop: ['🧺', '置く'],
  wash: ['🧽', '洗う'],
  trash_empty: ['🗑️', 'ゴミ'],
  mop_take: ['🧹', '持つ'],
  mop_return: ['🧹', '片付け'],
  lost_store: ['📦', '保管'],
  lost_return: ['🎁', '返す'],
  ask_call: ['👂', 'コール'],
  serve: ['🍽️', '提供'],
  collect: ['🧺', '下げる'],
  wipe: ['🧻', '拭く'],
  lost_pick: ['👜', '拾う'],
  complaint_apologize: ['🙇', '謝る'],
  complaint_remake: ['🔁', '作り直し'],
  complaint_refund: ['💴', '返金'],
  complaint_explain: ['💬', '説明'],
  complaint_refuse: ['✋', '断る'],
  linger_polite: ['🙏', '声かけ'],
  linger_explain: ['🚶', '混雑説明'],
  linger_request: ['🚪', 'お願い'],
  manner_warn: ['☝️', '注意'],
  manner_wipe: ['🧻', '周り拭く'],
  manner_move: ['💺', '席移動'],
  manner_leave: ['🚪', '退店'],
  smoke_warn: ['🚭', '禁煙'],
  film_stop: ['📵', '撮影NG'],
  film_rules: ['📋', 'ルール'],
  film_leave: ['🚪', '退店'],
  mop: ['🧹', '掃除'],
  'prep:braise_pork': ['🐖', '煮込む'],
  'prep:render_abura': ['🫕', '背脂'],
  'prep:slice_pork': ['🔪', '豚切り'],
  'prep:chop_garlic': ['🧄', '刻む'],
  'prep:boil_veg': ['🥬', 'ゆでる'],
  'prep:boil_moyashi': ['🌱', 'もやし'],
  'prep:simmer_soup': ['🍲', '炊く'],
  'prep:make_noodles': ['🍝', '製麺'],
  // 隠し扉と武器庫（じろ1 5.12）
  armory_door: ['🚪', '押す'],
  'weapon:katana': ['🗡️', '日本刀'],
  'weapon:knife': ['🔪', '包丁'],
  'weapon:bat': ['🏏', 'バット'],
  'weapon:pipe': ['🔧', 'パイプ'],
  'weapon:pistol': ['🔫', '拳銃'],
  'weapon:shotgun': ['🔫', '散弾銃'],
  'weapon:bomb': ['💣', '爆弾'],
  weapon_return: ['↩️', '戻す'],
  attack: ['⚔️', '襲う'],
};

export interface VerbFace {
  icon: string;
  short: string;
  /** 数（「2玉」なら 2、「汚れ40%」なら 40%）。ボタンの隅に小さく出す */
  badge: string | null;
}

export function verbFace(verb: string, label: string): VerbFace {
  const f = FACES[verb];
  let short = f?.[1] ?? label.replace(/（.*$/, '').slice(0, 4);
  // 丼を持っているときの「丼を置く」
  if (verb === 'bowls_place' && label.startsWith('丼を置く')) short = '置く';
  // 武器の操作は「〇〇で斬る / 撃つ / 投げる」の動詞を出す
  if (verb === 'attack') short = label.replace(/^.*で/, '') || short;
  const m = /（(?:見込み|汚れ)?(\d+)(玉|杯|枚|%|秒)）/.exec(label);
  const badge = m ? `${m[1]}${m[2] === '%' || m[2] === '秒' ? m[2] : ''}` : null;
  const icon = verb === 'attack' ? (label.includes('撃つ') ? '🔫' : label.includes('投げる') ? '💣' : label.includes('斬る') || label.includes('刺す') ? '🗡️' : '🏏') : (f?.[0] ?? '👉');
  return { icon, short, badge };
}
