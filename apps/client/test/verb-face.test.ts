import { describe, expect, it } from 'vitest';
import { TUTORIAL_STEPS, VERB_IDS } from '@jiro/core';
import { verbFace } from '../src/ui/verb-face';

describe('操作ボタンの絵文字と短い名前', () => {
  it('すべての操作に絵文字と4文字以内の名前がある', () => {
    for (const id of VERB_IDS) {
      const f = verbFace(id, '');
      expect(f.icon, id).not.toBe('👉');
      expect(f.short.length, id).toBeLessThanOrEqual(4);
    }
  });

  it('正式な名前の数をボタンの隅に出す', () => {
    expect(verbFace('noodles_in', '麺を入れる（2玉）').badge).toBe('2');
    expect(verbFace('noodles_in', '麺を入れる（見込み1玉）').badge).toBe('1');
    expect(verbFace('wipe', 'カウンターを拭く（汚れ40%）').badge).toBe('40%');
    expect(verbFace('prep:braise_pork', '豚を煮込む（120秒）').badge).toBe('120秒');
    // 席番号などの説明は数として出さない
    expect(verbFace('bowl_take', '丼を持つ（3番 小ラーメン）').badge).toBeNull();
    expect(verbFace('serve', '2番席に提供する').badge).toBeNull();
  });

  it('丼を持っているときの「丼を置く」は「置く」', () => {
    expect(verbFace('bowls_place', '丼を置く').short).toBe('置く');
    expect(verbFace('bowls_place', '丼を並べる').short).toBe('並べる');
  });

  it('チュートリアルの文に出てくるボタン（「絵文字 名前」）は、実際のボタンと同じ表示', () => {
    const faces = new Set(VERB_IDS.map((id) => `${verbFace(id, '').icon} ${verbFace(id, '').short}`));
    faces.add(`${verbFace('bowls_place', '丼を置く').icon} 置く`);
    // 上部の経営メニューのボタン
    faces.add('☰ 経営');
    const texts = Object.values(TUTORIAL_STEPS).flatMap((steps) => steps.map((st) => st.text));
    const quoted = texts.flatMap((t) => [...t.matchAll(/「(\p{Extended_Pictographic}️? [^」]+)」/gu)].map((m) => m[1]!));
    expect(quoted.length).toBeGreaterThan(10);
    for (const q of quoted) expect(faces, q).toContain(q);
  });
});
