// 隠し扉と武器庫（じろ1 5.12。オーナーの判断: 本物の武器・血の表現あり・罰は軽い。2026-11-11）
//   ・店の外の右の横の壁に、壁と同じ見た目の隠し扉。近づいて調べると「押す」が出て、奥が武器庫（ホストだけ。チュートリアル中は開かない）
//   ・武器を持つと、客に「斬る・刺す・殴る・撃つ・投げる」が出る。襲われた客は血を流して逃げ、見ていた客もみんな逃げる
//   ・通報で警察が来て、武器を取り上げ、その日の営業は終わる（精算へ）。評判はその日の最初の事件で 0.4 下がる
//   ・じろ2（改修設計書05。オーナーの判断「案の2倍の値段」）: 武器は武器庫で買う。一度買った武器は武器庫に残る（警察は手から取り上げるだけで、
//     武器庫の武器はなくならない）。銃は弾を1発ずつ買い、撃つと1発減る。爆弾は1個ずつ買い、投げるとなくなる
//   ・オーナーの指示（2026-11-11）: 店員も襲える。けがをした店員は店を出て1週間療養する（出勤しない）。
//     襲った瞬間に倍速は等速に戻る（画面）。通報の20秒後に警察が来て、襲った人に手錠をかけ、パトカーまで連れて行って乗せる。
//     画面が暗くなって、その日の営業は終わる（精算へ）
import { BALANCE } from '../data/balance';
import { WEAPONS, type WeaponDef } from '../data/weapons';
import { alleyRect, policeCarDoor, policeCarPos, policeCarSeat, policeDoorFront, policeSpawn, stageOf, zoneAt } from '../geometry';
import type { ArmoryState, ArrestState, Customer, GameState, IncidentState, Officer, Player, Employee, Vec2 } from '../types';
import { dist, newId } from '../util';
import { addDirt, startLeaving } from './customers';
import { spend } from './economy';
import { emit, notify, type SimCtx } from './notices';
import { finishEvent, recordEvent } from './events';
import { cancelWork, dropHand } from './interact';
import { startLeave } from './commute';
import { ensureAttendance, logStaff } from './staff';
import { staffRoute } from './walk';

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

/** 襲える店員（店にいる人。けがをして逃げている人は除く） */
export function staffAttackable(e: Employee): boolean {
  return e.presentToday && e.commute?.kind !== 'injured';
}

type Victim = Customer | Employee;
const isStaff = (v: Victim): v is Employee => (v as Employee).kind === 'employee';

/** 今日の事件（客を襲った日） */
export function incidentToday(s: GameState): IncidentState | null {
  return s.incident && s.incident.day === s.day ? s.incident : null;
}

/** 客・店員を襲う。爆弾は投げて、少しあとに爆発する */
export function attack(s: GameState, ctx: SimCtx, a: Player | Employee, target: Victim, w: WeaponDef): void {
  if (w.kind === 'bomb') {
    armoryOf(s).bombs.push({ id: newId(s, 'bomb'), pos: { x: target.pos.x, z: target.pos.z }, at: s.t + (w.fuse ?? 2) });
    a.hand = { kind: 'none' };
    emit(ctx, { type: 'bombThrow', actorId: a.id, targetId: target.id, pos: { ...target.pos } });
    startIncident(s, ctx, 0, a.id);
    return;
  }
  if (w.kind === 'gun') {
    // 撃つと弾が1発減る（弾がなければ撃てない。interact の plan でも確かめる）
    const ar = armoryOf(s);
    const left = ar.ammo?.[w.id] ?? 0;
    if (left <= 0) return;
    ar.ammo = { ...(ar.ammo ?? {}), [w.id]: left - 1 };
  }
  const hits: Victim[] = [target];
  if (w.spread) {
    for (const c of s.customers) if (c !== target && attackable(c) && dist(c.pos, target.pos) <= w.spread) hits.push(c);
    for (const e of s.employees) if (e !== target && e !== a && staffAttackable(e) && dist(e.pos, target.pos) <= w.spread) hits.push(e);
  }
  emit(ctx, { type: w.kind === 'gun' ? 'gunshot' : 'weaponHit', actorId: a.id, targetId: target.id, text: w.id });
  // 先に事件にする（客が逃げ出す）。けがをした店員の数はそのあと数える
  startIncident(s, ctx, 0, a.id);
  for (const v of hits) hurtVictim(s, ctx, v);
}

function hurtVictim(s: GameState, ctx: SimCtx, v: Victim): void {
  const inc = incidentToday(s);
  if (inc) inc.victims += 1;
  if (isStaff(v)) {
    if (inc) inc.staffVictims = (inc.staffVictims ?? 0) + 1;
    hurtStaff(s, ctx, v);
  } else hurt(s, ctx, v);
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

/**
 * 襲われた店員: 血を流して、持っている物を置いて店の外へ逃げる。その日はもう戻らず、翌日から1週間療養する
 * （シフトがあっても出勤しない。staff.ts の shiftFor）
 */
function hurtStaff(s: GameState, ctx: SimCtx, e: Employee): void {
  const until = s.day + BALANCE.armory.injuryDays;
  e.injury = { day: s.day, until };
  e.say = { text: SCREAMS[(s.nextId + e.profile.name.length) % SCREAMS.length]!, until: s.t + 4, kind: 'event' };
  addDirt(s, { x: e.pos.x, z: e.pos.z }, 'blood', zoneAt(s, e.pos) === 'kitchen' ? 'kitchen' : 'dining');
  emit(ctx, { type: 'hurt', targetId: e.id, pos: { ...e.pos } });
  if (e.work) cancelWork(s, e, ctx, 'けがをした');
  if (e.hand.kind !== 'none') dropHand(s, e, ctx);
  e.hand = { kind: 'none' };
  if (e.conduct?.kind) e.conduct.kind = null;
  // その日の出勤はここまで（働いた時間はここで止まる。戻ってこない）
  const att = ensureAttendance(s, e);
  if (att.status !== 'closed') att.status = 'left';
  startLeave(s, e, 'injured');
  logStaff(s, e, 'injured', `武器で襲われてけがをした（${until}日目まで療養）`);
  notify(s, ctx, `injured:${e.id}`, 'danger', `${e.profile.name}さんがけがをしました。${until}日目まで（1週間）療養して休みます`);
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
function startIncident(s: GameState, ctx: SimCtx, victims: number, attackerId: string | null): void {
  let inc = incidentToday(s);
  if (!inc) {
    inc = { day: s.day, startT: s.t, policeAt: s.t + A().policeDelay, police: false, victims: 0, staffVictims: 0 };
    if (attackerId) inc.attackerId = attackerId;
    inc.eventId = recordEvent(s, 'incident', { state: 'happening' }).id;
    s.incident = inc;
    s.reputation = Math.max(1, s.reputation - A().reputationPenalty);
    notify(s, ctx, 'incident', 'danger', '人が襲われ、店の中は大騒ぎです。通報され、まもなく警察が来ます（評判が下がりました）');
    emit(ctx, { type: 'incident' });
  }
  inc.victims += victims;
  for (const c of s.customers) if (c.state !== 'crew') flee(s, ctx, c);
}

/** 投げた爆弾の爆発と、警察の到着・逮捕（step から毎回呼ぶ） */
export function updateArmory(s: GameState, dt: number, ctx: SimCtx, endDay: () => void): void {
  const ar = s.armory;
  if (ar && ar.bombs.length > 0) {
    const due = ar.bombs.filter((b) => s.t >= b.at);
    if (due.length > 0) {
      ar.bombs = ar.bombs.filter((b) => s.t < b.at);
      for (const b of due) explode(s, ctx, b.pos);
    }
  }
  const inc = incidentToday(s);
  if (!inc) return;
  // パトカーがサイレンを鳴らして走って来る（警察官はパトカーに乗って来る。オーナーの指示 2026-11-11）
  if (!inc.siren && s.t >= inc.policeAt - BALANCE.armory.carArriveSec) {
    inc.siren = true;
    emit(ctx, { type: 'policeSiren' });
  }
  if (!inc.police && s.t >= inc.policeAt) policeArrive(s, ctx, inc);
  if (inc.arrest) updateArrest(s, dt, ctx, inc, inc.arrest, endDay);
}

const AR = () => BALANCE.armory.arrest;

/** 逮捕の途中か（警察が来てから、その日の営業が終わるまで） */
export function arrestOf(s: GameState): ArrestState | null {
  const inc = incidentToday(s);
  return inc?.arrest && !inc.arrest.done && s.phase !== 'closed' ? inc.arrest : null;
}

/** 事件のあと、逮捕が終わるまでその日を終えない（閉店の時刻を過ぎても精算・中休みに進まない） */
export function incidentHoldsDay(s: GameState): boolean {
  const inc = incidentToday(s);
  return !!inc && !inc.arrest?.done && s.phase !== 'closed';
}

/** 警察に取り押さえられている人か（動けない・何もできない） */
export function isArrested(s: GameState, id: string): boolean {
  return arrestOf(s)?.attackerId === id;
}

/** 倍速にできないか（事故の間・人を襲った日の事件の間は等速。オーナーの指示 2026-11-11） */
export function speedLocked(s: GameState): boolean {
  return !!s.events?.accident || (incidentToday(s) !== null && s.phase !== 'closed');
}

function officerSay(s: GameState, o: Officer | undefined, text: string, sec = 3): void {
  if (o) o.say = { text, until: s.t + sec };
}

function setPhase(s: GameState, a: ArrestState, phase: ArrestState['phase']): void {
  a.phase = phase;
  a.since = s.t;
}

/** 店の中・横の路地・外のどこにいるか（警察官の道の分け方） */
function areaOf(s: GameState, p: Vec2): 'inside' | 'alley' | 'outside' {
  const st = stageOf(s);
  if (p.z >= 0 && p.x >= 0 && p.x <= st.w * 0.5) return 'inside';
  const al = alleyRect(st);
  if (p.x >= al.x0 - 0.05 && p.x <= al.x1 + 0.05 && p.z >= al.z0 - 0.05 && p.z <= al.z1 + 0.05) return 'alley';
  return 'outside';
}

/** 警察官の道（パトカーと店の中・横の路地のあいだ。店の中は入口を通る） */
export function policeRoute(s: GameState, from: Vec2, to: Vec2): Vec2[] {
  const al = alleyRect(stageOf(s));
  const mouth = { x: (al.x0 + al.x1) / 2, z: al.z0 - 0.4 };
  const fa = areaOf(s, from);
  const ta = areaOf(s, to);
  const out: Vec2[] = [];
  let cur = from;
  if (fa === 'alley' && ta !== 'alley') {
    out.push(mouth);
    cur = mouth;
  }
  const leg = (a: Vec2, b: Vec2) => staffRoute(s, a, b)?.points ?? [b];
  if (ta === 'alley' && fa !== 'alley') {
    out.push(...leg(cur, mouth), to);
    return out;
  }
  out.push(...leg(cur, to));
  return out;
}

/** 道に沿って歩く（着いたら true） */
function walk(o: { pos: Vec2; yaw: number; path: Vec2[] }, dt: number, speed: number): boolean {
  let left = speed * dt;
  while (left > 0 && o.path.length > 0) {
    const tgt = o.path[0]!;
    const d = dist(o.pos, tgt);
    if (d > 1e-6) o.yaw = Math.atan2(tgt.x - o.pos.x, tgt.z - o.pos.z);
    if (d <= left) {
      o.pos = { x: tgt.x, z: tgt.z };
      o.path.shift();
      left -= d;
    } else {
      o.pos = { x: o.pos.x + ((tgt.x - o.pos.x) / d) * left, z: o.pos.z + ((tgt.z - o.pos.z) / d) * left };
      left = 0;
    }
  }
  return o.path.length === 0;
}

const face = (from: Vec2, to: Vec2) => Math.atan2(to.x - from.x, to.z - from.z);

/** 警察官が立つ場所（襲った人の前の左右） */
function standPoints(target: Vec2, from: Vec2): Vec2[] {
  const d = dist(from, target) || 1;
  const fx = (target.x - from.x) / d;
  const fz = (target.z - from.z) / d;
  return [
    { x: target.x - fx * 0.7 + fz * 0.35, z: target.z - fz * 0.7 - fx * 0.35 },
    { x: target.x - fx * 0.55 - fz * 0.45, z: target.z - fz * 0.55 + fx * 0.45 },
  ];
}

/** パトカーが止まった: 襲った人は動けなくなり、警察官が扉を開けて降りて、歩いて来る */
function policeArrive(s: GameState, ctx: SimCtx, inc: IncidentState): void {
  inc.police = true;
  const st = stageOf(s);
  const attacker = s.players.find((p) => p.id === inc.attackerId) ?? null;
  const goal = attacker ? attacker.pos : { x: (st.door.x0 + st.door.x1) / 2, z: -0.6 };
  const officers: Officer[] = [];
  for (let i = 0; i < AR().officers; i++) {
    const pos = policeSpawn(st, i % 2);
    const out = policeDoorFront(st, i % 2);
    const route = [out, ...policeRoute(s, out, goal)];
    const last = route[route.length - 2] ?? pos;
    const stand = attacker ? standPoints(goal, last)[i] ?? goal : { x: goal.x + i * 0.6, z: goal.z };
    route[route.length - 1] = stand;
    officers.push({ id: `officer${i + 1}`, pos, yaw: face(pos, stand), path: route });
  }
  inc.arrest = { phase: 'approach', since: s.t, attackerId: attacker?.id ?? null, officers };
  if (attacker) {
    if (attacker.work) cancelWork(s, attacker, ctx, '警察が来た');
    officerSay(s, officers[0], '警察だ！動くな！', 4);
    officerSay(s, officers[1], '武器を捨てなさい！', 4);
  } else officerSay(s, officers[0], '通報のあった店はここか', 4);
  notify(s, ctx, 'incident', 'danger', `警察が来ました（けが人 ${inc.victims}人${inc.staffVictims ? `・うち店員 ${inc.staffVictims}人` : ''}）`);
  emit(ctx, { type: 'police' });
}

function updateArrest(s: GameState, dt: number, ctx: SimCtx, inc: IncidentState, a: ArrestState, endDay: () => void): void {
  const R = AR();
  const st = stageOf(s);
  const el = s.t - a.since;
  const attacker = a.attackerId ? (s.players.find((p) => p.id === a.attackerId) ?? null) : null;
  for (const o of a.officers) if (o.say && o.say.until <= s.t) o.say = null;
  switch (a.phase) {
    case 'approach': {
      let done = true;
      for (const o of a.officers) if (!walk(o, dt, R.walkSpeed)) done = false;
      if (attacker && a.officers[0]) attacker.yaw = face(attacker.pos, a.officers[0].pos);
      if (!done && el < R.approachMax) return;
      for (const o of a.officers) {
        if (o.path.length > 0) o.pos = { ...o.path[o.path.length - 1]! };
        o.path = [];
      }
      if (!attacker) {
        setPhase(s, a, 'fade');
        return;
      }
      // 手錠をかける。手の武器は取り上げる（買った武器は武器庫に残る。持っていた爆弾も武器庫へ）
      for (const p of s.players) if (p.hand.kind === 'weapon') returnWeapon(s, p);
      if (attacker.hand.kind !== 'none') dropHand(s, attacker, ctx);
      attacker.hand = { kind: 'none' };
      for (const o of a.officers) o.yaw = face(o.pos, attacker.pos);
      officerSay(s, a.officers[0], '確保！傷害の現行犯で逮捕する！', R.cuffSec + 0.5);
      setPhase(s, a, 'cuff');
      emit(ctx, { type: 'arrest', actorId: attacker.id });
      return;
    }
    case 'cuff': {
      if (!attacker) return setPhase(s, a, 'fade');
      for (const o of a.officers) o.yaw = face(o.pos, attacker.pos);
      if (el < R.cuffSec) return;
      a.path = policeRoute(s, attacker.pos, policeCarDoor(st));
      // 後ろの警察官は、襲った人の今の場所から同じ道をあとからついて行く
      const back = a.officers[1];
      if (back) back.path = [{ ...attacker.pos }, ...a.path.map((p) => ({ ...p }))];
      officerSay(s, a.officers[1], '歩きなさい', 2.5);
      setPhase(s, a, 'escort');
      return;
    }
    case 'escort': {
      if (!attacker) return setPhase(s, a, 'fade');
      const me = { pos: attacker.pos, yaw: attacker.yaw, path: a.path ?? [] };
      const arrived = walk(me, dt, R.escortSpeed);
      attacker.pos = me.pos;
      attacker.yaw = me.yaw;
      a.path = me.path;
      // 前の警察官は腕をつかんで横を歩く。後ろの警察官は少し遅れてついて来る
      const front = a.officers[0];
      if (front) {
        front.yaw = attacker.yaw;
        front.pos = { x: attacker.pos.x + Math.cos(attacker.yaw) * 0.38, z: attacker.pos.z - Math.sin(attacker.yaw) * 0.38 };
      }
      const back = a.officers[1];
      if (back && el > 0.8) walk(back, dt, R.escortSpeed);
      if (!arrived && el < R.escortMax) return;
      attacker.pos = { ...policeCarDoor(st) };
      attacker.yaw = face(attacker.pos, policeCarSeat(st));
      a.path = [];
      officerSay(s, a.officers[0], '乗りなさい', 2);
      setPhase(s, a, 'board');
      return;
    }
    case 'board': {
      if (!attacker) return setPhase(s, a, 'fade');
      // 後ろの席に乗せる（扉の前から席へ）。警察官も乗り込む: 前の人は前の扉から、後ろの人は犯人のあとから後ろの扉から
      const k = Math.min(1, Math.max(0, (el - R.boardSec * 0.35) / (R.boardSec * 0.5)));
      const door = policeCarDoor(st);
      const seat = policeCarSeat(st);
      attacker.pos = { x: door.x + (seat.x - door.x) * k, z: door.z + (seat.z - door.z) * k };
      a.officers.forEach((o, i) => {
        if (o.inCar) return;
        const back = i % 2 === 1;
        // 後ろの人は、犯人が乗るまで扉の横で待つ
        if (back && k < 1 && o.path.length === 0) {
          const c = policeCarPos(st);
          const wait = { x: c.x + 1.4, z: c.z + 1.45 };
          if (dist(o.pos, wait) > 0.05) o.path = policeRoute(s, o.pos, wait);
          else o.yaw = face(o.pos, seat);
        } else if (o.path.length === 0) {
          const outside = policeDoorFront(st, back ? 1 : 0);
          const inside = policeSpawn(st, back ? 1 : 0);
          o.path = dist(o.pos, inside) < 0.05 ? [] : [...(dist(o.pos, outside) > 0.05 ? policeRoute(s, o.pos, outside) : []), inside];
          if (o.path.length === 0) o.inCar = true;
        }
        if (o.path.length > 0 && walk(o, dt, R.walkSpeed) && (!back || k >= 1) && dist(o.pos, policeSpawn(st, back ? 1 : 0)) < 0.05) o.inCar = true;
      });
      const allIn = a.officers.every((o) => o.inCar);
      if (el < R.boardSec || (!allIn && el < R.boardMax)) return;
      attacker.pos = { ...seat };
      for (const o of a.officers) {
        o.inCar = true;
        o.path = [];
        o.pos = { ...policeSpawn(st, a.officers.indexOf(o) % 2) };
      }
      setPhase(s, a, 'fade');
      return;
    }
    case 'fade': {
      if (a.done || el < R.fadeSec) return;
      a.done = true;
      finishIncident(s, ctx, inc);
      endDay();
      return;
    }
  }
}

/** 暗くなったら、その日の営業は終わり（残っている客・店員は帰ったことにして、すぐ精算へ） */
function finishIncident(s: GameState, ctx: SimCtx, inc: IncidentState): void {
  if (inc.eventId) finishEvent(s, inc.eventId, `けが人 ${inc.victims}人${inc.staffVictims ? `（うち店員 ${inc.staffVictims}人）` : ''}・逮捕されてその日の営業は終わり`);
  const ar = s.armory;
  if (ar) {
    ar.doorOpen = false;
    ar.bombs = [];
  }
  for (const p of s.players) if (p.hand.kind === 'weapon') returnWeapon(s, p);
  for (const c of s.customers) {
    if (c.state === 'left' || c.state === 'crew') continue;
    const o = c.orderId ? s.orders.find((x) => x.id === c.orderId) : undefined;
    if (o && o.status === 'waiting') o.status = 'cancelled';
    c.state = 'left';
    c.path = [];
  }
  s.queue = [];
  s.insideQueue = [];
  for (const e of s.employees) {
    if (!e.presentToday) continue;
    if (e.work) cancelWork(s, e, ctx, '営業が終わった');
    if (e.hand.kind !== 'none') dropHand(s, e, ctx);
    e.hand = { kind: 'none' };
    e.commute = null;
    e.presentToday = false;
    e.ai.state = 'off';
    if (e.att && e.att.day === s.day && e.att.status !== 'closed' && e.att.status !== 'off' && e.att.status !== 'absent') e.att.status = 'left';
  }
  notify(s, ctx, 'incident', 'danger', `逮捕され、今日の営業は終わりです（けが人 ${inc.victims}人${inc.staffVictims ? `・うち店員 ${inc.staffVictims}人` : ''}）`);
  emit(ctx, { type: 'arrestEnd' });
}

function explode(s: GameState, ctx: SimCtx, pos: Vec2): void {
  const r = WEAPONS.bomb?.radius ?? 2.5;
  emit(ctx, { type: 'bombBlast', pos: { ...pos } });
  const hits: Victim[] = [];
  for (const c of s.customers) {
    // 逃げている途中の客も巻き込む（店を出た客・テレビのスタッフは除く）
    if (c.hurt || c.state === 'crew' || c.state === 'left' || dist(c.pos, pos) > r) continue;
    hits.push(c);
  }
  for (const e of s.employees) if (staffAttackable(e) && dist(e.pos, pos) <= r) hits.push(e);
  addDirt(s, { x: pos.x, z: pos.z }, 'blood', 'dining');
  startIncident(s, ctx, 0, null);
  for (const v of hits) hurtVictim(s, ctx, v);
}

/** 新しい客が来ないか（事件の日は来ない） */
export function incidentStopsArrivals(s: GameState): boolean {
  return incidentToday(s) !== null;
}
