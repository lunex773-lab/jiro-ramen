#!/usr/bin/env python3
# 市区町村の面積（km²）を、同梱の出店マップの形（apps/client/public/map/pref-NN.json）から作る（じろ1 5.5 人口密度）。
# 地図（国土地理院「地球地図日本」を jpn-atlas が投影したもの）は正積図法なので、形の面積は実際の面積に比例する
# （都道府県の面積との比はどこも約14.05で一定）。全国の合計を国土の面積（約377,975km²）に合わせて km² にする。
# 生成物はリポジトリに入れるので、ふだんは実行しなくてよい。
# 実行: python3 -I scripts/regional/build-area-data.py [出力のファイル]
#   出力の既定: packages/core/src/data/areas.ts
import glob
import json
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
MAP = os.path.join(ROOT, 'apps', 'client', 'public', 'map')
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'packages', 'core', 'src', 'data', 'areas.ts')
NATIONAL_KM2 = 377_975

NUM = re.compile(r'-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?')


def path_area(d: str) -> float:
    """SVG のパス（M・L・Z だけ）の面積。穴（逆回りの輪）は引く"""
    total = 0.0
    for sub in re.findall(r'M[^M]*', d):
        pts = [tuple(map(float, p.split(','))) for p in NUM.findall(sub)]
        a = 0.0
        for i in range(len(pts)):
            x1, y1 = pts[i]
            x2, y2 = pts[(i + 1) % len(pts)]
            a += x1 * y2 - x2 * y1
        total += a / 2
    return abs(total)


rows = {}
for f in sorted(glob.glob(os.path.join(MAP, 'pref-*.json'))):
    with open(f, encoding='utf-8') as fh:
        j = json.load(fh)
    for m in j['municipalities']:
        rows[m['code']] = path_area(m['d'])
if len(rows) < 1700:
    raise SystemExit('地図の市区町村が足りません')
scale = NATIONAL_KM2 / sum(rows.values())

lines = [
    '// 市区町村の面積（km²。じろ1 5.5 人口密度）。scripts/regional/build-area-data.py が作る（手で直さない）。',
    '// 出店マップの形（国土地理院「地球地図日本」を正積図法で投影したもの。jpn-atlas, BSD-3-Clause）から求め、',
    f'// 全国の合計を国土の面積（約{NATIONAL_KM2:,}km²）に合わせた（1単位 = {scale:.3f}km²）。小さな区は ±10% ほどずれることがある。',
    '',
    '/** 市区町村のコード（5桁）→ 面積（km²） */',
    'export const MUNICIPALITY_AREA_KM2: Readonly<Record<string, number>> = {',
]
for code in sorted(rows):
    lines.append(f"  '{code}': {round(rows[code] * scale, 1)},")
lines.append('};')
lines.append('')
with open(OUT, 'w', encoding='utf-8') as fh:
    fh.write('\n'.join(lines))
print(f'{len(rows)} 市区町村 → {OUT}（1単位 = {scale:.3f}km²）')
