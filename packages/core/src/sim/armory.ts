// 隠し扉と武器庫（じろ1 5.12。オーナーの判断: 本物の武器・血の表現あり・罰は軽い。2026-11-11）
//   ・店の外の右の横の壁に、壁と同じ見た目の隠し扉。近づいて調べると「押す」が出て、奥が武器庫（ホストだけ。チュートリアル中は開かない）
//   ・武器を持つと、客に「斬る・刺す・殴る・撃つ・投げる」が出る。襲われた客は血を流して逃げ、見ていた客もみんな逃げる
//   ・通報で警察が来て、武器を取り上げ、その日の営業は終わる（精算へ）。評判はその日の最初の事件で 0.4 下がる
//   ・じろ2（改修設計書05。オーナーの判断「案の2倍の値段」）: 武器は武器庫で買う。一度買った武器は武器庫に残る（警察は手から取り上げるだけで、
//     武器庫の武器はなくならない）。銃は弾を1発ずつ買い、撃つと1発減る。爆弾は1個ずつ買い、投げるとなくなる
import { BALANCE } from '../data/balance';
import { WEAPONS, type WeaponDef } from '../data/weapons';
import type { ArmoryState, Customer, GameState, IncidentState, Player, Employee, Vec2 } from '../types';
import { dist, newId } from '../util';
import { addDirt, startLeaving } from './customers';
import { spend } from './economy';
import { emit, notify, type SimCtx } from './notices';
import { finishEvent, recordEvent } from './events';

export const ARMORY_DOOR_ID = 'armory_door';
export const ARMORY_RACK_ID = 'armory_rack';

const A = () => BALANCE.armory;
const GONE: Customer['state'][] = ['leaving', 'left', 'abandoned'];

export function armoryOf(s: GameState): ArmoryState {
  return (s.armory ??= { doorOpen: false, bombs: [] });
}

/** 扉を開け閉めできるか（できなければ理由） */
export function armoryDoorProblem(s: GameState, a: Player | Employee): string | null {
  if (s.tutorial) return 'びくともしない';
  if (a.kind !== 'player') return 'できません';
  if (!a.isHost) return 'ホストだけが開けられます';
  return null;
}

export function toggleArmoryDoor(s: GameState, ctx: SimCtx): void {
  const ar = armoryOf(s);
  ar.doorOpen = !ar.doorOpen;
  emit(ctx, { type: ar.doorOpen ? 'armoryOpen' : 'armoryClose' });
}

/** 武器庫にある（買った）武器か。爆弾は1個以上あるとき */
export function weaponOwned(s: GameState, id: string): boolean {
  const ar = armoryOf(s);
  return id === 'bomb' ? (ar.bombStock ?? 0) > 0 : (ar.owned ?? []).includes(id);
}

/** 銃の弾の数 */
export function ammoOf(s: GameState, id: string): number {
  return armoryOf(s).ammo?.[id] ?? 0;
}

const yen = (n: number) => `¥${n.toLocaleString('ja-JP')}`;

/** 武器を買う（爆弾は1個）。買えなければ理由 */
export function buyWeapon(s: GameState, ctx: SimCtx, id: string): string | null {
  const w = WEAPONS[id];
  if (!w) return '武器がありません';
  const ar = armoryOf(s);
  if (!w.consumable && (ar.owned ?? []).includes(id)) return 'もう持っています';
  if (s.money < w.price) return `お金が足りません（${yen(w.price)}）`;
  if (!spend(s, 'weapon', 'capex', w.price, `${w.name}${w.consumable ? '（1個）' : ''}`)) return 'お金が足りません';
  if (w.consumable) ar.bombStock = (ar.bombStock ?? 0) + 1;
  else ar.owned = [...(ar.owned ?? []), id];
  emit(ctx, { type: 'weaponBuy', text: id });
  return null;
}

/** 銃の弾を1発買う */
export function buyAmmo(s: GameState, ctx: SimCtx, id: string): string | null {
  const w = WEAPONS[id];
  if (!w || w.kind !== 'gun' || !w.ammoPrice) return '弾のある武器ではありません';
  if (!(armoryOf(s).owned ?? []).includes(id)) return `${w.name}を持っていません`;
  if (s.money < w.ammoPrice) return `お金が足りません（${yen(w.ammoPrice)}）`;
  if (!spend(s, 'weapon', 'capex', w.ammoPrice, `${w.name}の弾（1発）`)) return 'お金が足りません';
  const ar = armoryOf(s);
  ar.ammo = { ...(ar.ammo ?? {}), [id]: (ar.ammo?.[id] ?? 0) + 1 };
  emit(ctx, { type: 'weaponBuy', text: `${id}:ammo` });
  return null;
}

/** 武器を手に持つ（爆弾は武器庫から1個減る） */
export function takeWeapon(s: GameState, a: Player | Employee, id: string): void {
  const ar = armoryOf(s);
  if (id === 'bomb') ar.bombStock = Math.max(0, (ar.bombStock ?? 0) - 1);
  a.hand = { kind: 'weapon', weaponId: id };
}

/** 武器を武器庫に戻す（爆弾は武器庫に1個戻る） */
export function returnWeapon(s: GameState, a: Player | Employee): void {
  if (a.hand.kind === 'weapon' && a.hand.weaponId === 'bomb') armoryOf(s).bombStock = (armoryOf(s).bombStock ?? 0) + 1;
  a.hand = { kind: 'none' };
}

/** 持っている武器 */
export function weaponOf(a: Player | Employee): WeaponDef | null {
  return a.hand.kind === 'weapon' ? (WEAPONS[a.hand.weaponId] ?? null) : null;
}

/** 襲える客（逃げている客・テレビのスタッフは除く） */
export function attackable(c: Customer): boolean {
  return !GONE.includes(c.state) && c.state !== 'crew' && !c.hurt;
}

/** 今日の事件（客を襲った日） */
export function incidentToday(s: GameState): IncidentState | null {
  return s.incident && s.incident.day === s.day ? s.incident : null;
}

/** 客を襲う。爆弾は投げて、少しあとに爆発する */
export function attack(s: GameState, ctx: SimCtx, a: Player | Employee, target: Customer, w: WeaponDef): void {
  if (w.kind === 'bomb') {
    armoryOf(s).bombs.push({ id: newId(s, 'bomb'), pos: { x: target.pos.x, z: target.pos.z }, at: s.t + (w.fuse ?? 2) });
    a.hand = { kind: 'none' };
    emit(ctx, { type: 'bombThrow', actorId: a.id, targetId: target.id, pos: { ...target.pos } });
    startIncident(s, ctx, 0);
    return;
  }
  if (w.kind === 'gun') {
    // 撃つと弾が1発減る（弾がなければ撃てない。interact の plan でも確かめる）
    const ar = armoryOf(s);
    const left = ar.ammo?.[w.id] ?? 0;
    if (left <= 0) return;
    ar.ammo = { ...(ar.ammo ?? {}), [w.id]: left - 1 };
  }
  const hits = [target];
  if (w.spread) for (const c of s.customers) if (c !== target && attackable(c) && dist(c.pos, target.pos) <= w.spread) hits.push(c);
  emit(ctx, { type: w.kind === 'gun' ? 'gunshot' : 'weaponHit', actorId: a.id, targetId: target.id, text: w.id });
  for (const c of hits) hurt(s, ctx, c);
  startIncident(s, ctx, hits.length);
}

const SCREAMS = ['ぎゃあっ！', '痛いっ！', '助けて！', 'うわあっ！'];

/** 襲われた客: 血を流して逃げる */
function hurt(s: GameState, ctx: SimCtx, c: Customer): void {
  c.hurt = true;
  c.say = SCREAMS[(s.nextId + c.appearance) % SCREAMS.length]!;
  c.sayUntil = s.t + 4;
  addDirt(s, { x: c.pos.x, z: c.pos.z }, 'blood', 'dining');
  emit(ctx, { type: 'hurt', targetId: c.id, pos: { ...c.pos } });
  flee(s, ctx, c);
}

/** 逃げる（注文は取り消し。食券は提供のときに払うので返金はない） */
function flee(s: GameState, ctx: SimCtx, c: Customer): void {
  if (GONE.includes(c.state)) return;
  const o = c.orderId ? s.orders.find((x) => x.id === c.orderId) : undefined;
  if (o && o.status === 'waiting') o.status = 'cancelled';
  s.queue = s.queue.filter((id) => id !== c.id);
  s.insideQueue = s.insideQueue.filter((id) => id !== c.id);
  if (!c.hurt && c.sayUntil < s.t) {
    c.say = 'きゃあっ！逃げろ！';
    c.sayUntil = s.t + 3;
  }
  startLeaving(s, c, ctx, 'abandoned');
}

/** 事件: 見ていた客はみんな逃げ、通報される（その日の最初の事件で評判が下がる） */
function startIncident(s: GameState, ctx: SimCtx, victims: number): void {
  let inc = incidentToday(s);
  if (!inc) {
    inc = { day: s.day, startT: s.t, policeAt: s.t + A().policeDelay, police: false, victims: 0 };
    inc.eventId = recordEvent(s, 'incident', { state: 'happening' }).id;
    s.incident = inc;
    s.reputation = Math.max(1, s.reputation - A().reputationPenalty);
    notify(s, ctx, 'incident', 'danger', '客が襲われ、店の中は大騒ぎです。通報され、まもなく警察が来ます（評判が下がりました）');
    emit(ctx, { type: 'incident' });
  }
  inc.victims += victims;
  for (const c of s.customers) if (c.state !== 'crew') flee(s, ctx, c);
}

/** 投げた爆弾の爆発と、警察の到着（step から毎回呼ぶ） */
export function updateArmory(s: GameState, ctx: SimCtx, endDay: () => void): void {
  const ar = s.armory;
  if (ar && ar.bombs.length > 0) {
    const due = ar.bombs.filter((b) => s.t >= b.at);
    if (due.length > 0) {
      ar.bombs = ar.bombs.filter((b) => s.t < b.at);
      for (const b of due) explode(s, ctx, b.pos);
    }
  }
  const inc = incidentToday(s);
  if (inc && !inc.police && s.t >= inc.policeAt) {
    inc.police = true;
    // 警察: 手の武器を取り上げ（買った武器は武器庫に残る。持っていた爆弾も武器庫へ）、扉を閉め、その日の営業は終わる
    for (const p of s.players) if (p.hand.kind === 'weapon') returnWeapon(s, p);
    if (inc.eventId) finishEvent(s, inc.eventId, `けが人 ${inc.victims}人・警察が来てその日の営業は終わり`);
    if (ar) {
      ar.doorOpen = false;
      ar.bombs = [];
    }
    notify(s, ctx, 'incident', 'danger', `警察が来ました。武器は取り上げられ、今日の営業は終わりです（けが人 ${inc.victims}人）`);
    emit(ctx, { type: 'police' });
    endDay();
  }
}

function explode(s: GameState, ctx: SimCtx, pos: Vec2): void {
  const r = WEAPONS.bomb?.radius ?? 2.5;
  emit(ctx, { type: 'bombBlast', pos: { ...pos } });
  let n = 0;
  for (const c of s.customers) {
    // 逃げている途中の客も巻き込む（店を出た客・テレビのスタッフは除く）
    if (c.hurt || c.state === 'crew' || c.state === 'left' || dist(c.pos, pos) > r) continue;
    hurt(s, ctx, c);
    n += 1;
  }
  addDirt(s, { x: pos.x, z: pos.z }, 'blood', 'dining');
  startIncident(s, ctx, n);
}

/** 新しい客が来ないか（事件の日は来ない） */
export function incidentStopsArrivals(s: GameState): boolean {
  return incidentToday(s) !== null;
}
