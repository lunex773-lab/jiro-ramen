import {
  accessPoint,
  createGame,
  makeCtx,
  makeEmployee,
  step,
  type Employee,
  type EmployeeRole,
  type GameState,
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

/** 時間を進める */
export function run(s: GameState, ctx: SimCtx, seconds: number, dt = 0.1): void {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) step(s, dt, ctx);
}

/** 営業日を最後まで進める（精算まで） */
export function runDay(s: GameState, ctx: SimCtx, maxSeconds = 2000): void {
  let t = 0;
  while (s.phase !== 'closed' && s.phase !== 'bankrupt' && t < maxSeconds) {
    step(s, 0.1, ctx);
    t += 0.1;
  }
}

export function moneyFromTxns(s: GameState): number {
  return s.transactions.reduce((a, t) => a + t.amount, 0);
}
