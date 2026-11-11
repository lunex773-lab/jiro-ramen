#!/usr/bin/env python3
# 市区町村の昼夜間人口比率と、小売業・飲食店の事業所数（packages/core/src/data/daytime.ts）を公的な統計から作る（じろ2: 改修設計書03。
# オーナーの判断「公的な統計を同梱」2026-11-11）。生成物はリポジトリに入れるので、ふだんは実行しなくてよい。
# 使い方（ダウンロードしたファイルはデータとして読むだけ）:
#   python3 -I scripts/regional/build-daytime-data.py 第1-1表.xlsx 第6-1表.xlsx packages/core/src/data/daytime.ts
# 入力:
#   1. 総務省統計局「令和2年国勢調査 従業地・通学地による人口・就業状態等集計」第1-1表
#      「男女，年齢（5歳階級），常住地又は従業地・通学地別人口及び昼夜間人口比率－全国，都道府県，市区町村」（e-Stat statInfId=000032214141 の Excel）
#   2. 総務省・経済産業省「令和3年経済センサス‐活動調査 事業所に関する集計－産業横断的集計」第6-1表
#      「産業(中分類)別民営事業所数…－全国、都道府県、市区町村」（e-Stat statInfId=000040067880 の Excel）
#      小売業 = 中分類の「I2_小売業」（56〜61）、飲食店 = 「76_飲食店」（持ち帰り・配達飲食サービス業は入れない）
import re
import sys

import openpyxl

day_x, census_x, out = sys.argv[1:4]
CODE = re.compile(r'^(\d{5})_')


def code_of(v):
    m = CODE.match(str(v or ''))
    if not m:
        return None
    c = m.group(1)
    # 全国（00000）・都道府県（NN000）は入れない
    return None if c.endswith('000') else c


def num(v):
    if isinstance(v, (int, float)):
        return v
    return None  # '-'・'X'（秘匿）など


# 1. 昼夜間人口比率（男女の総数・年齢の総数の行。列: 5 = 夜間人口、17 = 昼間人口、24 = 昼夜間人口比率）
ratio = {}
wb = openpyxl.load_workbook(day_x, read_only=True, data_only=True)
ws = wb.worksheets[0]
for row in ws.iter_rows(min_row=11, values_only=True):
    if len(row) < 25 or row[3] != '0_総数' or row[4] != '00_総数':
        continue
    c = code_of(row[2])
    if not c:
        continue
    night, day, r = num(row[5]), num(row[17]), num(row[24])
    if r is None and night and day:
        r = day / night * 100
    if r is None:
        continue
    ratio[c] = round(float(r), 1)
assert len(ratio) > 1700, len(ratio)
assert abs(ratio['01100'] - 100.0) < 0.5, ratio['01100']

# 2. 小売業・飲食店の事業所数（列 5 = 事業所数）
retail = {}
food = {}
wb = openpyxl.load_workbook(census_x, read_only=True, data_only=True)
ws = wb.worksheets[0]
for row in ws.iter_rows(min_row=10, values_only=True):
    if len(row) < 6:
        continue
    c = code_of(row[1])
    if not c:
        continue
    ind = str(row[4] or '')
    n = num(row[5])
    if ind == 'I2_小売業':
        retail[c] = int(n or 0)
    elif ind == '76_飲食店':
        food[c] = int(n or 0)
assert len(retail) > 1700 and len(food) > 1700, (len(retail), len(food))

codes = sorted(set(ratio) | set(retail) | set(food))
lines = [
    '// 市区町村の昼夜間人口比率と、小売業・飲食店の事業所数（じろ2: 改修設計書03。オーナーの判断「公的な統計を同梱」）。',
    '// scripts/regional/build-daytime-data.py が作る（手で直さない）。',
    '// - 昼夜間人口比率: 総務省統計局「令和2年国勢調査 従業地・通学地による人口・就業状態等集計」第1-1表（昼間人口 ÷ 夜間人口 × 100）',
    '// - 事業所数: 総務省・経済産業省「令和3年経済センサス‐活動調査」第6-1表（民営事業所数。小売業 = 中分類56〜61、飲食店 = 中分類76）',
    '',
    '/** 市区町村のコード（5桁）→ [昼夜間人口比率（%）, 小売業の事業所数, 飲食店の事業所数]。わからない値は -1 */',
    'export const MUNICIPALITY_DAYTIME: Readonly<Record<string, readonly [number, number, number]>> = {',
]
for c in codes:
    lines.append(f"  '{c}': [{ratio.get(c, -1)}, {retail.get(c, -1)}, {food.get(c, -1)}],")
lines.append('};')
lines.append('')
with open(out, 'w', encoding='utf-8') as f:
    f.write('\n'.join(lines))
print('wrote', out, len(codes), 'municipalities')
