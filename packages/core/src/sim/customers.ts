// 客のAI（設計書 7）。
// 状態: arriving → queue → ticket → waitingSeat → toSeat → seated → eating → leaving → left
// 途中退店（abandoned）、クレーム（complaint）を含む。各遷移の条件はこのファイルに明示する。

import { BALANCE } from '../data/balance';
import { CALL_KEYS, MENU, MENU_IDS } from '../data/menu';
import { LOST_ITEM_KINDS, REVIEW_BAD, REVIEW_GOOD, SURNAMES } from '../data/names';
import { CELL, streetQueueSpot } from '../data/stages';
import { accessPoint, seatPos, stageOf } from '../geometry';
import { findPath } from '../nav';
import type {
  CallLevels,
  Customer,
  CustomerTraits,
  GameState,
  Order,
  Regular,
  SatisfactionParts,
  Seat,
  Vec2,
} from '../types';
import { clamp, clamp01, dist, newId, pick, rand, randNormal, randRange } from '../util';
import type { QualityResult } from './cooking';
import { effectSum, equipmentByRole, isUsable, useEquipment, defOf } from './equipment';
import { stockOf } from './inventory';
import { emit, notify, type SimCtx } from './notices';

// ───────────────────────── 生成 ─────────────────────────

function trait(s: GameState, mean: number, sd: number): number {
  return clamp01(mean + randNormal(s) * sd);
}

export function randomTraits(s: GameState): CustomerTraits {
  return {
    patience: trait(s, 0.55, 0.2),
    priceSensitivity: trait(s, 0.45, 0.2),
    tasteCritic: trait(s, 0.5, 0.2),
    serviceSensitivity: trait(s, 0.4, 0.2),
    eatSpeed: trait(s, 0.6, 0.18),
    orderComplexity: trait(s, 0.45, 0.25),
    cleanlinessDemand: trait(s, 0.45, 0.2),
    reviewPropensity: trait(s, 0.35, 0.2),
    loyaltyPropensity: trait(s, 0.45, 0.2),
    complaintPropensity: trait(s, 0.25, 0.15),
    manners: trait(s, 0.55, 0.25),
    appetite: trait(s, 0.55, 0.22),
  };
}

function levelPick(s: GameState, weights: [number, number][]): number {
  const total = weights.reduce((a, [, w]) => a + w, 0);
  let r = rand(s) * total;
  for (const [v, w] of weights) {
    r -= w;
    if (r <= 0) return v;
  }
  return weights[weights.length - 1]![0];
}

/** コールを決める。注文の複雑さが高い客ほどマシマシを頼む */
export function randomCall(s: GameState, tr: CustomerTraits): CallLevels {
  const cx = tr.orderComplexity;
  const big = tr.appetite;
  return {
    yasai: levelPick(s, [[0, 0.03], [0.5, 0.08], [1, 0.45 - 0.2 * cx], [2, 0.3 + 0.1 * big], [3, 0.08 + 0.25 * cx * big]]),
    ninniku: levelPick(s, [[0, 0.25], [0.5, 0.08], [1, 0.4 - 0.15 * cx], [2, 0.2 + 0.1 * cx], [3, 0.04 + 0.12 * cx]]),
    abura: levelPick(s, [[0, 0.4], [1, 0.35], [2, 0.18 + 0.1 * cx], [3, 0.03 + 0.1 * cx]]),
    karame: levelPick(s, [[0, 0.65], [1, 0.3 + 0.05 * cx], [2, 0.03 + 0.05 * cx]]),
    ichimi: levelPick(s, [[0, 0.5], [1, 0.3], [2, 0.12 + 0.1 * cx], [3, 0.03 + 0.08 * cx]]),
  };
}

/** 注文できるメニューか（解放・一時停止・在庫） */
export function menuAvailable(s: GameState, menuId: string): boolean {
  const m = MENU[menuId];
  if (!m) return false;
  if (m.unlock && !s.career.unlocked.includes(m.unlock)) return false;
  if (s.pausedMenu.includes(menuId)) return false;
  return !soldOut(s, menuId);
}

/** 品切れ判定（券売機の「売切」ランプ）。豚はスライス済み＋煮豚ブロックで判断 */
export function soldOut(s: GameState, menuId: string): boolean {
  const m = MENU[menuId];
  if (!m) return true;
  const butaAvail = stockOf(s, 'buta') + stockOf(s, 'pork_block') * 18;
  if (butaAvail < m.buta) return true;
  if (stockOf(s, 'noodle') + stockOf(s, 'homemade_noodle') < m.noodleG) return true;
  if (m.extras?.egg && stockOf(s, 'egg') < m.extras.egg) return true;
  return false;
}

const MENU_POPULARITY: Record<string, number> = {
  small: 0.34, small_buta: 0.24, small_buta_w: 0.06, large: 0.14, large_buta: 0.12, large_buta_w: 0.04, small_egg: 0.06,
};

/** メニューを選ぶ。第一希望が品切れなら stockout を立てて次点を選ぶ */
export function chooseMenu(s: GameState, c: Customer): { menuId: string | null; stockout: boolean } {
  const ref = BALANCE.customers.referencePrice;
  const weights = MENU_IDS.map((id) => {
    const m = MENU[id]!;
    if (m.unlock && !s.career.unlocked.includes(m.unlock)) return { id, w: 0 };
    let w = MENU_POPULARITY[id] ?? 0.05;
    if (m.size === 'large') w *= 0.4 + 1.4 * c.traits.appetite;
    if (m.buta >= 5) w *= 0.6 + 0.8 * c.traits.appetite;
    const price = s.prices[id] ?? m.defaultPrice;
    w *= Math.pow(ref / price, 1 + 2 * c.traits.priceSensitivity);
    return { id, w };
  }).filter((x) => x.w > 0);
  if (c.regularId) {
    const reg = s.regulars.find((r) => r.id === c.regularId);
    if (reg) {
      const fav = weights.find((x) => x.id === reg.favoriteMenu);
      if (fav) fav.w *= 4;
    }
  }
  const total = weights.reduce((a, b) => a + b.w, 0);
  let r = rand(s) * total;
  let first: string | null = null;
  for (const x of weights) {
    r -= x.w;
    if (r <= 0) {
      first = x.id;
      break;
    }
  }
  first = first ?? weights[0]?.id ?? null;
  if (first && menuAvailable(s, first)) return { menuId: first, stockout: false };
  // 次点: 同じ大きさ → 何でも
  const alt =
    weights.filter((x) => x.id !== first && menuAvailable(s, x.id)).sort((a, b) => b.w - a.w)[0]?.id ?? null;
  return { menuId: alt, stockout: true };
}

function newSat(): SatisfactionParts {
  return { taste: 0.5, speed: 1, service: 0.6, cleanliness: 1, accuracy: 1, stock: 1, value: 0.7, comfort: 0.7 };
}

function spawnPoint(s: GameState): Vec2 {
  const st = stageOf(s);
  const fromRight = rand(s) < 0.6;
  return { x: fromRight ? st.w * CELL + 5 : -2.5, z: -2.6 - rand(s) * 1.2 };
}

export function makeCustomer(s: GameState, regular: Regular | null): Customer {
  const traits = regular ? { ...regular.traits } : randomTraits(s);
  const call = regular && rand(s) < 0.8 ? { ...regular.favoriteCall } : randomCall(s, traits);
  return {
    id: newId(s, 'c'),
    traits,
    regularId: regular?.id ?? null,
    appearance: regular?.appearance ?? Math.floor(rand(s) * 1_000_000),
    state: 'arriving',
    pos: spawnPoint(s),
    path: [],
    stateTime: 0,
    arrivedAt: s.t,
    queueWait: 0,
    seatWait: 0,
    patience: BALANCE.customers.patienceBase * (0.5 + traits.patience) * (regular ? 1.3 : 1),
    seatId: null,
    orderId: null,
    menuId: null,
    call,
    stockout: false,
    eatLeft: 0,
    sat: newSat(),
    say: '',
    sayUntil: 0,
    complaintReason: null,
    slot: 0,
    forLostItem: null,
  };
}

// ───────────────────────── 需要 ─────────────────────────

/** 時間帯による来客の倍率（昼のピーク） */
export function timeCurve(x: number): number {
  return 0.55 + 0.9 * Math.exp(-(((x - 0.42) / 0.24) ** 2));
}

export function averagePrice(s: GameState): number {
  const ids = MENU_IDS.filter((id) => {
    const m = MENU[id]!;
    return !m.unlock || s.career.unlocked.includes(m.unlock);
  });
  if (ids.length === 0) return BALANCE.customers.referencePrice;
  return ids.reduce((a, id) => a + (s.prices[id] ?? MENU[id]!.defaultPrice), 0) / ids.length;
}

/** 1秒あたりの来店期待値（設計書 7.3） */
export function arrivalRate(s: GameState): number {
  const c = BALANCE.customers;
  const repF = Math.pow(Math.max(0.3, s.reputation) / 3, c.reputationExponent);
  const x = s.openT / BALANCE.openDuration;
  const priceF = clamp(Math.pow(c.referencePrice / averagePrice(s), 1.3), 0.35, 1.7);
  const demand = 1 + effectSum(s, 'demand');
  // 常連客は安定した需要を生む
  const regularF = 1 + Math.min(0.6, s.regulars.reduce((a, r) => a + r.loyalty, 0) * 0.03);
  const ticketMachines = equipmentByRole(s, 'ticket');
  const ticketF = ticketMachines.length === 0 ? 0.6 : 1;
  return c.baseRate * repF * timeCurve(x) * priceF * demand * regularF * ticketF;
}

function activeCustomers(s: GameState): number {
  return s.customers.filter((c) => c.state !== 'left' && c.state !== 'abandoned').length;
}

/** 来店処理（ポアソン到着を累積値で近似。乱数は状態に保存されるので決定的） */
export function updateArrivals(s: GameState, dt: number, ctx: SimCtx): void {
  if (s.phase !== 'open') return;
  s.arrivalAcc += arrivalRate(s) * dt;
  while (s.arrivalAcc >= 1) {
    s.arrivalAcc -= 1 + randRange(s, -0.3, 0.3);
    if (activeCustomers(s) >= BALANCE.customers.maxCustomers) {
      s.today.balked += 1;
      continue;
    }
    // 常連の来店
    let regular: Regular | null = null;
    const candidates = s.regulars.filter((r) => !s.regularsVisitedToday.includes(r.id));
    if (candidates.length > 0) {
      const pReg = Math.min(0.55, candidates.reduce((a, r) => a + r.loyalty, 0) * 0.06);
      if (rand(s) < pReg) {
        regular = pick(s, candidates);
        s.regularsVisitedToday.push(regular.id);
      }
    }
    const c = makeCustomer(s, regular);
    // 行列の長さを見て並ぶか決める
    const L = s.queue.length;
    const join = clamp01(1 - L * BALANCE.customers.balkPerQueue * (1.3 - c.traits.patience) + (s.reputation - 3) * 0.08 + (regular ? 0.3 : 0));
    if (rand(s) > join) {
      s.today.balked += 1;
      continue;
    }
    s.customers.push(c);
    s.queue.push(c.id);
    s.today.customers += 1;
    emit(ctx, { type: 'arrive', targetId: c.id });
  }
}

// ───────────────────────── 移動 ─────────────────────────

function walk(c: Customer, dt: number, speed: number): boolean {
  let left = speed * dt;
  while (left > 0 && c.path.length > 0) {
    const tgt = c.path[0]!;
    const d = dist(c.pos, tgt);
    if (d <= left) {
      c.pos = { x: tgt.x, z: tgt.z };
      c.path.shift();
      left -= d;
    } else {
      c.pos = { x: c.pos.x + ((tgt.x - c.pos.x) / d) * left, z: c.pos.z + ((tgt.z - c.pos.z) / d) * left };
      left = 0;
    }
  }
  return c.path.length === 0;
}

/** 店外→入口→店内の目的地 */
function routeInside(s: GameState, from: Vec2, to: Vec2): Vec2[] {
  const st = stageOf(s);
  const doorX = (st.door.x0 + st.door.x1) / 2;
  const pts: Vec2[] = [];
  if (from.z < 0) {
    pts.push({ x: doorX, z: -0.5 }, { x: doorX, z: 0.35 });
  }
  const start = from.z < 0 ? { x: doorX, z: 0.35 } : from;
  const p = findPath(s, start, to, 'customer');
  if (p) pts.push(...p.points);
  else pts.push(to);
  return pts;
}

/** 店内→出口→歩道 */
function routeOutside(s: GameState, from: Vec2): Vec2[] {
  const st = stageOf(s);
  const doorX = (st.door.x0 + st.door.x1) / 2;
  const pts: Vec2[] = [];
  if (from.z >= 0) {
    const p = findPath(s, from, { x: doorX, z: 0.35 }, 'customer');
    if (p) pts.push(...p.points);
    pts.push({ x: doorX, z: -0.5 });
  }
  pts.push({ x: rand(s) < 0.5 ? -3 : st.w * CELL + 6, z: -2.2 - rand(s) });
  return pts;
}

function setTarget(c: Customer, pts: Vec2[]): void {
  c.path = pts;
}

// ───────────────────────── 状態更新 ─────────────────────────

function ticketMachine(s: GameState) {
  const list = equipmentByRole(s, 'ticket');
  return list[0] ?? null;
}

function ticketPoint(s: GameState): Vec2 {
  const tm = ticketMachine(s);
  if (tm) return accessPoint(tm);
  const st = stageOf(s);
  return { x: (st.door.x0 + st.door.x1) / 2 + 0.6, z: 0.8 };
}

function freeSeat(s: GameState): Seat | null {
  for (const seat of s.seats) {
    if (!seat.installed || seat.customerId || seat.bowlId) continue;
    if (seat.index >= stageOf(s).seats.length) continue;
    return seat;
  }
  return null;
}

function cleanlinessScore(s: GameState, seat: Seat | null): number {
  const diningDirt = s.dirt.filter((d) => d.zone === 'dining').reduce((a, d) => a + d.amount, 0);
  const seatDirt = seat ? seat.dirt : 0;
  const trashFull = s.equipment.some((e) => e.placed && defOf(e).role === 'trash' && e.fill >= defOf(e).capacity) ? 0.1 : 0;
  return clamp01(1 - seatDirt * 0.55 - diningDirt * 0.07 - s.kitchenGrime * 0.35 - trashFull);
}

function comfortScore(s: GameState): number {
  const crowd = s.queue.length + s.insideQueue.length;
  const base = 0.62 + effectSum(s, 'comfort');
  return clamp01(base - Math.min(0.15, crowd * 0.01));
}

export function sayFor(c: Customer, s: GameState, text: string, sec = 3): void {
  c.say = text;
  c.sayUntil = s.t + sec;
}

export function updateCustomers(s: GameState, dt: number, ctx: SimCtx): void {
  const speed = BALANCE.customers.walkSpeed;
  const st = stageOf(s);

  // 店外行列の並び位置
  s.queue.forEach((id, i) => {
    const c = s.customers.find((x) => x.id === id);
    if (c && c.state === 'queue' && c.slot !== i) {
      c.slot = i;
      setTarget(c, [streetQueueSpot(i)]);
    }
  });
  // 店内の後ろ待ちの並び位置
  s.insideQueue.forEach((id, i) => {
    const c = s.customers.find((x) => x.id === id);
    if (c && c.state === 'waitingSeat' && c.slot !== i) {
      c.slot = i;
      const spot = st.waitSpots[Math.min(i, st.waitSpots.length - 1)]!;
      setTarget(c, findPath(s, c.pos, spot, 'customer')?.points ?? [spot]);
    }
  });

  let ticketBusy = s.customers.some((c) => c.state === 'ticket');

  for (const c of s.customers) {
    c.stateTime += dt;
    switch (c.state) {
      case 'arriving': {
        const i = s.queue.indexOf(c.id);
        if (c.path.length === 0) {
          c.slot = i;
          setTarget(c, [streetQueueSpot(Math.max(0, i))]);
        }
        if (walk(c, dt, speed * 1.1)) {
          c.state = 'queue';
          c.stateTime = 0;
        }
        break;
      }
      case 'queue': {
        walk(c, dt, speed);
        c.queueWait += dt;
        c.patience -= dt * 0.55;
        const front = s.queue[0] === c.id;
        const roomInside = s.insideQueue.length < st.waitSpots.length;
        if (s.phase === 'closing' && front) {
          // 閉店後は店外の客は帰る（店の評価には影響しない）
          leaveQueue(s, c, ctx, true);
          break;
        }
        if (c.patience <= 0) {
          sayFor(c, s, '…並びすぎ。帰ろう');
          c.sat.speed = 0.1;
          leaveQueue(s, c, ctx, false);
          break;
        }
        if (front && roomInside && !ticketBusy && c.path.length === 0) {
          s.queue.shift();
          c.state = 'ticket';
          c.stateTime = 0;
          ticketBusy = true;
          setTarget(c, routeInside(s, c.pos, ticketPoint(s)));
        }
        break;
      }
      case 'ticket': {
        if (!walk(c, dt, speed)) break;
        const tm = ticketMachine(s);
        const tmSpeed = tm && isUsable(tm) ? defOf(tm).speed : 0.25;
        if (c.stateTime < BALANCE.customers.ticketTime / tmSpeed + 1) break;
        if (c.forLostItem) {
          // 忘れ物を取りに来た人は店内の端で待つ
          c.state = 'waitingSeat';
          c.stateTime = 0;
          sayFor(c, s, 'すみません、昨日忘れ物をしたんですが…', 4);
          s.insideQueue.push(c.id);
          c.slot = -1;
          break;
        }
        const choice = chooseMenu(s, c);
        c.stockout = choice.stockout;
        if (choice.stockout) {
          s.today.stockouts += 1;
          c.sat.stock = 0.4;
        }
        if (!choice.menuId) {
          sayFor(c, s, '全部売り切れ…？');
          c.sat.stock = 0;
          s.today.lost += 1;
          startLeaving(s, c, ctx, 'abandoned');
          break;
        }
        c.menuId = choice.menuId;
        if (tm) useEquipment(s, ctx, tm);
        else if (!tm || !isUsable(tm)) notify(s, ctx, 'ticket:manual', 'warn', '券売機が使えないため手売りで対応しています（時間がかかります）');
        c.state = 'waitingSeat';
        c.stateTime = 0;
        c.slot = -1;
        s.insideQueue.push(c.id);
        emit(ctx, { type: 'ticket', targetId: c.id, text: MENU[c.menuId]?.short ?? '' });
        break;
      }
      case 'waitingSeat': {
        walk(c, dt, speed);
        c.queueWait += dt;
        c.patience -= dt * 0.45;
        if (c.forLostItem) {
          if (c.stateTime > 45) {
            const item = s.lostItems.find((l) => l.id === c.forLostItem);
            if (item && item.state === 'lying') {
              item.state = 'returned';
              const seat = s.seats.find((x) => x.lostItemId === item.id);
              if (seat) seat.lostItemId = null;
              sayFor(c, s, '…自分で見つけました。置きっぱなしだったのか');
              addReview(s, c, 2, ['忘れ物が席に放置されたままだった'], false);
            } else {
              sayFor(c, s, '誰も対応してくれない…');
              addReview(s, c, 1, ['忘れ物の問い合わせに対応してもらえなかった'], false);
            }
            removeFromInsideQueue(s, c.id);
            startLeaving(s, c, ctx, 'left');
          }
          break;
        }
        if (c.patience <= 0) {
          sayFor(c, s, 'もう待てない…');
          c.sat.speed = 0.1;
          s.today.lost += 1;
          removeFromInsideQueue(s, c.id);
          finalizeVisit(s, c, ctx, true);
          startLeaving(s, c, ctx, 'abandoned');
          break;
        }
        const firstDiner = s.insideQueue.find((id) => {
          const x = s.customers.find((y) => y.id === id);
          return x && !x.forLostItem;
        });
        if (firstDiner === c.id) {
          const seat = freeSeat(s);
          if (seat) {
            removeFromInsideQueue(s, c.id);
            seat.customerId = c.id;
            c.seatId = seat.id;
            c.state = 'toSeat';
            c.stateTime = 0;
            setTarget(c, findPath(s, c.pos, seatPos(s, seat), 'customer')?.points ?? [seatPos(s, seat)]);
          }
        }
        break;
      }
      case 'toSeat': {
        if (!walk(c, dt, speed)) break;
        const seat = s.seats.find((x) => x.id === c.seatId);
        if (!seat || !c.menuId) {
          startLeaving(s, c, ctx, 'abandoned');
          break;
        }
        c.state = 'seated';
        c.stateTime = 0;
        c.sat.cleanliness = cleanlinessScore(s, seat);
        c.sat.comfort = comfortScore(s);
        const order: Order = {
          id: newId(s, 'o'),
          customerId: c.id,
          seatId: seat.id,
          menuId: c.menuId,
          call: c.call,
          callRevealed: false,
          callAskedAt: null,
          createdAt: s.t,
          status: 'waiting',
          servedAt: null,
          price: s.prices[c.menuId] ?? MENU[c.menuId]!.defaultPrice,
          quality: null,
          mistakes: [],
          remakes: 0,
          cookId: null,
        };
        s.orders.push(order);
        c.orderId = order.id;
        if (seat.dirt > 0.5) sayFor(c, s, 'カウンターがベタベタだな…');
        emit(ctx, { type: 'seated', targetId: seat.id, text: MENU[c.menuId]?.short ?? '' });
        break;
      }
      case 'seated': {
        c.seatWait += dt;
        c.patience -= dt * (0.6 + 0.4 * (1 - c.traits.patience));
        if (c.patience <= 0) {
          const o = s.orders.find((x) => x.id === c.orderId);
          if (o && o.status === 'waiting') o.status = 'cancelled';
          sayFor(c, s, '遅すぎる！もういい！');
          c.sat.speed = 0;
          s.today.lost += 1;
          finalizeVisit(s, c, ctx, true);
          startLeaving(s, c, ctx, 'abandoned');
          emit(ctx, { type: 'walkout', targetId: c.seatId ?? undefined });
          notify(s, ctx, 'walkout', 'danger', '提供が遅すぎてお客さんが帰ってしまいました');
        }
        break;
      }
      case 'eating': {
        c.eatLeft -= dt;
        if (c.eatLeft <= 0) {
          const seat = s.seats.find((x) => x.id === c.seatId);
          if (seat) finishEating(s, c, seat, ctx);
          finalizeVisit(s, c, ctx, false);
          startLeaving(s, c, ctx, 'left');
        }
        break;
      }
      case 'complaint': {
        c.patience -= dt;
        if (c.stateTime > 30) {
          sayFor(c, s, 'もう二度と来ない！');
          c.sat.service = 0;
          s.today.lost += 1;
          const seat = s.seats.find((x) => x.id === c.seatId);
          if (seat) finishEating(s, c, seat, ctx);
          finalizeVisit(s, c, ctx, true);
          startLeaving(s, c, ctx, 'left');
        }
        break;
      }
      case 'leaving': {
        if (c.path.length === 0) setTarget(c, routeOutside(s, c.pos));
        if (walk(c, dt, speed * 1.1)) {
          c.state = 'left';
          c.stateTime = 0;
        }
        break;
      }
      default:
        break;
    }
  }
  // 退店済みの客を一定時間後に削除
  s.customers = s.customers.filter((c) => !(c.state === 'left' || c.state === 'abandoned') || c.stateTime < 1);
  s.orders = s.orders.filter((o) => o.status === 'waiting' || s.customers.some((c) => c.orderId === o.id));
}

function removeFromInsideQueue(s: GameState, id: string): void {
  s.insideQueue = s.insideQueue.filter((x) => x !== id);
}

function leaveQueue(s: GameState, c: Customer, ctx: SimCtx, closing: boolean): void {
  s.queue = s.queue.filter((x) => x !== c.id);
  if (!closing) {
    s.today.lost += 1;
    finalizeVisit(s, c, ctx, true);
  }
  startLeaving(s, c, ctx, 'abandoned');
}

/**
 * 返金を受けて、食べずに帰る客。提供した丼は手を付けないまま席に残るので、ほかの丼と同じく下げて洗う。
 * 席を空け、来店の評価（口コミ・常連）も通常の退店と同じく行う。
 */
export function leaveWithoutEating(s: GameState, c: Customer, ctx: SimCtx): void {
  const seat = s.seats.find((x) => x.id === c.seatId);
  const b = seat ? s.bowls.find((x) => x.id === seat.bowlId) : undefined;
  if (b) {
    b.state = 'dirty';
    b.contents = null;
  }
  finalizeVisit(s, c, ctx, false);
  startLeaving(s, c, ctx, 'left');
}

/** 店内の待ち列から帰る客（忘れ物を受け取った人など）。待ち列の場所を空ける */
export function leaveFromInsideQueue(s: GameState, c: Customer, ctx: SimCtx): void {
  removeFromInsideQueue(s, c.id);
  startLeaving(s, c, ctx, 'left');
}

function startLeaving(s: GameState, c: Customer, ctx: SimCtx, endState: 'left' | 'abandoned'): void {
  const seat = s.seats.find((x) => x.id === c.seatId);
  if (seat && seat.customerId === c.id) seat.customerId = null;
  c.state = 'leaving';
  c.stateTime = 0;
  c.path = routeOutside(s, c.pos);
  if (endState === 'abandoned') emit(ctx, { type: 'abandon', targetId: c.id });
}

/** 提供されたときの評価（interact の serve から呼ばれる） */
export function onServed(s: GameState, ctx: SimCtx, o: Order, q: QualityResult): void {
  const c = s.customers.find((x) => x.id === o.customerId);
  if (!c) return;
  const m = MENU[o.menuId]!;
  c.sat.taste = clamp01(q.quality * (1.15 - 0.3 * c.traits.tasteCritic));
  c.sat.accuracy = clamp01(1 - q.mistakes.length * 0.35);
  // 待ち時間（着席→提供）。我慢強さで許容時間が変わる
  const tolerable = 45 + 70 * c.traits.patience;
  c.sat.speed = Math.min(c.sat.speed, clamp01(1.2 - c.seatWait / (tolerable * 1.6)));
  const qWait = c.queueWait;
  if (qWait > 120) c.sat.speed = Math.min(c.sat.speed, clamp01(1.3 - qWait / 300));
  // 接客: コールを聞かなかった
  if (!o.callRevealed) c.sat.service = Math.min(c.sat.service, 0.3 + 0.3 * (1 - c.traits.serviceSensitivity));
  // 値段に見合うか
  const price = o.price;
  const valueBase = (q.quality * 1.1 + 0.2) * (BALANCE.customers.referencePrice / price);
  c.sat.value = clamp01(valueBase - 0.3 * c.traits.priceSensitivity * Math.max(0, price / BALANCE.customers.referencePrice - 1));
  s.today.totalSeatWait += c.seatWait;
  s.today.totalQueueWait += c.queueWait;

  const yasaiBonus = 1 + 0.08 * o.call.yasai;
  c.eatLeft = BALANCE.customers.eatTimeBase * m.eatFactor * yasaiBonus * (1.4 - 0.7 * c.traits.eatSpeed) * randRange(s, 0.85, 1.15);
  c.state = 'eating';
  c.stateTime = 0;
  const bad = q.mistakes.length > 0 || q.quality < 0.45;
  if (bad && rand(s) < 0.25 + c.traits.complaintPropensity * (q.mistakes.length > 0 ? 1.4 : 0.8)) {
    c.state = 'complaint';
    c.complaintReason = q.mistakes[0] ?? '味がおかしい';
    sayFor(c, s, `ちょっと！${c.complaintReason}んだけど`, 6);
    s.today.complaints += 1;
    notify(s, ctx, `complaint:${o.seatId}`, 'danger', `${(s.seats.find((x) => x.id === o.seatId)?.index ?? 0) + 1}番席でクレーム: ${c.complaintReason}`);
    emit(ctx, { type: 'complaint', targetId: o.seatId, text: c.complaintReason });
  } else if (q.quality > 0.85 && q.mistakes.length === 0) {
    sayFor(c, s, pick(s, ['うまっ…！', 'これこれ', '最高のワシワシ麺', '乳化スープたまらん']));
  } else {
    sayFor(c, s, pick(s, ['いただきます', 'ズルズル…', 'うん']), 2);
  }
}

function finishEating(s: GameState, c: Customer, seat: Seat, ctx: SimCtx): void {
  const b = s.bowls.find((x) => x.id === seat.bowlId);
  // マナーの良い客は丼を上げてカウンターを拭く
  const tidy = rand(s) < c.traits.manners * BALANCE.cleaning.mannersFactor;
  if (b) {
    b.state = 'dirty';
    if (b.contents) b.contents = null;
  }
  seat.dirt = clamp01(seat.dirt + BALANCE.cleaning.counterDirtPerCustomer * (tidy ? 0.25 : 1));
  if (tidy) emit(ctx, { type: 'tidy', targetId: seat.id });
  // 床の汚れ・こぼし
  const p = seatPos(s, seat);
  if (rand(s) < BALANCE.cleaning.floorDirtChance) addDirt(s, { x: p.x + randRange(s, -0.3, 0.3), z: p.z - randRange(s, 0.2, 0.6) }, 'grime', 'dining');
  if (rand(s) < BALANCE.cleaning.spillChance) {
    addDirt(s, { x: p.x, z: p.z - 0.4 }, 'spill', 'dining');
    notify(s, ctx, 'spill', 'warn', 'お客さんがスープをこぼしました。滑ると危ないので拭いてください');
  }
  // 忘れ物
  const pLost = BALANCE.cleaning.lostItemChance * (1 - effectSum(s, 'lostItemReduction'));
  if (!seat.lostItemId && rand(s) < pLost) {
    const item = {
      id: newId(s, 'L'),
      kind: pick(s, LOST_ITEM_KINDS),
      ownerCustomerId: c.id,
      ownerRegularId: c.regularId,
      seatId: seat.id,
      state: 'lying' as const,
      createdAt: s.t,
      createdDay: s.day,
      neglect: 0,
      returnDay: s.day + 1,
    };
    s.lostItems.push(item);
    seat.lostItemId = item.id;
    emit(ctx, { type: 'lostItem', targetId: seat.id, text: item.kind });
    notify(s, ctx, `lostnew:${item.id}`, 'info', `${seat.index + 1}番席に忘れ物（${item.kind}）。拾って事務机に保管しましょう`);
  }
}

export function addDirt(s: GameState, pos: Vec2, kind: 'grime' | 'spill', zone: 'kitchen' | 'dining'): void {
  const near = s.dirt.find((d) => d.kind === kind && dist(d.pos, pos) < 0.5);
  if (near) {
    near.amount = Math.min(3, near.amount + 0.5);
    return;
  }
  if (s.dirt.length > 40) return;
  s.dirt.push({ id: newId(s, 'd'), pos, amount: 1, kind, zone });
}

const PART_WEIGHTS: Record<keyof SatisfactionParts, number> = {
  taste: 0.3, speed: 0.17, service: 0.1, cleanliness: 0.12, accuracy: 0.12, stock: 0.05, value: 0.09, comfort: 0.05,
};

export function overallSatisfaction(c: Customer): number {
  let v = 0;
  for (const k of Object.keys(PART_WEIGHTS) as (keyof SatisfactionParts)[]) {
    // 個性で重みを変える
    let w = PART_WEIGHTS[k];
    if (k === 'taste') w *= 0.7 + 0.6 * c.traits.tasteCritic;
    if (k === 'service') w *= 0.6 + 0.8 * c.traits.serviceSensitivity;
    if (k === 'cleanliness') w *= 0.6 + 0.8 * c.traits.cleanlinessDemand;
    if (k === 'value') w *= 0.6 + 0.8 * c.traits.priceSensitivity;
    if (k === 'speed') w *= 0.7 + 0.6 * (1 - c.traits.patience);
    v += c.sat[k] * w;
  }
  let wsum = 0;
  for (const k of Object.keys(PART_WEIGHTS) as (keyof SatisfactionParts)[]) {
    let w = PART_WEIGHTS[k];
    if (k === 'taste') w *= 0.7 + 0.6 * c.traits.tasteCritic;
    if (k === 'service') w *= 0.6 + 0.8 * c.traits.serviceSensitivity;
    if (k === 'cleanliness') w *= 0.6 + 0.8 * c.traits.cleanlinessDemand;
    if (k === 'value') w *= 0.6 + 0.8 * c.traits.priceSensitivity;
    if (k === 'speed') w *= 0.7 + 0.6 * (1 - c.traits.patience);
    wsum += w;
  }
  return clamp01(v / wsum);
}

function addReview(s: GameState, c: Customer, stars: number, texts: string[], regular: boolean): void {
  s.todayReviews.push({
    id: newId(s, 'rv'),
    day: s.day,
    stars: clamp(Math.round(stars * 2) / 2, 1, 5),
    text: texts.join('。'),
    parts: { ...c.sat },
    regular,
  });
}

/** 退店時の口コミ・常連化（設計書 7.4, 7.5） */
function finalizeVisit(s: GameState, c: Customer, _ctx: SimCtx, failed: boolean): void {
  const sat = failed ? Math.min(0.25, overallSatisfaction(c)) : overallSatisfaction(c);
  s.today.satisfactionSum += sat;
  s.today.satisfactionCount += 1;
  // 口コミ: 不満が大きいほど書かれやすい
  const pReview = c.traits.reviewPropensity * (sat < 0.4 ? 1.6 : sat > 0.8 ? 1.2 : 0.7);
  if (rand(s) < pReview) {
    const stars = 1 + 4 * sat + randNormal(s) * 0.3;
    const entries = (Object.keys(c.sat) as (keyof SatisfactionParts)[]).sort((a, b) => c.sat[a] - c.sat[b]);
    const texts: string[] = [];
    const worst = entries[0]!;
    const best = entries[entries.length - 1]!;
    if (c.sat[worst] < 0.5 && REVIEW_BAD[worst]) texts.push(pick(s, REVIEW_BAD[worst]!));
    if (c.sat[best] > 0.8 && REVIEW_GOOD[best]) texts.push(pick(s, REVIEW_GOOD[best]!));
    if (texts.length === 0) texts.push(sat > 0.6 ? 'また来たい' : '普通かな');
    addReview(s, c, stars, texts, !!c.regularId);
  }
  // 常連の更新・新規常連化
  if (c.regularId) {
    const r = s.regulars.find((x) => x.id === c.regularId);
    if (r) {
      r.visits += 1;
      r.satisfactionSum += sat;
      r.lastVisitDay = s.day;
      r.loyalty = clamp01(r.loyalty + (sat - 0.6) * 0.5);
      r.rating = r.satisfactionSum / r.visits;
      if (r.loyalty <= 0.05) s.regulars = s.regulars.filter((x) => x.id !== r.id);
    }
  } else if (!failed && c.menuId && sat >= BALANCE.reputation.regularThreshold && rand(s) < c.traits.loyaltyPropensity * 0.6) {
    s.regulars.push({
      id: newId(s, 'r'),
      name: `${pick(s, SURNAMES)}さん`,
      traits: { ...c.traits },
      appearance: c.appearance,
      visits: 1,
      favoriteMenu: c.menuId,
      favoriteCall: { ...c.call },
      satisfactionSum: sat,
      lastVisitDay: s.day,
      loyalty: 0.4 + 0.3 * sat,
      rating: sat,
    });
    if (s.regulars.length > 60) s.regulars.sort((a, b) => b.loyalty - a.loyalty).splice(60);
  }
}

/** 忘れ物の持ち主が翌日以降に来店する */
export function spawnLostItemOwners(s: GameState, ctx: SimCtx): void {
  if (s.phase !== 'open' || s.openT < 20) return;
  for (const item of s.lostItems) {
    if (item.returnDay !== s.day) continue;
    if (item.state === 'returned' || item.state === 'discarded') continue;
    if (s.customers.some((c) => c.forLostItem === item.id)) continue;
    if (rand(s) > 0.004) continue;
    const reg = s.regulars.find((r) => r.id === item.ownerRegularId) ?? null;
    const c = makeCustomer(s, reg);
    c.forLostItem = item.id;
    c.menuId = null;
    s.customers.push(c);
    s.queue.unshift(c.id);
    item.returnDay = -1;
    emit(ctx, { type: 'lostOwner', text: item.kind });
  }
}

/** 閉店時: 放置された忘れ物は処分され評判に響く。保管しなかった物は持ち主の印象が悪い */
export function closeLostItems(s: GameState, ctx: SimCtx): void {
  for (const item of s.lostItems) {
    if (item.state === 'lying' || item.state === 'carried') {
      item.neglect += 1;
      if (item.neglect >= 2) {
        item.state = 'discarded';
        const seat = s.seats.find((x) => x.lostItemId === item.id);
        if (seat) seat.lostItemId = null;
        s.todayReviews.push({
          id: newId(s, 'rv'), day: s.day, stars: 1.5, text: `忘れた${item.kind}が捨てられていた`,
          parts: { taste: 0.5, speed: 0.5, service: 0, cleanliness: 0.5, accuracy: 0.5, stock: 1, value: 0.5, comfort: 0.5 }, regular: false,
        });
        notify(s, ctx, `lost:${item.id}`, 'warn', `放置していた忘れ物（${item.kind}）が処分されてしまいました`);
      }
    }
  }
  s.lostItems = s.lostItems.filter((l) => l.state !== 'returned' && l.state !== 'discarded' || l.createdDay >= s.day);
}

export function callSummary(call: CallLevels): string {
  return CALL_KEYS.map((k) => `${k}:${call[k]}`).join(',');
}
