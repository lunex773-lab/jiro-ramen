// 出店と店の切り替え（統合進化設計書 v2.1 Phase 2-3）。
// プレイヤーがいる店の中身は GameState の店の部分にあり、ほかの店は stores[].snapshot にある。
// 店を切り替えるときは、閉店後（精算のあと・次の日の前）に中身を入れ替える。会社のお金・借入・キャリアは変わらない。

import { BALANCE } from '../data/balance';
import { INGREDIENTS } from '../data/ingredients';
import { PROPERTIES, PROPERTY_CANDIDATES } from '../data/properties';
import { STAGES } from '../data/stages';
import { fillNewStore } from '../state';
import type { DayReport, DayStats, Employee, GameState, Id, StoreEntry, StorePolicy } from '../types';
import { clamp, newId } from '../util';
import { activeStore, DEFAULT_POLICY, ensureCompany, putStore, storeReport, takeStore } from './company';
import { cash, emptyDayStats, foldIntoLastReport, recordPL } from './economy';
import { addLot, consume, stockOf } from './inventory';
import { emit, notify, type SimCtx } from './notices';
import { runManagerDay } from './manager';

/** 店の表示名（1店舗目は店名の変更に合わせる） */
export function storeDisplayName(s: GameState, entry: StoreEntry): string {
  return entry.propertyId === 'home' ? s.shopName : entry.name;
}

/** 店名の長さの上限（文字数） */
export const STORE_NAME_MAX = 20;

/** 店名に使える形にする（制御文字を除き、空白をまとめ、前後の空白を取り、20文字まで） */
export function cleanStoreName(v: unknown): string {
  const t = String(v ?? '')
    .replace(/[\t\n\r]/g, ' ')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(t).slice(0, STORE_NAME_MAX).join('').trim();
}

/** 2店目以降に自動で付けた名前（屋号＋地域＋店） */
function autoStoreName(shopName: string, entry: StoreEntry): string | null {
  const prop = PROPERTIES[entry.propertyId];
  return prop ? `${shopName} ${prop.area}店` : null;
}

/**
 * 屋号（会社と本店の名前）を変える。2店目以降で自動で付けた名前（屋号＋地域＋店）のままの店は、新しい屋号に合わせる
 * （自分で名前を付けた店はそのまま）
 */
export function renameShop(s: GameState, raw: unknown): { ok: boolean; reason?: string } {
  const name = cleanStoreName(raw);
  if (!name) return { ok: false, reason: '店名を入力してください' };
  const old = s.shopName;
  s.shopName = name;
  for (const entry of s.company?.stores ?? []) {
    if (entry.propertyId === 'home') entry.name = name;
    else if (entry.name === autoStoreName(old, entry)) entry.name = autoStoreName(name, entry) ?? entry.name;
  }
  return { ok: true };
}

/** 店の名前を変える（本店なら屋号を変える） */
export function renameStore(s: GameState, storeId: Id, raw: unknown): { ok: boolean; reason?: string } {
  const entry = s.company?.stores.find((x) => x.id === storeId);
  if (!entry) return { ok: false, reason: '店が見つかりません' };
  if (entry.propertyId === 'home') return renameShop(s, raw);
  const name = cleanStoreName(raw);
  if (!name) return { ok: false, reason: '店名を入力してください' };
  entry.name = name;
  return { ok: true };
}

/** 店の段階と評判（プレイヤーがいる店は GameState、いない店はしまった中身） */
export function storeStatus(s: GameState, entry: StoreEntry): { stage: number; reputation: number; employees: Employee[] } {
  if (!entry.snapshot) return { stage: s.career.stage, reputation: s.reputation, employees: s.employees };
  return { stage: entry.snapshot.stage, reputation: entry.snapshot.reputation, employees: entry.snapshot.employees };
}

// ───────────────────────── 出店 ─────────────────────────

/** 出店できない理由（できるなら null） */
export function openStoreProblem(s: GameState, propertyId: string, managerId: Id): string | null {
  const c = ensureCompany(s);
  const B = BALANCE.company;
  const prop = PROPERTIES[propertyId];
  if (s.tutorial) return 'チュートリアル中は出店できません';
  if (s.phase !== 'closed') return '閉店後にだけ出店できます';
  if (!prop || !PROPERTY_CANDIDATES.includes(propertyId)) return '物件が見つかりません';
  if (c.stores.length >= B.maxStores) return `店は${B.maxStores}店までです`;
  if (c.stores.some((x) => x.propertyId === propertyId)) return 'この物件にはもう出店しています';
  const ready = c.stores.some((x) => {
    const st = storeStatus(s, x);
    return st.stage >= B.unlockStage && st.reputation >= B.unlockReputation;
  });
  if (!ready) return `${STAGES[B.unlockStage]?.seats.length ?? 12}席以上で評判★${B.unlockReputation.toFixed(1)}以上の店があると出店できます`;
  const mgr = s.employees.find((e) => e.id === managerId);
  if (!mgr) return '店長にする社員を選んでください';
  if (mgr.profile.employment !== 'full') return '店長は社員から選びます（アルバイトは社員にしてから）';
  if (s.arrears.length > 0) return '未払いがあると出店できません';
  const need = prop.initialCost + B.minFundsAfterOpen;
  if (s.money < need) return `資金が足りません（初期費用＋運転資金 ¥${need.toLocaleString('ja-JP')} が必要）`;
  return null;
}

/** 従業員を今の仕事から外す（店を移るとき） */
function detach(e: Employee): void {
  e.hand = { kind: 'none' };
  e.ai.taskId = null;
  e.ai.steps = [];
  e.ai.path = [];
  e.ai.stuckTime = 0;
  e.ai.state = 'idle';
  e.ai.note = '';
  e.presentToday = false;
  e.commute = undefined;
}

/**
 * 出店する（閉店後）。初期費用を払い、今の店の社員を店長にして、新しい店の中身を作る。
 * 新しい店は物件の工事の日数だけ休んでから、店長の営業（プレイヤーが入れば細かいシミュレーション）で開く
 */
export function openStore(s: GameState, ctx: SimCtx, propertyId: string, managerId: Id): { ok: boolean; reason?: string; storeId?: Id } {
  const problem = openStoreProblem(s, propertyId, managerId);
  if (problem) return { ok: false, reason: problem };
  const c = s.company;
  const prop = PROPERTIES[propertyId]!;
  if (!cash(s, 'store', -prop.initialCost, `出店（${prop.name}）`, `store:${propertyId}:${s.day}`)) return { ok: false, reason: '資金が足りません' };
  recordPL(s, 'capex', prop.initialCost);
  const cur = activeStore(s);
  const mgr = s.employees.find((e) => e.id === managerId)!;
  s.employees = s.employees.filter((e) => e.id !== managerId);
  if (cur.managerId === managerId) cur.managerId = null;
  detach(mgr);
  const fromRep = s.reputation;
  const prices = { ...s.prices };
  // 新しい店の中身を作って取り出し、今の店に戻す
  const mine = takeStore(s);
  fillNewStore(s, prop.stage);
  s.prices = prices;
  s.autoOrderMode = 'sales';
  s.employees = [mgr];
  const R = BALANCE.reputation.initial;
  s.reputation = clamp(R + (fromRep - R) * BALANCE.company.brandCarry, 1, 5);
  s.closedForConstruction = prop.openingDays;
  const snap = takeStore(s);
  putStore(s, mine);
  const entry: StoreEntry = {
    id: newId(s, 'store'),
    name: `${s.shopName} ${prop.area}店`,
    propertyId,
    openedDay: s.day,
    managerId,
    policy: { ...DEFAULT_POLICY },
    snapshot: snap,
  };
  c.stores.push(entry);
  notify(s, ctx, `store:open:${entry.id}`, 'good', `${entry.name}を出店しました（店長: ${mgr.profile.name}さん）。${prop.openingDays > 0 ? `${prop.openingDays}日の準備のあと` : '明日から'}営業します`);
  emit(ctx, { type: 'storeOpen', text: entry.name });
  return { ok: true, storeId: entry.id };
}

// ───────────────────────── 店に入る（切り替え） ─────────────────────────

/** 日報の損益・客数の部分（DayStats）を写す */
function statsOf(r: DayReport | null): DayStats {
  const t = emptyDayStats();
  if (!r) return t;
  const out = t as unknown as Record<string, unknown>;
  for (const k of Object.keys(t)) {
    const v = (r as unknown as Record<string, unknown>)[k];
    if (v === undefined) continue;
    out[k] = v && typeof v === 'object' ? { ...(v as object) } : v;
  }
  return t;
}

/**
 * 店長が翌日の仕込みを済ませておく（プレイヤーが店に入るとき）。店長の営業の計算は生の食材だけを使うので、
 * 切った豚・ゆでたヤサイなどは切れている。開業の日と同じくらいの量を、在庫の生の食材から作る（足りなければ仕入れる）
 */
const PREP_TOPUP: { item: string; qty: number; raw: [string, number][] }[] = [
  { item: 'pork_block', qty: 2, raw: [['pork_raw', 1], ['soy', 500]] },
  { item: 'buta', qty: 36, raw: [['pork_raw', 1 / 18], ['soy', 500 / 18]] },
  { item: 'yasai', qty: 5000, raw: [['moyashi', 0.8], ['cabbage', 0.2]] },
  { item: 'garlic', qty: 300, raw: [['garlic_raw', 1]] },
  { item: 'abura', qty: 600, raw: [['backfat_raw', 1], ['soy', 0.08]] },
  { item: 'tare', qty: 1500, raw: [['soy', 0.8]] },
];

/** 生の食材を qty だけ使う（足りなければ仕入れる）。使った額を返す（使えなければ null） */
function useRaw(s: GameState, itemId: string, qty: number, key: string): number | null {
  const def = INGREDIENTS[itemId];
  if (!def) return null;
  const have = stockOf(s, itemId);
  if (have < qty && def.purchasable && def.packQty > 0) {
    const packs = Math.ceil((qty - have) / def.packQty);
    const cost = packs * def.packPrice;
    if (cash(s, 'purchase', -cost, `${def.name}の仕入れ（仕込み）`, key)) {
      addLot(s, itemId, packs * def.packQty, def.packPrice / def.packQty);
      s.today.purchases += cost;
    }
  }
  if (stockOf(s, itemId) + 1e-9 < qty) return null;
  const r = consume(s, itemId, qty);
  return r.ok ? r.cost : null;
}

export function prepForEntry(s: GameState): void {
  const day = s.day;
  for (const p of PREP_TOPUP) {
    const need = p.qty - stockOf(s, p.item);
    if (need <= 0) continue;
    let cost = 0;
    let ok = true;
    for (const [raw, per] of p.raw) {
      const c = useRaw(s, raw, need * per, `prep:${day}:${p.item}:${raw}`);
      if (c === null) {
        ok = false;
        break;
      }
      cost += c;
    }
    if (ok) addLot(s, p.item, need, cost / need);
  }
  // 寸胴のスープも開業の日と同じ量まで
  for (const pot of s.equipment.filter((e) => e.type === 'soup_pot' && e.placed)) {
    const add = 18 - pot.soupL;
    if (add <= 0) continue;
    const b = useRaw(s, 'bones', (5000 / 18) * add, `prep:${day}:soup:bones:${pot.id}`);
    const f = b === null ? null : useRaw(s, 'backfat_raw', (400 / 18) * add, `prep:${day}:soup:fat:${pot.id}`);
    if (b === null || f === null) continue;
    pot.soupCost += b + f;
    pot.soupL = 18;
    pot.soupQuality = Math.max(pot.soupQuality, 0.8);
  }
}

/** 店に入れない理由（入れるなら null） */
export function enterStoreProblem(s: GameState, storeId: Id): string | null {
  const c = ensureCompany(s);
  if (s.tutorial) return 'チュートリアル中は店を移れません';
  if (s.phase !== 'closed') return '閉店後にだけ店を移れます（次の営業日からその店で営業します）';
  const target = c.stores.find((x) => x.id === storeId);
  if (!target) return '店が見つかりません';
  if (target.id === c.activeStoreId) return 'すでにこの店にいます';
  if (s.events?.accident) return '事故の片付けが終わるまで移れません';
  return null;
}

/**
 * 店に入る（閉店後）。今の店をしまい、選んだ店の中身を GameState に出す。次の営業日からその店で細かいシミュレーションで営業する。
 * 選んだ店の今日の分がまだなら、先に店長の営業で計算する。今の店は、店長がいれば次の日から店長の営業になる
 */
export function enterStore(s: GameState, ctx: SimCtx, storeId: Id): { ok: boolean; reason?: string } {
  const problem = enterStoreProblem(s, storeId);
  if (problem) return { ok: false, reason: problem };
  const c = s.company;
  const target = c.stores.find((x) => x.id === storeId)!;
  if (target.openedDay < s.day && !storeReport(s, target, s.day)) runManagerDay(s, target, s.day, ctx);
  // 閉店のあとに動いたお金は今の店の日報へ
  foldIntoLastReport(s);
  const cur = activeStore(s);
  cur.snapshot = takeStore(s);
  putStore(s, target.snapshot!);
  target.snapshot = null;
  c.activeStoreId = target.id;
  // 次の日へ進むときの日報の足し込み（foldIntoLastReport）を、この店の今日の日報から始める
  s.today = statsOf(storeReport(s, target, s.day));
  // 店長が翌日の仕込みを済ませておく（仕入れた分は今日の日報に入る）
  prepForEntry(s);
  s.prepSnapshot = null;
  s.layoutVersion += 1;
  const st = STAGES[s.career.stage]!;
  s.players.forEach((p, i) => {
    p.pos = { x: st.playerSpawn.x + i * 0.6, z: st.playerSpawn.z };
    p.hand = { kind: 'none' };
    p.work = null;
  });
  const left = cur.managerId ? '店長の営業になります' : '店長がいないので休業になります（家賃などはかかります）';
  notify(s, ctx, 'store:enter', 'info', `${storeDisplayName(s, target)}に入りました。明日はこの店で営業します（${storeDisplayName(s, cur)}は${left}）`);
  emit(ctx, { type: 'storeEnter', text: storeDisplayName(s, target) });
  return { ok: true };
}

/** 次の日へ進むときに、プレイヤーがいない店のその日を店長の営業で計算する（まだ計算していない店だけ） */
export function runAbsentStores(s: GameState, ctx: SimCtx, day: number): void {
  const c = ensureCompany(s);
  for (const entry of c.stores) {
    if (entry.id === c.activeStoreId || !entry.snapshot) continue;
    if (entry.openedDay >= day) continue;
    if (storeReport(s, entry, day)) continue;
    const md = s.marketDemand?.[entry.id];
    runManagerDay(s, entry, day, ctx, { demandMult: typeof md === 'number' && Number.isFinite(md) && md >= 0 ? md : 1 });
  }
}

// ───────────────────────── 店長・異動・方針 ─────────────────────────

/** 店の従業員の一覧（プレイヤーがいる店は GameState） */
function staffOf(s: GameState, entry: StoreEntry): Employee[] {
  return entry.snapshot ? entry.snapshot.employees : s.employees;
}

/** 店長を決める（社員だけ。null で外す） */
export function assignManager(s: GameState, ctx: SimCtx, storeId: Id, employeeId: Id | null): { ok: boolean; reason?: string } {
  const entry = s.company.stores.find((x) => x.id === storeId);
  if (!entry) return { ok: false, reason: '店が見つかりません' };
  if (employeeId === null) {
    entry.managerId = null;
    return { ok: true };
  }
  const e = staffOf(s, entry).find((x) => x.id === employeeId);
  if (!e) return { ok: false, reason: 'その店の従業員ではありません' };
  if (e.profile.employment !== 'full') return { ok: false, reason: '店長は社員から選びます（アルバイトは社員にしてから）' };
  entry.managerId = employeeId;
  notify(s, ctx, `store:mgr:${entry.id}`, 'good', `${e.profile.name}さんを${storeDisplayName(s, entry)}の店長にしました`);
  return { ok: true };
}

/** 今の店の従業員を、ほかの店へ異動させる（閉店後） */
export function transferEmployee(s: GameState, ctx: SimCtx, employeeId: Id, toStoreId: Id, asManager = false): { ok: boolean; reason?: string } {
  if (s.phase !== 'closed') return { ok: false, reason: '閉店後にだけ異動できます' };
  const to = s.company.stores.find((x) => x.id === toStoreId);
  if (!to || !to.snapshot) return { ok: false, reason: '異動先の店が見つかりません' };
  const e = s.employees.find((x) => x.id === employeeId);
  if (!e) return { ok: false, reason: 'この店の従業員ではありません' };
  if (e.profile.temp) return { ok: false, reason: '短期バイトは異動できません（今日だけ来る人です）' };
  if (asManager && e.profile.employment !== 'full') return { ok: false, reason: '店長は社員から選びます' };
  const cur = activeStore(s);
  s.employees = s.employees.filter((x) => x.id !== employeeId);
  if (cur.managerId === employeeId) cur.managerId = null;
  detach(e);
  to.snapshot.employees.push(e);
  if (asManager) to.managerId = e.id;
  notify(s, ctx, `store:move:${e.id}`, 'info', `${e.profile.name}さんを${storeDisplayName(s, to)}へ異動しました${asManager ? '（店長）' : ''}`);
  return { ok: true };
}

/** 店の方針を変える（範囲の外の値は受け付けない） */
export function setStorePolicy(s: GameState, storeId: Id, p: Partial<StorePolicy>): { ok: boolean; reason?: string } {
  const entry = s.company.stores.find((x) => x.id === storeId);
  if (!entry) return { ok: false, reason: '店が見つかりません' };
  const next = { ...entry.policy, ...p };
  if (!(next.priceMult >= 0.7 && next.priceMult <= 1.5)) return { ok: false, reason: '価格の倍率は0.7〜1.5倍です' };
  if (next.orderMode !== 'manual' && next.orderMode !== 'sales') return { ok: false, reason: '発注の方針が不正です' };
  if (!(next.repairCap >= 0 && next.repairCap <= 500_000)) return { ok: false, reason: '修理費の上限が不正です' };
  if (typeof next.maintenance !== 'boolean') return { ok: false, reason: '定期メンテの指定が不正です' };
  if (next.adBudget !== undefined && !(Number.isFinite(next.adBudget) && next.adBudget >= 0 && next.adBudget <= 20_000)) return { ok: false, reason: '広告費は1日0〜20,000円です' };
  if (next.tempWhenShort !== undefined && typeof next.tempWhenShort !== 'boolean') return { ok: false, reason: '短期バイトの方針が不正です' };
  if (next.safetyStock !== undefined && !(Number.isFinite(next.safetyStock) && next.safetyStock >= 0.8 && next.safetyStock <= 2)) return { ok: false, reason: '在庫の安全基準は0.8〜2倍です' };
  entry.policy = next;
  return { ok: true };
}
