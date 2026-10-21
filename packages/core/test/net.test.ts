import { describe, expect, it } from 'vitest';
import { applyAction, applyPatch, canonicalJson, diff, step } from '../src';
import { addBot, newGame } from './helpers';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe('同期（差分パッチ）', () => {
  it('任意の変更を差分で再現できる', () => {
    const a = { x: 1, arr: [1, 2, 3], items: [{ id: 'a', v: 1 }, { id: 'b', v: 2 }], o: { k: 'x', del: 1 } };
    const b = { x: 2, arr: [1, 2], items: [{ id: 'b', v: 3 }, { id: 'c', v: 9 }], o: { k: 'y' }, n: null };
    const ops = diff(a, b);
    expect(canonicalJson(applyPatch(clone(a), ops))).toBe(canonicalJson(b));
  });

  it('ログ型の配列は先頭削除＋末尾追加の差分になる', () => {
    const a = { log: [{ id: '1' }, { id: '2' }, { id: '3' }] };
    const b = { log: [{ id: '2' }, { id: '3' }, { id: '4' }] };
    const ops = diff(a, b);
    expect(ops.every((o) => o.o === 'sp')).toBe(true);
    expect(canonicalJson(applyPatch(clone(a), ops))).toBe(canonicalJson(b));
  });

  it('営業中のゲーム状態を差分だけで追従でき、最終的に完全一致する', () => {
    const { s, ctx } = newGame(91);
    addBot(s, 'cook');
    addBot(s, 'server');
    addBot(s, 'cleaner');
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    let client = clone(s);
    let last = clone(s);
    let bytes = 0;
    for (let i = 0; i < 600; i++) {
      step(s, 0.1, ctx);
      if (i % 2 === 0) {
        const ops = diff(last, s);
        bytes += JSON.stringify(ops).length;
        client = applyPatch(client, clone(ops));
        last = clone(s);
      }
    }
    client = applyPatch(client, clone(diff(last, s)));
    expect(canonicalJson(client)).toBe(canonicalJson(s));
    // 1秒あたりの通信量の目安（5回/秒）
    const perSec = bytes / 60;
    expect(perSec).toBeLessThan(60_000);
  });
});
