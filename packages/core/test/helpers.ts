import {
  accessPoint,
  createGame,
  DEFAULT_CALL,
  makeCtx,
  makeEmployee,
  requestRepair,
  step,
  TASK_KINDS,
  type CustomerTraits,
  type Employee,
  type EmployeeRole,
  type GameState,
  type Order,
  type SimCtx,
} from '../src';

export function newGame(seed = 42): { s: GameState; ctx: SimCtx } {
  return { s: createGame({ seed, shopName: 'テスト屋', playerName: 'テスター' }), ctx: makeCtx() };
}

/** プレイヤーを設備の前に移動させる（テスト用） */
export function standAt(s: GameState, actorId: string, equipmentId: string): void {
  const e = s.equipment.find((x) => x.id === equipmentId);
  const a = s.players.find((p) => p.id === actorId) ?? s.employees.find((x) => x.id === actorId);
  if (!e || !a) throw new Error('not found');
  a.pos = accessPoint(e);
}

export function eqByType(s: GameState, type: string) {
  const e = s.equipment.find((x) => x.type === type);
  if (!e) throw new Error(`no ${type}`);
  return e;
}

/** 給与0の従業員（プレイヤーの代わりに自動で動くボット） */
export function addBot(s: GameState, role: EmployeeRole, skill = 0.75, wage = 0): Employee {
  const e = makeEmployee(s, {
    id: 'cand-bot',
    profile: {
      name: `bot-${role}`,
      role,
      skills: { speed: skill, cooking: skill, service: skill, hygiene: skill, movement: skill, reliability: 1 },
      wage,
      hireFee: 0,
      experience: 0,
    },
  });
  e.presentToday = true;
  s.employees.push(e);
  return e;
}

/** 一人で全部やるボット（プレイヤーの代わり）。担当設定で全種類の仕事を任せる */
export function addSoloBot(s: GameState, skill = 0.65): Employee {
  const e = addBot(s, 'cook', skill);
  for (const k of Object.keys(TASK_KINDS)) e.priorities[k] = 1;
  return e;
}

/** 故障したら修理を依頼する（注意深いプレイヤーの代わり） */
export function autoRepair(s: GameState, ctx: SimCtx): void {
  for (const e of s.equipment) if (e.status === 'broken') requestRepair(s, ctx, e);
}

/** 時間を進める */
export function run(s: GameState, ctx: SimCtx, seconds: number, dt = 0.1): void {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) step(s, dt, ctx);
}

/** 営業日を最後まで進める（精算まで） */
export function runDay(s: GameState, ctx: SimCtx, maxSeconds = 2000, repair = true): void {
  let t = 0;
  while (s.phase !== 'closed' && s.phase !== 'bankrupt' && t < maxSeconds) {
    step(s, 0.1, ctx);
    if (repair) autoRepair(s, ctx);
    t += 0.1;
  }
}

export function moneyFromTxns(s: GameState): number {
  return s.transactions.reduce((a, t) => a + t.amount, 0);
}

/** テスト用に客と注文を直接作る（席に座った状態） */
export function seatCustomer(
  s: GameState,
  seatIndex: number,
  menuId = 'small',
  call = { ...DEFAULT_CALL, ninniku: 1, abura: 1 },
  traits: Partial<CustomerTraits> = {},
): Order {
  const seat = s.seats[seatIndex]!;
  const cid = `ctest${seatIndex}`;
  s.customers.push({
    id: cid, traits: { patience: 1, priceSensitivity: 0.3, tasteCritic: 0.5, serviceSensitivity: 0.5, eatSpeed: 0.6, orderComplexity: 0.5, cleanlinessDemand: 0.5, reviewPropensity: 0, loyaltyPropensity: 0, complaintPropensity: 0, manners: 1, appetite: 0.5, ...traits },
    regularId: null, appearance: 1, state: 'seated', pos: { x: 2, z: 1.55 }, path: [], stateTime: 0, arrivedAt: 0, queueWait: 0, seatWait: 0,
    patience: 999, seatId: seat.id, orderId: null, menuId, call, stockout: false, eatLeft: 0,
    sat: { taste: 0.5, speed: 1, service: 0.6, cleanliness: 1, accuracy: 1, stock: 1, value: 0.7, comfort: 0.7 }, say: '', sayUntil: 0, complaintReason: null, slot: 0, forLostItem: null,
  });
  seat.customerId = cid;
  const o: Order = { id: `otest${seatIndex}`, customerId: cid, seatId: seat.id, menuId, call, callRevealed: false, callAskedAt: null, createdAt: s.t, status: 'waiting', servedAt: null, price: s.prices[menuId]!, quality: null, mistakes: [], remakes: 0, cookId: null };
  s.orders.push(o);
  s.customers[s.customers.length - 1]!.orderId = o.id;
  return o;
}
