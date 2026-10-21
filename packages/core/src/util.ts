// 乱数・ID・数値ユーティリティ。乱数の状態は GameState に保存し、決定的に再現できるようにする。

import type { GameState, Vec2 } from './types';

/** mulberry32。状態は s.rng（uint32）に保存する */
export function rand(s: { rng: number }): number {
  s.rng = (s.rng + 0x6d2b79f5) >>> 0;
  let t = s.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function randRange(s: { rng: number }, a: number, b: number): number {
  return a + (b - a) * rand(s);
}

export function randInt(s: { rng: number }, a: number, bInclusive: number): number {
  return a + Math.floor(rand(s) * (bInclusive - a + 1));
}

export function pick<T>(s: { rng: number }, arr: readonly T[]): T {
  if (arr.length === 0) throw new Error('pick from empty array');
  return arr[Math.floor(rand(s) * arr.length)] as T;
}

/** 平均0・標準偏差1の正規乱数（Box-Muller） */
export function randNormal(s: { rng: number }): number {
  const u = Math.max(1e-9, rand(s));
  const v = rand(s);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function newId(s: GameState, prefix: string): string {
  const id = `${prefix}${s.nextId}`;
  s.nextId += 1;
  return id;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** 円単位に丸める（会計は整数円で扱う） */
export function yen(v: number): number {
  return Math.round(v);
}

export function hashString(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function formatYen(v: number): string {
  const sign = v < 0 ? '-' : '';
  return `${sign}¥${Math.abs(Math.round(v)).toLocaleString('ja-JP')}`;
}
