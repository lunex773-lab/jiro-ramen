// 共通市場: 端末から届いた1日の営業データを、サーバーが確かめる（MARKET_RANKING_PLAN.md 4 章。オーナーの判断 1a・1b）。
// prev = サーバーにある前日の確定した状態（その日の仕込みの前）、next = 端末が送ってきた次の状態、ticket = その日の条件。
//
// reject（受け取らない・前日に戻す）: 前日の状態から説明できない変化。
//   日付・企業と店舗の id・過去の日報の書き換え、取引の記録と合わないお金、記録のない資産（従業員・設備・店舗・融資・在庫）、
//   1日で動ける幅を超える能力・評判。
// flags（受け取るが順位から外す）: 同じ経済の式で出せる上限を超える値、日報とお金の記録の食い違い。
// 上限の幅は、ボットで多くの日を回した実際の値に余裕を持たせて決めている（test/verify.test.ts で「ふつうの営業では引っかからない」ことを確かめる）。

import { DEFAULT_HOURS, openMinutesOf, storeHours as storeHoursOf, todayHours } from './sim/hours';
import { BALANCE } from './data/balance';
import { EQUIPMENT } from './data/equipment';
import { STAGES } from './data/stages';
import { validateState } from './save';
import { storeReport } from './sim/company';
import { adFactor } from './sim/ads';
import { expectedDailyArrivals, priceDemandFactor } from './sim/customers';
import { fameDemandFactor } from './sim/fame';
import { finalProfit, netSales, operatingProfit } from './sim/economy';
import { repaymentCapacity } from './sim/day';
import type { DayReport, Employee, GameState, StoreEntry, Txn } from './types';

const V = () => BALANCE.market.verify;

/** 日の条件のうち、確かめるのに使うもの */
export interface VerifyTicket {
  gameDate: number;
  /** 店の id → 客の取り合いの倍率 */
  demand: Record<string, number>;
}

export interface VerifyResult {
  /** 受け取らない理由（1つでもあれば前日に戻す） */
  reject: string[];
  /** 受け取るが順位から外す理由 */
  flags: string[];
  /** 破産で終わった日 */
  bankrupt: boolean;
}

/** 会社の日報がある最後の日（なければ s.day − 1） */
export function lastCompanyDay(s: GameState): number {
  let d = -1;
  for (const r of s.company?.history ?? []) if (r.day > d) d = r.day;
  return d >= 0 ? d : s.day - 1;
}

interface StoreView {
  id: string;
  entry: StoreEntry;
  employees: Employee[];
  equipment: GameState['equipment'];
  inventory: GameState['inventory'];
  deliveries: GameState['deliveries'];
  reputation: number;
  stage: number;
  seatsInstalled: number;
}

function storesOf(s: GameState): StoreView[] {
  return s.company.stores.map((entry) => {
    const active = entry.id === s.company.activeStoreId;
    const src = active ? s : entry.snapshot!;
    const stage = active ? s.career.stage : entry.snapshot!.stage;
    return {
      id: entry.id,
      entry,
      employees: src.employees,
      equipment: src.equipment,
      inventory: src.inventory,
      deliveries: src.deliveries,
      reputation: src.reputation,
      stage,
      seatsInstalled: src.seats.filter((x) => x.installed && x.index < (STAGES[stage]?.seats.length ?? 0)).length,
    };
  });
}

const stockValue = (st: StoreView) => st.inventory.reduce((a, l) => a + l.qty * l.unitCost, 0) + st.deliveries.reduce((a, d) => a + d.qty * d.unitCost, 0);

/** 1杯の最高の値段（設定できる上限） */
const MAX_PRICE = BALANCE.priceMax;

/**
 * 端末から届いた次の状態を確かめる。prev は書き換えない（読むだけ）
 */
export function verifyCommit(prev: GameState, next: GameState, ticket: VerifyTicket): VerifyResult {
  const reject: string[] = [];
  const flags: string[] = [];
  const res = (bankrupt = false): VerifyResult => ({ reject, flags, bankrupt });
  const shape = validateState(next);
  if (shape.length > 0) {
    reject.push(`状態の形が不正: ${shape.slice(0, 3).join(', ')}`);
    return res();
  }
  const d = ticket.gameDate;
  if (next.seed !== prev.seed) reject.push('企業の種が違う');
  if (next.nextId < prev.nextId) reject.push('id の番号が戻っている');
  // 店舗: なくならない。増えたら出店の取引がある
  const prevStores = new Set(prev.company.stores.map((x) => x.id));
  const nextStores = new Set(next.company.stores.map((x) => x.id));
  for (const id of prevStores) if (!nextStores.has(id)) reject.push(`店舗 ${id} がなくなっている`);
  // 取引とお金
  const prevTx = new Set(prev.transactions.map((t) => t.id));
  const txIds = new Set<string>();
  const newTx: Txn[] = [];
  for (const t of next.transactions) {
    if (txIds.has(t.id)) {
      reject.push('取引の id が重複している');
      break;
    }
    txIds.add(t.id);
    if (!prevTx.has(t.id)) newTx.push(t);
  }
  for (const t of newTx) {
    if (!Number.isInteger(t.amount) || !Number.isFinite(t.amount)) reject.push('取引の金額が整数でない');
    if (t.day < prev.day || t.day > next.day) reject.push(`取引の日付が範囲外（${t.day}日）`);
    if (t.amount > 0 && !['sale', 'loan', 'equipmentSale'].includes(t.type)) reject.push(`入金にならない取引の種類（${t.type}）`);
  }
  const sum = newTx.reduce((a, t) => a + t.amount, 0);
  if (next.money !== prev.money + sum) reject.push(`お金が取引の記録と合わない（${prev.money} + ${sum} ≠ ${next.money}）`);
  const byType = (type: Txn['type']) => newTx.filter((t) => t.type === type);
  const newStores = [...nextStores].filter((id) => !prevStores.has(id)).length;
  if (newStores > byType('store').length) reject.push('出店の取引がない店舗がある');
  // 融資: 新しい融資は、融資の入金と同じ額
  const prevLoans = new Set(prev.loans.map((l) => l.id));
  const loanIn = byType('loan').reduce((a, t) => a + t.amount, 0);
  const newLoans = next.loans.filter((l) => !prevLoans.has(l.id));
  if (newLoans.reduce((a, l) => a + l.principal, 0) !== loanIn) reject.push('融資の記録と入金が合わない');
  for (const l of next.loans) {
    const p = prev.loans.find((x) => x.id === l.id);
    if (p && l.remaining > p.remaining) reject.push('融資の残りが増えている');
  }
  // 新しい融資は銀行の決まりのとおり（5万円刻み・同じ利率と日数・借入の残りの合計は上限まで。債務不履行の会社は借りられない）
  if (newLoans.length > 0) {
    const L = BALANCE.loan;
    if (prev.creditBlocked) reject.push('債務不履行の会社が融資を受けている');
    for (const l of newLoans) {
      if (!Number.isInteger(l.principal) || l.principal < L.step || l.principal % L.step !== 0) reject.push('融資の額が刻みに合わない');
      if (l.dailyRate !== L.dailyRate || l.dailyPayment !== Math.ceil(l.principal / L.days)) reject.push('融資の条件が銀行の決まりと違う');
    }
    const total = next.loans.reduce((a, l) => a + l.remaining, 0);
    // 返済能力はその日の日報で変わるので、前と後の大きいほうまで許す
    const cap = Math.min(L.maxTotal, Math.max(repaymentCapacity(prev), repaymentCapacity(next)));
    if (total > cap) reject.push(`融資の残りの合計が上限（¥${cap}）を超えている`);
  }
  // 未払金は増えてよい（払えなかった分）が、消えるなら支払いの取引がある
  const prevAr = prev.arrears.reduce((a, x) => a + x.amount, 0);
  const nextAr = next.arrears.reduce((a, x) => a + x.amount, 0);
  const arPaid = -byType('arrearsPay').reduce((a, t) => a + t.amount, 0);
  if (nextAr < prevAr - arPaid - V().moneyEps) reject.push('未払金が支払いなしに減っている');

  const ps = storesOf(prev);
  const ns = storesOf(next);
  // 従業員: 増えたら採用の取引がある。能力は1日に伸びる幅まで
  const prevEmp = new Map<string, Employee>();
  for (const st of ps) for (const e of st.employees) prevEmp.set(e.id, e);
  let newEmp = 0;
  const cap = BALANCE.staff.growth.dailyCap * V().skillDays + 1e-9;
  for (const st of ns) {
    for (const e of st.employees) {
      const p = prevEmp.get(e.id);
      if (!p) {
        newEmp += 1;
        continue;
      }
      for (const k of ['speed', 'cooking', 'service', 'hygiene', 'movement'] as const) {
        if (e.profile.skills[k] - p.profile.skills[k] > cap) reject.push(`${e.profile.name}の能力（${k}）が1日で伸びる幅を超えている`);
      }
      if (e.profile.wage < p.profile.wage && e.profile.employment === p.profile.employment) reject.push('従業員の日給が下がっている');
    }
  }
  if (newEmp > byType('hire').length) reject.push('採用の取引がない従業員がいる');
  // 設備: 前からある店で増えたら、買った取引がある（新しい店の最初の設備は出店の初期費用に入っている）
  const prevEq = new Set<string>();
  for (const st of ps) for (const e of st.equipment) prevEq.add(e.id);
  let newEqPrice = 0;
  for (const st of ns) {
    if (!prevStores.has(st.id)) continue;
    for (const e of st.equipment) if (!prevEq.has(e.id)) newEqPrice += EQUIPMENT[e.type]?.price ?? 0;
  }
  const capex = -[...byType('equipment'), ...byType('expansion'), ...byType('store'), ...byType('relocation')].reduce((a, t) => a + t.amount, 0);
  if (newEqPrice > capex * V().equipmentSlack + V().moneyEps) reject.push('買った記録のない設備がある');
  // 拡張の段階は1日に1つまで、工事の取引がある
  for (const st of ns) {
    const p = ps.find((x) => x.id === st.id);
    if (!p) continue;
    if (st.stage > p.stage && (st.stage - p.stage > 1 || byType('expansion').length === 0)) reject.push('工事の記録のない拡張');
    if (Math.abs(st.reputation - p.reputation) > V().reputationPerDay) reject.push(`評判が1日で動ける幅を超えている（${p.reputation.toFixed(2)} → ${st.reputation.toFixed(2)}）`);
  }
  // 在庫: 前日の在庫と届く予定の荷物の価値＋仕入れの支払いを超えない
  const purchased = -byType('purchase').reduce((a, t) => a + t.amount, 0);
  const prevStock = ps.reduce((a, st) => a + stockValue(st), 0);
  const nextStock = ns.reduce((a, st) => a + stockValue(st), 0);
  if (nextStock > prevStock + purchased + V().stockEps) reject.push(`仕入れの記録より在庫が多い（¥${Math.round(nextStock - prevStock - purchased)}）`);

  // 破産で終わった日
  if (next.phase === 'bankrupt') {
    if (next.day !== prev.day && next.day !== d && next.day !== d + 1) reject.push('破産の日付が不正');
    return res(true);
  }
  // 日付と日報。営業の終わりで送った日（閉店後・その日の結果を確定した状態。じろ7 5）と、
  // 「翌日の仕込みへ」のあとに送った日（次の日の仕込みの状態。前の版の端末）のどちらも受け取る
  const closedForm = next.phase === 'closed' && next.day === d && next.finalizedDay === d;
  if (!closedForm) {
    if (next.day !== d + 1) reject.push(`日付が合わない（${d}日目の次は${d + 1}日目。届いたのは${next.day}日目）`);
    if (next.phase !== 'prep' && next.phase !== 'closed') reject.push(`営業日の途中の状態（${next.phase}）`);
  }
  const days = next.company.history.map((r) => r.day);
  if (!days.includes(d)) reject.push(`${d}日目の会社の日報がない`);
  if (days.some((x) => x > d)) reject.push(`${d}日目より先の会社の日報がある`);
  for (const r of prev.company.history) {
    const n = next.company.history.find((x) => x.day === r.day);
    if (n && (n.netSales !== r.netSales || n.operatingProfit !== r.operatingProfit || n.finalProfit !== r.finalProfit)) {
      reject.push(`${r.day}日目の会社の日報が書き換えられている`);
      break;
    }
  }
  if (reject.length > 0) return res();

  // ここから先は上限と食い違い（受け取るが順位から外す）
  const cr = next.company.history.find((x) => x.day === d)!;
  const reports: { entry: StoreEntry; r: DayReport }[] = [];
  for (const entry of next.company.stores) {
    const r = storeReport(next, entry, d);
    if (r) reports.push({ entry, r });
  }
  // 日報の中の計算
  for (const { entry, r } of reports) {
    if (r.operatingProfit !== operatingProfit(r) || (r.netSales ?? netSales(r)) !== netSales(r) || (r.finalProfit ?? finalProfit(r)) !== finalProfit(r)) flags.push(`${entry.name}の日報の計算が合わない`);
    for (const k of ['sales', 'refunds', 'cogs', 'waste', 'wages', 'rent', 'upkeep', 'utilities', 'repairs', 'hiring', 'interest', 'served', 'customers', 'balked', 'lost'] as const) {
      const v = r[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        flags.push(`${entry.name}の日報の値（${k}）が不正`);
        break;
      }
    }
  }
  const sumLines = cr.stores.reduce((a, x) => a + x.netSales, 0);
  const sumReports = reports.reduce((a, x) => a + (x.r.netSales ?? netSales(x.r)), 0);
  if (cr.netSales !== sumLines || cr.netSales !== sumReports) flags.push('会社の日報と店の日報の売上が合わない');
  if (cr.operatingProfit !== reports.reduce((a, x) => a + x.r.operatingProfit, 0)) flags.push('会社の日報と店の日報の営業利益が合わない');
  // 売上は売上の取引と同じ（日報の売上を水増しできない）
  const saleTx = newTx.filter((t) => t.type === 'sale' && t.day === d).reduce((a, t) => a + t.amount, 0);
  const salesInReports = reports.reduce((a, x) => a + x.r.sales, 0);
  if (Math.abs(saleTx - salesInReports) > V().moneyEps) flags.push(`日報の売上（¥${salesInReports}）が売上の取引（¥${saleTx}）と合わない`);
  // 上限: 席・客の見込み・値段
  for (const { entry, r } of reports) {
    const st = ns.find((x) => x.id === entry.id)!;
    // 1席の上限は11〜15時（4時間）の値。営業時間が長い店は時間に比例させる（じろ1 5.1）
    const hf = Math.max(1, openMinutesOf(entry.hours ?? DEFAULT_HOURS) / openMinutesOf(DEFAULT_HOURS));
    const seatsMax = Math.max(st.seatsInstalled, STAGES[st.stage]?.seats.length ?? 0) * V().servedPerSeat * hf + V().servedSlack;
    if (r.served > seatsMax) flags.push(`${entry.name}: 提供（${r.served}杯）が席数の上限（${Math.round(seatsMax)}杯）を超える`);
    if (r.sales > r.served * MAX_PRICE + V().moneyEps) flags.push(`${entry.name}: 売上が提供×最高の値段を超える`);
  }
  // 知名度が1日で上がりすぎている（大バズ・神話級の伝説が重なっても届かない幅）
  const awUp = (next.fame?.awareness ?? 0) - (prev.fame?.awareness ?? 0);
  if (next.company.activeStoreId === prev.company.activeStoreId && awUp > V().awarenessPerDay) flags.push(`知名度が1日で上がりすぎている（+${awUp.toFixed(1)}）`);
  const active = reports.find((x) => x.entry.id === next.company.activeStoreId && x.r.managed === undefined);
  if (active) {
    const bound = arrivalBound(morningOf(prev, d), next, ticket.demand[active.entry.id] ?? 1, active.r.ads ?? 0, d);
    const came = active.r.customers + active.r.balked;
    if (came > bound) flags.push(`来客（${came}人）が見込みの上限（${Math.round(bound)}人）を超える`);
  }
  return res();
}

/**
 * プレイヤーがいる店の、その日の来客（入った客＋帰った客）の上限。
 * 同じ式（arrivalRate を営業時間で積分。イベントの効果を入れる）で、値段を下げた分・評判が上がった分の余裕を足す
 */
export function arrivalBound(prev: GameState, next: GameState, demand: number, ads = 0, day = prev.day): number {
  // その日に払った広告費の分も入れる（開店の前の状態では、まだ払っていない）
  const base = expectedDailyArrivals(prev, { events: true }) * adFactor(ads);
  const priceUp = Math.max(1, priceDemandFactor(next) / Math.max(0.05, priceDemandFactor(prev)));
  // 知名度・話題性（じろ7 Phase 7）: 翌朝の動画の公開・営業中の伝説で上がった分を許す。営業中は上がるだけ（薄れるのは朝だけ）なので、
  // その日の終わりの値がその日のいちばん高い値になる
  const fameUp = Math.max(1, fameDemandFactor(next) / Math.max(0.05, fameDemandFactor(prev)));
  return base * priceUp * fameUp * buzzAllowance(next, day) * Math.max(0, demand) * V().arrivalMult + V().arrivalSlack;
}

/**
 * 営業日 day の朝として見た前日の状態。サーバーにある前日の状態が閉店後（営業の終わりで送った日。じろ7 5）なら、
 * 日付と今日の営業時間だけを次の日の朝に合わせた浅い複製（客の見込みの曜日・営業時間を合わせる。元の状態は変えない）
 */
function morningOf(prev: GameState, day: number): GameState {
  if (prev.phase !== 'closed' || prev.day === day) return prev;
  return { ...prev, day, openT: 0, todayHours: JSON.parse(JSON.stringify(storeHoursOf(prev))) as GameState['todayHours'] };
}

/**
 * その日に SNS のバズが起きていたら、バズの分の来客の余裕（朝の状態の見込みには入らない）。
 * バズは1〜3時間（じろ1 5.9）なので、いちばん長いときの倍率まで許す: 1 + (倍率 − 1) × 最長の時間 ÷ 営業時間
 */
function buzzAllowance(next: GameState, day: number): number {
  const B = BALANCE.events.buzz;
  if (next.events?.stats.sns_buzz?.lastDay !== day) return 1;
  const dayMin = openMinutesOf(todayHours(next));
  return 1 + (B.arrivalMult - 1) * Math.min(1, B.durationMinTo / dayMin);
}
