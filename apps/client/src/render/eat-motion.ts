// 食事の動き（第2版 6-2）。描画に依存しない純粋な計算（単体テストできる）。
// 食事の進み具合（0..1、core の eatLeft / eatTotal から）と時刻から、どの動作をしているかと、丼に残っている量を決める。
//   丼に顔を近づける → 箸で麺を持ち上げる → すする → 具を食べる → ときどき丼を持ってスープを飲む → 食べ終わったら箸を置く
// 丼の中身の表示は食べた分だけ減らす（見た目だけ食べていて中身が変わらない、という不整合をなくす）。

import type { BowlContents } from '@jiro/core';

export type EatPhase = 'lean' | 'lift' | 'slurp' | 'topping' | 'soup' | 'done';

export interface EatMotion {
  phase: EatPhase;
  /** 0..1 その動作の中での進み */
  k: number;
  /** 上体の前傾（ラジアン） */
  lean: number;
  /** 頭の傾き（ラジアン、正 = うつむく） */
  head: number;
  /** 右手（箸）の高さ 0..1（1 = 口元より上、麺を持ち上げた） */
  handR: number;
  /** 左手で丼を持ち上げる 0..1 */
  bowlLift: number;
  /** 箸を持っている（食べ終わったら置く） */
  chopsticks: boolean;
}

/** 1回のひと口の長さ（秒）。食べ方の汚い客は速く雑に食べる */
const CYCLE = 5.2;
const MESSY_CYCLE = 3.6;
/** 食べ終わりの割合（ここから先は箸を置く） */
export const EAT_DONE_AT = 0.95;

/** 食事の進み具合（0..1） */
export function eatProgress(eatLeft: number, eatTotal: number | undefined): number {
  if (!eatTotal || eatTotal <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - eatLeft / eatTotal));
}

/**
 * 動作を決める。t は時刻（秒）、seed は人ごとのずれ（全員が同じ動きにならないように）
 */
export function eatMotion(progress: number, t: number, seed: number, messy = false): EatMotion {
  if (progress >= EAT_DONE_AT) {
    // 食べ終わり: 箸を置いて背を起こす
    return { phase: 'done', k: Math.min(1, (progress - EAT_DONE_AT) / (1 - EAT_DONE_AT)), lean: 0.1, head: 0.05, handR: 0, bowlLift: 0, chopsticks: false };
  }
  const len = messy ? MESSY_CYCLE : CYCLE;
  const x = t / len + seed * 0.37;
  const cycle = Math.floor(x);
  const u = x - cycle;
  // スープは3口に1回くらい（人ごとにずれる）
  const soupTurn = (cycle + Math.floor(seed * 7)) % 3 === 0;
  const lean = messy ? 0.5 : 0.36;
  if (u < 0.12) {
    // 丼に顔を近づける
    const k = u / 0.12;
    return { phase: 'lean', k, lean: lean * (0.6 + 0.4 * k), head: 0.3 + 0.12 * k, handR: 0.2, bowlLift: 0, chopsticks: true };
  }
  if (u < 0.36) {
    // 箸で麺を高く持ち上げる（天地返しのように）
    const k = (u - 0.12) / 0.24;
    return { phase: 'lift', k, lean, head: 0.42 - 0.2 * k, handR: 0.2 + 0.8 * Math.sin((k * Math.PI) / 2), bowlLift: 0, chopsticks: true };
  }
  if (u < 0.6) {
    // すする（手を口元へ下ろし、頭を少し上下）
    const k = (u - 0.36) / 0.24;
    const bob = Math.sin(k * Math.PI * (messy ? 6 : 4)) * (messy ? 0.08 : 0.04);
    return { phase: 'slurp', k, lean: lean + 0.04, head: 0.36 + bob, handR: 0.65 - 0.25 * k, bowlLift: 0, chopsticks: true };
  }
  if (soupTurn && u < 0.82) {
    // 丼を持ってスープを飲む
    const k = (u - 0.6) / 0.22;
    const up = Math.sin(k * Math.PI);
    return { phase: 'soup', k, lean: lean * (1 - 0.5 * up), head: 0.3 - 0.35 * up, handR: 0.15, bowlLift: up, chopsticks: true };
  }
  // 具（ヤサイ・豚）をつまむ
  const k = soupTurn ? (u - 0.82) / 0.18 : (u - 0.6) / 0.4;
  const peck = Math.abs(Math.sin(k * Math.PI * 2));
  return { phase: 'topping', k, lean, head: 0.4, handR: 0.2 + 0.4 * peck, bowlLift: 0, chopsticks: true };
}

/** 表示の段階（丼の作り直しを少なくするため、食べた量を5段階にまとめる） */
export function eatenStep(progress: number): number {
  return Math.min(5, Math.floor(Math.min(1, progress / EAT_DONE_AT) * 5));
}

/**
 * 食べた分だけ減らした中身（表示用）。麺・具は食べた分だけ減り、スープは少し残る。
 * step は eatenStep の値（0 = 手を付けていない、5 = 食べ終わり）
 */
export function eatenContents(c: BowlContents, step: number): BowlContents {
  if (step <= 0) return c;
  const left = Math.max(0, 1 - step / 5);
  const toppings = { ...c.toppings };
  for (const k of Object.keys(toppings) as (keyof typeof toppings)[]) toppings[k] = Math.round(toppings[k] * left * 2) / 2;
  return {
    ...c,
    noodleG: Math.round(c.noodleG * left),
    buta: Math.round(c.buta * left),
    toppings,
    soupL: c.soupL * (0.35 + 0.65 * left),
  };
}
