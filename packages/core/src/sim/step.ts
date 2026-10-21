// シミュレーションの1ステップ。シングルプレイではブラウザ内で、共同経営では Durable Object 上で同じ関数を回す。

import { BALANCE } from '../data/balance';
import { EQUIPMENT } from '../data/equipment';
import { INGREDIENTS } from '../data/ingredients';
import { accessPoint } from '../geometry';
import type { GameState } from '../types';
import { clamp01, rand } from '../util';
import { coolBowl } from './cooking';
import { addDirt, spawnLostItemOwners, updateArrivals, updateCustomers } from './customers';
import { allCustomersGone, checkGoals, settleDay, startClosing } from './day';
import { onEmployeeWorkDone, updateEmployees } from './employees';
import { defOf, effectSum, updateRepairs } from './equipment';
import { completeProcess, progressWork, roleOf } from './interact';
import { receiveDeliveries, stockOf } from './inventory';
import { clearNotice, emit, notify, type SimCtx } from './notices';

/** 1ステップの最大時間（大きな dt は分割する） */
const MAX_DT = 0.25;

export function step(s: GameState, dt: number, ctx: SimCtx): void {
  if (!(dt > 0)) return;
  let left = Math.min(dt, 5);
  while (left > 1e-9) {
    const d = Math.min(MAX_DT, left);
    stepOnce(s, d, ctx);
    left -= d;
  }
}

function stepOnce(s: GameState, dt: number, ctx: SimCtx): void {
  if (s.phase === 'closed' || s.phase === 'bankrupt' || s.paused) return;
  s.t += dt;
  if (s.phase === 'open') s.openT += dt;

  receiveDeliveries(s, ctx, false);
  updateRepairs(s, ctx);
  updateEquipment(s, dt, ctx);

  // 行為者の長押し作業
  for (const a of [...s.players, ...s.employees]) {
    if (a.work && progressWork(s, a, dt, ctx)) onEmployeeWorkDone(a);
  }
  updateEmployees(s, dt, ctx);

  if (s.phase === 'open') {
    updateArrivals(s, dt, ctx);
    spawnLostItemOwners(s, ctx);
  }
  updateCustomers(s, dt, ctx);
  housekeeping(s, dt, ctx);

  // 1秒ごとの判定
  if (Math.floor(s.t) !== Math.floor(s.t - dt)) {
    periodicChecks(s, ctx);
  }

  if (s.phase === 'open' && s.openT >= BALANCE.openDuration) startClosing(s, ctx);
  if (s.phase === 'closing' && allCustomersGone(s)) {
    settleDay(s, ctx);
  }
  s.version += 1;
}

function updateEquipment(s: GameState, dt: number, ctx: SimCtx): void {
  for (const e of s.equipment) {
    if (!e.placed) continue;
    const def = EQUIPMENT[e.type];
    if (!def) continue;
    const working = e.status !== 'broken' && e.status !== 'repairing';
    const sp = e.status === 'normal' ? 1 : e.status === 'worn' ? 0.9 : e.status === 'faulty' ? 0.7 : 0;
    // 麺釜: 故障しても麺はお湯に浸かったまま（ゆで時間は進むが熱が弱い）
    if (def.role === 'boiler') {
      for (const sl of e.slots) {
        if (!sl) continue;
        sl.elapsed += dt * (working ? sp * def.speed : 0.3);
      }
    }
    if (e.process) {
      if (working) e.process.elapsed += dt * sp * def.speed;
      if (e.process.elapsed >= e.process.duration) completeProcess(s, ctx, e);
    }
    if (def.role === 'dishwasher' && e.washElapsed > 0) {
      if (working) e.washElapsed += dt * sp;
      if (e.washElapsed >= 20) {
        for (const id of e.washing) {
          const b = s.bowls.find((x) => x.id === id);
          if (!b) continue;
          b.state = 'clean';
          b.contents = null;
          b.orderId = null;
          b.loc = { at: 'rack' };
        }
        emit(ctx, { type: 'dishwasherDone', targetId: e.id, value: e.washing.length });
        e.washing = [];
        e.washElapsed = 0;
      }
    }
  }
  // 丼の温度
  for (const b of s.bowls) if (b.contents && b.state !== 'served') coolBowl(b, dt);
}

function housekeeping(s: GameState, dt: number, ctx: SimCtx): void {
  // 提供されなかった注文に割り当てた丼・麺の割り当てを外す
  const live = new Set(s.orders.filter((o) => o.status === 'waiting').map((o) => o.id));
  for (const b of s.bowls) {
    if (b.orderId && !live.has(b.orderId) && b.state === 'assembling') b.orderId = null;
  }
  for (const e of s.equipment) {
    for (const sl of e.slots) if (sl && sl.orderId && !live.has(sl.orderId)) sl.orderId = null;
  }
  // 厨房の汚れ（調理量に比例して発生、換気設備で軽減）
  if (s.phase === 'open' || s.phase === 'closing') {
    const cooking = s.equipment.filter((e) => e.placed && (roleOf(e) === 'boiler' || roleOf(e) === 'soup') && (e.slots.some(Boolean) || e.process)).length;
    const p = cooking * 0.004 * dt * (1 - effectSum(s, 'grimeReduction'));
    if (rand(s) < p) {
      const boilers = s.equipment.filter((e) => e.placed && roleOf(e) === 'boiler');
      const b = boilers[Math.floor(rand(s) * boilers.length)];
      if (b) {
        const ap = accessPoint(b);
        addDirt(s, { x: ap.x + (rand(s) - 0.5) * 0.8, z: ap.z + (rand(s) - 0.5) * 0.4 }, 'grime', 'kitchen');
      }
    }
  }
  const kitchenDirt = s.dirt.filter((d) => d.zone === 'kitchen').reduce((a, d) => a + d.amount, 0);
  const fullBins = s.equipment.filter((e) => e.placed && roleOf(e) === 'trash' && e.fill >= defOf(e).capacity).length;
  s.kitchenGrime = clamp01(kitchenDirt * 0.12 + fullBins * 0.15);
  void ctx;
}

function periodicChecks(s: GameState, ctx: SimCtx): void {
  // 在庫の警告
  const low: [string, number, string][] = [
    ['yasai', 400, 'ヤサイ'],
    ['buta', 6, '豚'],
    ['garlic', 40, 'ニンニク'],
    ['abura', 80, 'アブラ'],
    ['tare', 150, 'タレ'],
  ];
  if (s.phase === 'open' || s.phase === 'prep') {
    for (const [id, th, name] of low) {
      if (stockOf(s, id) < th) notify(s, ctx, `low:${id}`, 'warn', `${name}が残りわずかです（仕込みをしましょう）`);
      else clearNotice(s, `low:${id}`);
    }
    const soup = s.equipment.filter((e) => e.placed && roleOf(e) === 'soup').reduce((a, e) => a + e.soupL, 0);
    if (soup < 4) notify(s, ctx, 'low:soup', 'warn', `スープが残り${soup.toFixed(1)}Lです（寸胴でスープを炊きましょう）`);
    else clearNotice(s, 'low:soup');
    const noodles = stockOf(s, 'noodle') + stockOf(s, 'homemade_noodle');
    if (noodles < 1500) notify(s, ctx, 'low:noodle', 'warn', '麺の在庫が少なくなっています（当日便で発注できます）');
    else clearNotice(s, 'low:noodle');
  }
  // 注文の滞留
  const waiting = s.orders.filter((o) => o.status === 'waiting');
  const old = waiting.filter((o) => s.t - o.createdAt > 90).length;
  if (old > 0) notify(s, ctx, 'backlog', 'warn', `提供待ちが長くなっています（${old}件が90秒以上）`);
  else clearNotice(s, 'backlog');
  // 丼不足
  const clean = s.bowls.filter((b) => b.state === 'clean' && b.loc.at === 'rack').length;
  const dirty = s.bowls.filter((b) => b.state === 'dirty').length;
  if (s.phase !== 'prep' && clean === 0 && dirty > 0) notify(s, ctx, 'nobowls', 'warn', 'きれいな丼がありません。洗い場で洗ってください');
  else clearNotice(s, 'nobowls');
  // 清掃不足
  const dirtySeats = s.seats.filter((x) => x.dirt > 0.6).length;
  if (dirtySeats >= 2) notify(s, ctx, 'dirty', 'warn', `カウンターが汚れている席が${dirtySeats}席あります`);
  else clearNotice(s, 'dirty');
  // ゴミ箱
  for (const e of s.equipment) {
    if (!e.placed || roleOf(e) !== 'trash') continue;
    if (e.fill >= defOf(e).capacity) notify(s, ctx, `trash:${e.id}`, 'warn', 'ゴミ箱がいっぱいです');
    else clearNotice(s, `trash:${e.id}`);
  }
  // 冷蔵庫の故障で食材が傷む
  const fridges = s.equipment.filter((e) => e.placed && roleOf(e) === 'fridge');
  if (fridges.length > 0 && fridges.every((e) => e.status === 'broken' || e.status === 'repairing')) {
    for (const l of s.inventory) {
      if (INGREDIENTS[l.itemId]?.storage === 'fridge') l.quality = Math.max(0.3, l.quality - 0.002);
    }
    notify(s, ctx, 'fridge:down', 'danger', '冷蔵庫が使えず、食材が傷み始めています！');
  }
  // 停滞した従業員
  for (const e of s.employees) {
    if (e.presentToday && e.ai.state === 'idle' && e.ai.idleTime > 60 && (s.phase === 'open')) {
      notify(s, ctx, `idle:${e.id}`, 'info', `${e.profile.name}さんの仕事がありません（担当設定を見直せます）`);
    }
  }
  // ゆですぎの警告
  for (const e of s.equipment) {
    if (!e.placed || roleOf(e) !== 'boiler') continue;
    if (e.slots.some((x) => x && x.elapsed > x.ideal + 6)) notify(s, ctx, `overcook:${e.id}`, 'warn', '麺がゆですぎになっています！');
    else clearNotice(s, `overcook:${e.id}`);
  }
  checkGoals(s, ctx);
}
