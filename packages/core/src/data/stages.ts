// 店舗の拡張段階（設計書 12）。座標は m、グリッドは CELL(0.5m) 単位。
// x: 店の左→右、z: 店の正面（通り側, z=0 が正面の壁）→奥。z<0 は店外の歩道。

import type { Rot } from '../types';

export const CELL = 0.5;

export interface RectCells {
  x0: number;
  z0: number;
  x1: number; // 排他的
  z1: number; // 排他的
}

export interface StageDef {
  id: number;
  name: string;
  /** 店内の大きさ（セル） */
  w: number;
  d: number;
  kitchen: RectCells;
  dining: RectCells;
  /** カウンター（建物の一部） */
  counter: RectCells;
  /** 入口（正面の壁の開口, x 範囲 m） */
  door: { x0: number; x1: number };
  /** 席の位置（客が座る位置, m） */
  seats: { x: number; z: number }[];
  /** 店内の後ろ待ち位置 */
  waitSpots: { x: number; z: number }[];
  /** 従業員の出入口付近 */
  staffSpawn: { x: number; z: number };
  playerSpawn: { x: number; z: number };
  rent: number;
  constructionCost: number;
  /** 工事の追加で必要な手元資金 */
  minFundsAfter: number;
  unlock?: string;
  maxEquipment: number;
  /** 工事で休業する日数 */
  closureDays: number;
  /** 設備移設費（設備1台あたり） */
  relocationPerItem: number;
  /**
   * この大きさの店で、売れ行きに合わせて仕入れるのに必要な冷蔵庫の容量の目安（kg）。拡張の案内に出す。
   * 12席で1日90杯を超えると、麺・豚肉・もやしが冷蔵庫1台（100kg）に入りきらない（経済の測定）。16・22席は未測定の仮の値
   */
  fridgeKgNeeded: number;
  description: string;
}

function seatRow(n: number, x0: number, step: number, z: number) {
  return Array.from({ length: n }, (_, i) => ({ x: +(x0 + i * step).toFixed(3), z }));
}

function waitRow(n: number, x0: number, step: number, z: number) {
  return Array.from({ length: n }, (_, i) => ({ x: +(x0 + i * step).toFixed(3), z }));
}

export const STAGES: StageDef[] = [
  {
    id: 0,
    name: '小規模店舗（8席）',
    w: 16, d: 13,
    kitchen: { x0: 0, z0: 5, x1: 16, z1: 13 },
    dining: { x0: 0, z0: 0, x1: 16, z1: 4 },
    counter: { x0: 2, z0: 4, x1: 16, z1: 5 },
    door: { x0: 0.4, x1: 1.4 },
    seats: seatRow(8, 1.6, 0.82, 1.55),
    waitSpots: waitRow(7, 3.1, 0.62, 0.62),
    staffSpawn: { x: 0.5, z: 3.0 },
    playerSpawn: { x: 3.0, z: 3.0 },
    rent: 8_000, constructionCost: 0, minFundsAfter: 0, maxEquipment: 18, closureDays: 0, relocationPerItem: 0, fridgeKgNeeded: 100,
    description: 'カウンター8席の小さな店。最初はほぼ一人で回す。',
  },
  {
    id: 1,
    name: '拡張店舗（12席）',
    w: 22, d: 13,
    kitchen: { x0: 0, z0: 5, x1: 22, z1: 13 },
    dining: { x0: 0, z0: 0, x1: 22, z1: 4 },
    counter: { x0: 2, z0: 4, x1: 22, z1: 5 },
    door: { x0: 0.4, x1: 1.4 },
    seats: seatRow(12, 1.6, 0.8, 1.55),
    waitSpots: waitRow(11, 3.1, 0.62, 0.62),
    staffSpawn: { x: 0.5, z: 3.0 },
    playerSpawn: { x: 3.0, z: 3.0 },
    // 工事費 600,000 → 300,000円・運転資金 100,000 → 60,000円・移設 3,000 → 2,000円/台（経済の調整 Phase 1-5）。
    // 上手に経営すると25日前後で、工事費＋移設＋席＋2台目の冷蔵庫＋運転資金がたまる（オーナーの判断: 約4時間で12席）
    rent: 11_000, constructionCost: 300_000, minFundsAfter: 60_000, unlock: 'stage2', maxEquipment: 24, closureDays: 1,
    relocationPerItem: 2_000, fridgeKgNeeded: 200,
    description: '隣の区画を借りてカウンターを12席に延長。厨房も広がる。',
  },
  {
    id: 2,
    name: '中規模店舗（16席）',
    w: 28, d: 16,
    kitchen: { x0: 0, z0: 5, x1: 28, z1: 16 },
    dining: { x0: 0, z0: 0, x1: 28, z1: 4 },
    counter: { x0: 2, z0: 4, x1: 28, z1: 5 },
    door: { x0: 0.4, x1: 1.4 },
    seats: seatRow(16, 1.6, 0.8, 1.55),
    waitSpots: waitRow(15, 3.1, 0.62, 0.62),
    staffSpawn: { x: 0.5, z: 3.0 },
    playerSpawn: { x: 3.0, z: 3.0 },
    rent: 15_000, constructionCost: 1_400_000, minFundsAfter: 200_000, unlock: 'stage3', maxEquipment: 32, closureDays: 1,
    relocationPerItem: 4_000, fridgeKgNeeded: 250,
    description: '奥行きを広げた中規模店。厨房に複数の作業列を置ける。',
  },
  {
    id: 3,
    name: '大型店舗（22席）',
    w: 36, d: 18,
    kitchen: { x0: 0, z0: 5, x1: 36, z1: 18 },
    dining: { x0: 0, z0: 0, x1: 36, z1: 4 },
    counter: { x0: 2, z0: 4, x1: 36, z1: 5 },
    door: { x0: 0.4, x1: 1.4 },
    seats: seatRow(22, 1.6, 0.78, 1.55),
    waitSpots: waitRow(20, 3.1, 0.62, 0.62),
    staffSpawn: { x: 0.5, z: 3.0 },
    playerSpawn: { x: 3.0, z: 3.0 },
    rent: 22_000, constructionCost: 2_800_000, minFundsAfter: 400_000, unlock: 'stage4', maxEquipment: 44, closureDays: 2,
    relocationPerItem: 5_000, fridgeKgNeeded: 350,
    description: '22席の大型店。従業員を活かして大量の客をさばく。',
  },
];

export interface DefaultPlacement {
  type: string;
  gx: number;
  gz: number;
  rot: Rot;
}

/**
 * 開業時に引き継ぐ設備（居抜き物件）と初期配置。
 * カウンター裏（z 2.5〜3.5m）は配膳用の通路として空けておき、
 * その奥に「調理ライン」（手前列）と「仕込み・洗い場」（奥列）を並べる。
 */
export const STARTING_LAYOUT: DefaultPlacement[] = [
  // 手前列: カウンター側（通路側）を向く
  { type: 'soup_pot', gx: 2, gz: 7, rot: 0 },
  { type: 'assembly', gx: 4, gz: 7, rot: 0 },
  { type: 'topping', gx: 7, gz: 7, rot: 0 },
  { type: 'noodle_boiler', gx: 9, gz: 7, rot: 0 },
  { type: 'bowl_rack', gx: 11, gz: 7, rot: 0 },
  // 奥列: 壁沿い
  { type: 'fridge', gx: 0, gz: 11, rot: 0 },
  { type: 'prep_table', gx: 2, gz: 11, rot: 0 },
  { type: 'braise_pot', gx: 5, gz: 11, rot: 0 },
  { type: 'veg_boiler', gx: 7, gz: 11, rot: 0 },
  { type: 'sink', gx: 9, gz: 11, rot: 0 },
  { type: 'locker', gx: 12, gz: 11, rot: 0 },
  { type: 'desk', gx: 13, gz: 11, rot: 0 },
  { type: 'trash', gx: 15, gz: 11, rot: 0 },
  // 客席側
  { type: 'ticket_machine', gx: 4, gz: 0, rot: 2 },
];

export const STARTING_SEATS = 8;
export const STARTING_BOWLS = 14;

/** 店外の行列位置（歩道） */
export function streetQueueSpot(i: number): { x: number; z: number } {
  const perRow = 22;
  const row = Math.floor(i / perRow);
  const col = i % perRow;
  return { x: 2.0 + col * 0.6, z: -0.9 - row * 0.7 };
}
