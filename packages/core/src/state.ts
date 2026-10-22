// 新しいゲーム（キャリア）の作成。

import { BALANCE } from './data/balance';
import { MENU } from './data/menu';
import { STAGES, STARTING_BOWLS, STARTING_LAYOUT, STARTING_SEATS } from './data/stages';
import { makeEquipment } from './sim/equipment';
import { emptyDayStats } from './sim/economy';
import { addLot } from './sim/inventory';
import type { GameState, Player, Seat } from './types';
import { newId } from './util';

export const SCHEMA_VERSION = 1;

export interface NewGameOptions {
  seed?: number;
  shopName?: string;
  playerName?: string;
  playerId?: string;
}

export const PLAYER_COLORS = ['#e74c3c', '#2e86de', '#27ae60', '#f39c12'];

export function makePlayer(s: GameState, id: string, name: string, isHost: boolean): Player {
  const st = STAGES[s.career.stage]!;
  const idx = s.players.length;
  return {
    id,
    kind: 'player',
    name,
    color: PLAYER_COLORS[idx % PLAYER_COLORS.length]!,
    connected: true,
    isHost,
    pos: { x: st.playerSpawn.x + idx * 0.6, z: st.playerSpawn.z },
    yaw: Math.PI, // 客席側（-z）を向く
    hand: { kind: 'none' },
    work: null,
    lastMoveAt: 0,
  };
}

export function createGame(opts: NewGameOptions = {}): GameState {
  const seed = (opts.seed ?? Math.floor(Math.random() * 2 ** 31)) >>> 0;
  const s: GameState = {
    schema: SCHEMA_VERSION,
    seed,
    rng: seed,
    shopName: opts.shopName?.trim() || 'ラーメン まし屋',
    nextId: 1,
    version: 0,
    day: 1,
    phase: 'prep',
    t: 0,
    openT: 0,
    closedForConstruction: 0,
    money: BALANCE.initialMoney,
    arrears: [],
    loans: [],
    transactions: [],
    today: emptyDayStats(),
    history: [],
    cashAtDayStart: BALANCE.initialMoney,
    inventory: [],
    deliveries: [],
    autoOrder: {
      noodle: 20_000,
      pork_raw: 8,
      bones: 10_000,
      backfat_raw: 2_000,
      moyashi: 12_000,
      cabbage: 3_000,
      garlic_raw: 1_000,
      soy: 5_400,
      ichimi: 300,
    },
    equipment: [],
    seats: [],
    bowls: [],
    dirt: [],
    kitchenGrime: 0,
    lostItems: [],
    layoutVersion: 1,
    players: [],
    employees: [],
    candidates: [],
    customers: [],
    orders: [],
    queue: [],
    insideQueue: [],
    arrivalAcc: 0,
    regularsVisitedToday: [],
    reputation: BALANCE.reputation.initial,
    reviews: [],
    todayReviews: [],
    regulars: [],
    career: {
      stage: 0,
      goalsDone: [],
      unlocked: [],
      totalServed: 0,
      bestDayServed: 0,
      bestDayProfit: Number.NEGATIVE_INFINITY,
      daysPlayed: 0,
    },
    prices: Object.fromEntries(Object.values(MENU).map((m) => [m.id, m.defaultPrice])),
    pausedMenu: [],
    notices: [],
    bankruptcy: null,
    paused: false,
  };
  // JSON で表現できない -Infinity は使わない
  s.career.bestDayProfit = -1e12;

  for (const p of STARTING_LAYOUT) {
    const e = makeEquipment(s, p.type, p.gx, p.gz, p.rot, true);
    if (p.type === 'soup_pot') {
      e.soupL = 18;
      e.soupQuality = 0.8;
      e.soupCost = 18 * 58;
    }
    s.equipment.push(e);
  }

  const st = STAGES[0]!;
  st.seats.forEach((_, i) => {
    const seat: Seat = {
      id: `seat${i}`,
      index: i,
      installed: i < STARTING_SEATS,
      offset: { x: 0, z: 0 },
      dirt: 0,
      customerId: null,
      bowlId: null,
      lostItemId: null,
    };
    s.seats.push(seat);
  });

  for (let i = 0; i < STARTING_BOWLS; i++) {
    s.bowls.push({ id: newId(s, 'b'), state: 'clean', loc: { at: 'rack' }, contents: null, orderId: null });
  }

  // 開業日に必要な最低限の在庫（前の店主からの引き継ぎ分）
  addLot(s, 'noodle', 15_000, 0.3);
  addLot(s, 'pork_raw', 4, 850);
  addLot(s, 'pork_block', 2, 870);
  addLot(s, 'buta', 36, 48);
  addLot(s, 'soy', 3_600, 0.39);
  addLot(s, 'tare', 1_500, 0.29);
  addLot(s, 'bones', 10_000, 0.18);
  addLot(s, 'backfat_raw', 2_000, 0.35);
  addLot(s, 'moyashi', 8_000, 0.12);
  addLot(s, 'cabbage', 2_000, 0.15);
  addLot(s, 'garlic_raw', 1_000, 1.0);
  addLot(s, 'garlic', 300, 1.0);
  addLot(s, 'abura', 600, 0.38);
  addLot(s, 'yasai', 5_000, 0.13);
  addLot(s, 'ichimi', 300, 2);

  s.players.push(makePlayer(s, opts.playerId ?? 'p1', opts.playerName?.trim() || '店主', true));
  return s;
}
