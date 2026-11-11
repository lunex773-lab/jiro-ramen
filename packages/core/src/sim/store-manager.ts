// 店長の役割（オーナーの指示 2026-11-11）: 営業のサポートに回りつつ、
//   ・仕込み品が足りなくなりそうなら、すぐに仕込む（急ぎの仕込みを先にする。employees.ts の仕事の選び方）
//   ・材料が閉店までに足りなくなりそうなら、先に当日便で仕入れる（この file）
//   ・閉店後に、その日の営業の数字・曜日・翌日の営業時間と定休日から翌日の来客を予測して、その分を翌朝便で発注する
//     （inventory.ts の forecastNextDay / managerOrderTarget）
// どれも「店長に発注を任せる」店（店長がいて、方針が「自分の設定で」でない店）だけ。プレイヤーがいない店は店長の1日の計算（manager.ts）で、
// その日に出す杯数の分を仕入れる。
import { BALANCE } from '../data/balance';
import { INGREDIENTS } from '../data/ingredients';
import { PREP_RECIPES } from '../data/prep';
import type { Employee, GameState, ManagerForecast } from '../types';
import { dateLabel } from './calendar';
import { activeStore } from './company';
import { hourDemand, sessionSpans, todayHours } from './hours';
import { autoOrderEnabled, managerOrderBudget, managerOrders, packPriceOf, pendingOf, placeOrder, stockOf } from './inventory';
import { clearNotice, notify, type SimCtx } from './notices';

const M = () => BALANCE.storeManager;

/** その店の店長（店にいる従業員のうち店長に決めた人） */
export function storeManagerOf(s: GameState): Employee | null {
  if (!s.company) return null;
  const id = activeStore(s).managerId;
  return id ? (s.employees.find((e) => e.id === id) ?? null) : null;
}

/** 店長が今、店で働いているか（発注を任せている店だけ。出勤前・休憩中・退勤後・欠勤は動かない） */
export function managerOnFloor(s: GameState): Employee | null {
  if (!managerOrders(s)) return null;
  const e = storeManagerOf(s);
  return e && e.presentToday && !e.commute ? e : null;
}

/** 仕入れる材料 → 仕込みで作る物の、作った物1単位あたりの材料の量（同じ物を作るレシピが2つあれば多いほう） */
const RAW_PER_OUTPUT: Record<string, Record<string, number>> = {};
for (const r of Object.values(PREP_RECIPES)) {
  if (r.soupL || r.outputs.length === 0) continue;
  const main = r.outputs[0]!;
  for (const i of r.inputs) {
    const m = (RAW_PER_OUTPUT[i.itemId] ??= {});
    m[main.itemId] = Math.max(m[main.itemId] ?? 0, i.qty / main.qty);
  }
}

/** 鍋・釜で工程中の、その物の出来上がりの量 */
function inProcess(s: GameState, itemId: string): number {
  let n = 0;
  for (const e of s.equipment) {
    const pr = e.process ? PREP_RECIPES[e.process.recipeId] : undefined;
    if (!pr) continue;
    for (const o of pr.outputs) if (o.itemId === itemId) n += o.qty;
  }
  return n;
}

/**
 * 手元にある分を、その材料の量に直したもの（材料の在庫 ＋ 届く予定 ＋ 仕込んである物・工程中の物を材料の量に直した分）。
 * 例: ゆでたヤサイ 2,000g は もやし 2,000g 分（ヤサイがある間は、もやしを使わない）
 */
export function rawOnHand(s: GameState, itemId: string, depth = 0): number {
  let have = stockOf(s, itemId) + (depth === 0 ? pendingOf(s, itemId) : 0) + (depth > 0 ? inProcess(s, itemId) : 0);
  if (depth >= 2) return have;
  for (const [out, per] of Object.entries(RAW_PER_OUTPUT[itemId] ?? {})) have += rawOnHand(s, out, depth + 1) * per;
  return have;
}

/** 営業の通しの秒 openT までの、来客の多さの割合（0〜1。昼の山・夜の山を入れる） */
export function demandShareDone(s: GameState): number {
  const h = todayHours(s);
  const spans = sessionSpans(h);
  let done = 0;
  let total = 0;
  for (const sp of spans) {
    for (let m = sp.open; m < sp.close; m += 5) {
      const w = hourDemand(m + 2.5);
      total += w;
      // その5分が、今の通しの秒より前か
      const tAt = sp.startT + (m - sp.open) * ((sp.endT - sp.startT) / Math.max(1, sp.close - sp.open));
      if (tAt < s.openT) done += w;
    }
  }
  return total > 0 ? Math.min(1, done / total) : 0;
}

/** その材料の1日の使用量の見込み（最近の営業日の平均と、今日のここまでの速さ） */
export function dailyUseEstimate(s: GameState, itemId: string): number {
  const used: number[] = [];
  for (let i = s.history.length - 1; i >= 0 && used.length < M().recentDays; i--) {
    const r = s.history[i]!;
    if (r.day === s.day || r.served <= 0 || !r.usedItems) continue;
    used.push(r.usedItems[itemId] ?? 0);
  }
  const recent = used.length > 0 ? used.reduce((a, b) => a + b, 0) / used.length : null;
  const share = s.phase === 'open' || s.openT > 0 ? demandShareDone(s) : 0;
  const todayUsed = s.today.usedItems?.[itemId] ?? 0;
  const pace = share >= M().paceFromShare ? todayUsed / share : null;
  if (pace !== null && recent !== null) return pace * M().paceWeight + recent * (1 - M().paceWeight);
  return pace ?? recent ?? 0;
}

/** 閉店までに足りなくなる見込みの量（材料の単位。足りていれば 0） */
export function shortageBeforeClose(s: GameState, itemId: string): number {
  const share = demandShareDone(s);
  if (share >= 1 - M().lastShare) return 0;
  const need = dailyUseEstimate(s, itemId) * (1 - share) * M().expressSafety;
  return Math.max(0, need - rawOnHand(s, itemId));
}

/**
 * 店長の当日便（営業の前の仕込みの時間・営業中に、10秒ごとに確かめる）。
 * 閉店までに足りなくなりそうな材料を当日便（3割高・すぐ届く）で仕入れる。手元に翌日の固定費の2日分を残す
 */
export function managerExpressCheck(s: GameState, dt: number, ctx: SimCtx): void {
  if (s.tutorial || (s.phase !== 'open' && s.phase !== 'prep')) return;
  if (Math.floor(s.t / M().checkEverySec) === Math.floor((s.t - dt) / M().checkEverySec)) return;
  const mgr = managerOnFloor(s);
  if (!mgr) return;
  let budget = managerOrderBudget(s);
  for (const itemId of Object.keys(s.autoOrder)) {
    const def = INGREDIENTS[itemId];
    if (!def || !def.purchasable || def.packQty <= 0 || (s.autoOrder[itemId] ?? 0) <= 0 || !autoOrderEnabled(s, itemId)) continue;
    if (def.unlock && !s.career.unlocked.includes(def.unlock)) continue;
    const short = shortageBeforeClose(s, itemId);
    if (short <= 0) continue;
    let packs = Math.min(M().maxExpressPacks, Math.ceil(short / def.packQty));
    const unit = Math.round(packPriceOf(s, itemId) * 1.3);
    packs = Math.min(packs, Math.floor(budget / Math.max(1, unit)));
    if (packs <= 0) {
      notify(s, ctx, `mgrExpress:${itemId}`, 'warn', `店長: ${def.name}が閉店までに足りなくなりそうですが、資金が少ないため当日便を頼めません`);
      continue;
    }
    // 冷蔵庫に入る数まで減らす
    let r = placeOrder(s, ctx, itemId, packs, true, 'manager');
    while (!r.ok && packs > 1 && r.reason?.includes('冷蔵庫')) {
      packs -= 1;
      r = placeOrder(s, ctx, itemId, packs, true, 'manager');
    }
    if (!r.ok) {
      notify(s, ctx, `mgrExpress:${itemId}`, 'warn', `店長: ${def.name}の当日便を頼めません（${r.reason}）`);
      continue;
    }
    const cost = r.cost ?? 0;
    budget -= cost;
    const x = (s.today.managerExpress ??= { spent: 0, packs: 0, items: {} });
    x.spent += cost;
    x.packs += packs;
    x.items[itemId] = (x.items[itemId] ?? 0) + packs;
    notify(s, ctx, `mgrExpress:${itemId}`, 'info', `店長の${mgr.profile.name}さん: ${def.name}が閉店までに足りなくなりそうなので、当日便で${packs}パック仕入れました（¥${cost.toLocaleString('ja-JP')}）`);
  }
  if (budget > 0) clearNotice(s, 'mgrExpress:budget');
}

/** 店長の予測の短い文（「5月3日（金）: 来客 約75人・約60杯」「5月4日（土）は定休日（発注しない）」） */
export function forecastText(f: ManagerForecast): string {
  if (f.closed) return `${dateLabel(f.day)}は定休日（翌朝便は頼まない）`;
  return `${dateLabel(f.day)}: 来客 約${f.customers}人・約${f.bowls}杯`;
}
