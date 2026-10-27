// 操作要求（アクション）。クライアントは状態を直接書き換えず、必ずここを通して要求する。
// シングルプレイではブラウザ内で、共同経営ではサーバー（Durable Object）で検証・適用する（設計書 17.4）。

import { BALANCE } from '../data/balance';
import { BOWL_PACK, EQUIPMENT, SEAT_PRICE } from '../data/equipment';
import { INGREDIENTS } from '../data/ingredients';
import { MENU } from '../data/menu';
import { moveWithCollision, stageOf } from '../geometry';
import type { EmployeeRole, GameState, Id, Rot, Vec2 } from '../types';
import { dist, newId } from '../util';
import { cash, recordPL } from './economy';
import { buyEquipment, isUnlocked, requestRepair, sellEquipment } from './equipment';
import { fire, hire, setPriority, setRole } from './employees';
import { nextDay, openShop, payArrears, takeLoan, declareBankruptcy, updateFinanceWarnings } from './day';
import { cancelWork, dropHand, getActor, interact, type Args } from './interact';
import { placeOrder } from './inventory';
import { autoPlace, expand, placeEquipment, storeEquipment } from './layout';
import { emit, type SimCtx } from './notices';
import { currentTutorialStep, inBasicsTutorial, tutorialAction, type TutorialOp } from './tutorial';

export type Action =
  | { type: 'move'; x: number; z: number; yaw: number }
  | { type: 'interact'; targetId: Id; verb: string; args?: Args }
  | { type: 'cancelWork' }
  | { type: 'openShop' }
  | { type: 'nextDay' }
  | { type: 'orderStock'; itemId: string; packs: number; express: boolean }
  | { type: 'setAutoOrder'; itemId: string; qty: number }
  | { type: 'buyEquipment'; equipType: string; autoPlace?: boolean }
  | { type: 'sellEquipment'; equipmentId: Id }
  | { type: 'repair'; equipmentId: Id }
  | { type: 'maintenance'; equipmentId: Id; on: boolean }
  | { type: 'place'; equipmentId: Id; gx: number; gz: number; rot: Rot; offset?: Vec2 }
  | { type: 'store'; equipmentId: Id }
  | { type: 'buySeat'; seatIndex: number }
  | { type: 'seatOffset'; seatIndex: number; x: number; z: number }
  | { type: 'buyBowls' }
  | { type: 'hire'; candidateId: Id }
  | { type: 'fire'; employeeId: Id }
  | { type: 'setRole'; employeeId: Id; role: EmployeeRole }
  | { type: 'setPriority'; employeeId: Id; kind: string; value: number }
  | { type: 'expand' }
  | { type: 'setPrice'; menuId: string; price: number }
  | { type: 'pauseMenu'; menuId: string; paused: boolean }
  | { type: 'takeLoan' }
  | { type: 'payArrears' }
  | { type: 'rename'; name: string }
  | { type: 'giveUp' }
  | { type: 'tutorial'; op: TutorialOp; stepId?: string };

export type ActionType = Action['type'];

/** 共同経営でホストだけが実行できる操作（店の存続に関わる操作） */
export const HOST_ONLY: ReadonlySet<ActionType> = new Set<ActionType>([
  'nextDay', 'sellEquipment', 'fire', 'expand', 'takeLoan', 'rename', 'giveUp',
]);

export interface ActionResult {
  ok: boolean;
  reason?: string;
  /** 位置を補正した場合の確定位置 */
  corrected?: Vec2;
  data?: unknown;
}

const fail = (reason: string): ActionResult => ({ ok: false, reason });

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 操作要求を検証して適用する。
 * @param now 位置検証に使う実時間（秒）。サーバーは受信時刻、ローカルは performance.now()/1000
 */
export function applyAction(s: GameState, actorId: Id, a: Action, ctx: SimCtx, now = 0): ActionResult {
  const player = s.players.find((p) => p.id === actorId);
  if (!player) return fail('プレイヤーが見つかりません');
  if (s.phase === 'bankrupt' && a.type !== 'move') return fail('破産しています');
  if (s.paused && a.type !== 'move') return fail('一時停止中です');
  switch (a.type) {
    case 'move': {
      if (!isNum(a.x) || !isNum(a.z) || !isNum(a.yaw)) return fail('不正な位置');
      const elapsed = player.lastMoveAt > 0 ? Math.max(0, now - player.lastMoveAt) : 0.25;
      const maxD = BALANCE.player.walkSpeed * BALANCE.player.speedTolerance * Math.min(1, Math.max(0.05, elapsed)) + 0.15;
      const want = { x: a.x, z: a.z };
      const d = dist(player.pos, want);
      let target = want;
      if (d > maxD) {
        const k = maxD / d;
        target = { x: player.pos.x + (want.x - player.pos.x) * k, z: player.pos.z + (want.z - player.pos.z) * k };
      }
      // 壁や設備を通り抜けていないかを衝突判定で確認
      const next = moveWithCollision(s, player.pos, target.x - player.pos.x, target.z - player.pos.z, BALANCE.player.radius);
      player.pos = next;
      player.yaw = a.yaw;
      player.lastMoveAt = now;
      const corrected = Math.abs(next.x - a.x) > 0.05 || Math.abs(next.z - a.z) > 0.05;
      return corrected ? { ok: true, corrected: next } : { ok: true };
    }
    case 'interact': {
      if (typeof a.targetId !== 'string' || typeof a.verb !== 'string') return fail('不正な操作');
      const args = sanitizeArgs(a.args);
      const r = interact(s, actorId, a.targetId, a.verb, args, ctx);
      return r.ok ? { ok: true, data: { started: !!r.started } } : fail(r.reason ?? '操作できません');
    }
    case 'cancelWork': {
      const actor = getActor(s, actorId);
      if (actor?.work) cancelWork(s, actor, ctx, '作業をやめた');
      return { ok: true };
    }
    case 'openShop':
      // チュートリアル中は「開店」の手順になるまで開店しない（値段の変更などが営業中はできなくなるため）
      if (s.tutorial && !s.tutorial.finished && currentTutorialStep(s)?.id !== 'open') return fail('チュートリアルの案内に沿って進めてください（開店はあとで案内します）');
      return openShop(s, ctx);
    case 'nextDay':
      // 練習の日の結果は本番に残さない（1日目は画面側で新しく始める）
      if (inBasicsTutorial(s)) return fail('チュートリアル中は次の日へ進めません');
      return nextDay(s, ctx);
    case 'orderStock': {
      if (typeof a.itemId !== 'string' || !isNum(a.packs)) return fail('不正な発注');
      const r = placeOrder(s, ctx, a.itemId, Math.floor(a.packs), !!a.express);
      updateFinanceWarnings(s, ctx);
      return r.ok ? { ok: true, data: r.cost } : fail(r.reason ?? '発注できません');
    }
    case 'setAutoOrder': {
      if (typeof a.itemId !== 'string' || !isNum(a.qty) || a.qty < 0 || a.qty > 1_000_000) return fail('不正な値');
      // 仕入れできる食材だけ（任意のキーで状態が膨らむのを防ぐ）
      if (!Object.hasOwn(INGREDIENTS, a.itemId) || !INGREDIENTS[a.itemId]!.purchasable) return fail('仕入れできない食材です');
      s.autoOrder[a.itemId] = Math.round(a.qty);
      return { ok: true };
    }
    case 'buyEquipment': {
      const r = buyEquipment(s, ctx, a.equipType);
      if (!r.ok || !r.id) return fail(r.reason ?? '購入できません');
      if (a.autoPlace && (s.phase === 'closed' || s.phase === 'prep')) autoPlace(s, ctx, r.id);
      updateFinanceWarnings(s, ctx);
      return { ok: true, data: r.id };
    }
    case 'sellEquipment': {
      const e = s.equipment.find((x) => x.id === a.equipmentId);
      if (!e) return fail('設備が見つかりません');
      const r = sellEquipment(s, ctx, e);
      updateFinanceWarnings(s, ctx);
      return r.ok ? { ok: true } : fail(r.reason ?? '売却できません');
    }
    case 'repair': {
      const e = s.equipment.find((x) => x.id === a.equipmentId);
      if (!e) return fail('設備が見つかりません');
      const r = requestRepair(s, ctx, e);
      return r.ok ? { ok: true } : fail(r.reason ?? '修理できません');
    }
    case 'maintenance': {
      const e = s.equipment.find((x) => x.id === a.equipmentId);
      if (!e) return fail('設備が見つかりません');
      e.maintenanceBooked = !!a.on;
      return { ok: true };
    }
    case 'place': {
      if (![a.gx, a.gz].every(isNum)) return fail('不正な配置');
      const off = a.offset && isNum(a.offset.x) && isNum(a.offset.z) ? a.offset : undefined;
      const r = placeEquipment(s, ctx, { equipmentId: a.equipmentId, gx: a.gx, gz: a.gz, rot: a.rot, offset: off });
      return r.ok ? { ok: true, data: r } : { ok: false, reason: r.errors[0] ?? '配置できません', data: r };
    }
    case 'store': {
      const r = storeEquipment(s, ctx, a.equipmentId);
      return r.errors.length === 0 || r.ok ? { ok: true, data: r } : { ok: false, reason: r.errors[0], data: r };
    }
    case 'buySeat': {
      const st = stageOf(s);
      const seat = s.seats.find((x) => x.index === a.seatIndex);
      if (!seat || a.seatIndex >= st.seats.length) return fail('その席はありません');
      if (seat.installed) return fail('すでに設置済みです');
      if (!cash(s, 'equipment', -SEAT_PRICE, `${seat.index + 1}番席の椅子を設置`)) return fail('資金が足りません');
      recordPL(s, 'capex', SEAT_PRICE);
      seat.installed = true;
      emit(ctx, { type: 'buy', text: `${seat.index + 1}番席` });
      return { ok: true };
    }
    case 'seatOffset': {
      // 椅子は微調整できる（±0.12m）
      if (s.phase !== 'closed' && s.phase !== 'prep') return fail('配置変更は閉店後か準備時間にだけできます');
      const seat = s.seats.find((x) => x.index === a.seatIndex);
      if (!seat || !isNum(a.x) || !isNum(a.z)) return fail('不正な指定');
      seat.offset = { x: Math.max(-0.12, Math.min(0.12, a.x)), z: Math.max(-0.12, Math.min(0.12, a.z)) };
      s.layoutVersion += 1;
      return { ok: true };
    }
    case 'buyBowls': {
      const owned = s.bowls.filter((b) => b.state !== 'broken').length;
      const cap = s.equipment.filter((e) => e.placed && EQUIPMENT[e.type]?.role === 'rack').reduce((x, e) => x + (EQUIPMENT[e.type]?.capacity ?? 0), 0);
      if (owned + BOWL_PACK.qty > Math.max(cap, 12)) return fail('丼棚に入りきりません（丼棚を増やしてください）');
      if (!cash(s, 'equipment', -BOWL_PACK.price, `丼を${BOWL_PACK.qty}個購入`)) return fail('資金が足りません');
      recordPL(s, 'capex', BOWL_PACK.price);
      for (let i = 0; i < BOWL_PACK.qty; i++) s.bowls.push({ id: newId(s, 'b'), state: 'clean', loc: { at: 'rack' }, contents: null, orderId: null });
      return { ok: true };
    }
    case 'hire':
      return hire(s, ctx, a.candidateId);
    case 'fire': {
      const r = fire(s, ctx, a.employeeId);
      updateFinanceWarnings(s, ctx);
      return r;
    }
    case 'setRole':
      return setRole(s, a.employeeId, a.role) ? { ok: true } : fail('変更できません');
    case 'setPriority':
      return setPriority(s, a.employeeId, a.kind, a.value) ? { ok: true } : fail('変更できません');
    case 'expand':
      return expand(s, ctx);
    case 'setPrice': {
      const m = Object.hasOwn(MENU, a.menuId) ? MENU[a.menuId] : undefined;
      if (!m || !isNum(a.price)) return fail('不正な価格');
      if (!isUnlocked(s, m.unlock)) return fail('まだ解放されていません');
      const price = Math.round(a.price / 10) * 10;
      if (price < 500 || price > 3000) return fail('価格は¥500〜¥3,000の範囲で設定してください');
      if (s.phase === 'open' || s.phase === 'closing') return fail('営業中は価格を変えられません');
      s.prices[a.menuId] = price;
      return { ok: true };
    }
    case 'pauseMenu': {
      if (!Object.hasOwn(MENU, a.menuId)) return fail('不明なメニュー');
      s.pausedMenu = s.pausedMenu.filter((x) => x !== a.menuId);
      if (a.paused) s.pausedMenu.push(a.menuId);
      return { ok: true };
    }
    case 'takeLoan':
      return takeLoan(s, ctx);
    case 'payArrears': {
      const paid = payArrears(s, ctx);
      updateFinanceWarnings(s, ctx);
      return paid > 0 ? { ok: true, data: paid } : fail('支払える資金がありません');
    }
    case 'rename': {
      const name = String(a.name ?? '').trim().slice(0, 20);
      if (!name) return fail('店名を入力してください');
      s.shopName = name;
      return { ok: true };
    }
    case 'giveUp': {
      if (s.phase !== 'closed') return fail('閉店後にだけ選べます');
      declareBankruptcy(s, ctx, '経営を断念した');
      return { ok: true };
    }
    case 'tutorial': {
      const ops: readonly string[] = ['next', 'alt', 'close', 'quit', 'staffStart', 'staffDecline'];
      if (!ops.includes(a.op)) return fail('不明な操作です');
      if (a.stepId !== undefined && typeof a.stepId !== 'string') return fail('不正な操作');
      const r = tutorialAction(s, ctx, a.op, a.stepId);
      return r.ok ? { ok: true } : fail(r.reason ?? '操作できません');
    }
    default:
      return fail('不明な操作です');
  }
}

function sanitizeArgs(args: Args | undefined): Args {
  if (!args || typeof args !== 'object') return null;
  const out: Record<string, string | number | boolean> = {};
  let n = 0;
  for (const [k, v] of Object.entries(args)) {
    if (n++ > 8) break;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string' && v.length <= 64) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/**
 * 共同経営から抜けたプレイヤーを状態から取り除く（持っていた物は安全な場所へ戻す）。
 * ホストは取り除けない。
 */
export function removePlayer(s: GameState, playerId: Id, ctx: SimCtx): boolean {
  const p = s.players.find((x) => x.id === playerId);
  if (!p || p.isHost) return false;
  dropHand(s, p, ctx);
  s.players = s.players.filter((x) => x.id !== playerId);
  return true;
}
