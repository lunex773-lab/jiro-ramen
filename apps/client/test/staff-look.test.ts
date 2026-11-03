import { describe, expect, it } from 'vitest';
import { lookSeedOf, lookSeedOfId, staffLook, staffLookKey, staffLookText } from '../src/render/staff-look';

describe('従業員の見た目の個性', () => {
  it('同じ番号なら必ず同じ見た目（採用の候補のときと採用したあと・共同経営の全員で同じ）', () => {
    for (const seed of [0, 1, 42, 99999, 123456]) expect(staffLook(seed)).toEqual(staffLook(seed));
  });

  it('人によって制服の色・頭・小物がばらける', () => {
    const looks = Array.from({ length: 60 }, (_, i) => staffLook(i * 7919 + 13));
    expect(new Set(looks.map((l) => l.shirt)).size).toBeGreaterThanOrEqual(7);
    expect(new Set(looks.map((l) => l.apron)).size).toBeGreaterThanOrEqual(6);
    expect(new Set(looks.map((l) => l.headwear))).toEqual(new Set(['towel', 'bandana', 'wrap', 'cookcap', 'cap', 'none']));
    expect(looks.some((l) => l.glasses)).toBe(true);
    expect(looks.some((l) => l.beard !== 'none')).toBe(true);
    expect(looks.some((l) => l.neckTowel)).toBe(true);
    // ほとんどの人は組み合わせが違う
    expect(new Set(looks.map(staffLookKey)).size).toBeGreaterThanOrEqual(55);
  });

  it('女性の従業員にはひげがなく、前掛けはシャツと同じ色にならない', () => {
    for (let i = 0; i < 300; i++) {
      const l = staffLook(i);
      if (l.female) expect(l.beard).toBe('none');
      expect(l.apron).not.toBe(l.shirt);
      if (l.headwear === 'towel' || l.headwear === 'wrap') expect(l.neckTowel).toBe(false);
    }
  });

  it('経営メニューの説明は見た目と合う', () => {
    for (let i = 0; i < 50; i++) {
      const l = staffLook(i * 31);
      const t = staffLookText(l);
      expect(t).toContain(`${l.shirtName}の`);
      expect(t).toContain(`${l.apronName}の前掛け`);
      expect(t).toContain(l.headName);
      expect(t.includes('メガネ')).toBe(l.glasses !== null);
    }
  });

  it('見た目の番号を持たない古いセーブの従業員は id から決まる', () => {
    expect(lookSeedOf({ id: 'emp12', profile: {} })).toBe(lookSeedOfId('emp12'));
    expect(lookSeedOf({ id: 'emp12', profile: { look: 777 } })).toBe(777);
    expect(lookSeedOfId('emp12')).not.toBe(lookSeedOfId('emp13'));
  });
});
