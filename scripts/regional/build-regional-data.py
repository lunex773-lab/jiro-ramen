# 都道府県の経済の数字（packages/core/src/data/regional.ts）を公的な統計から作る（じろ1 5.5・5.7）。
# 使い方（ダウンロードしたファイルはデータとして読むだけ）:
#   python3 -I scripts/regional/build-regional-data.py 答申状況.txt 地域差指数.xlsx 1人当たり県民所得.xlsx packages/core/src/data/regional.ts
# 入力:
#   1. 厚生労働省「令和8年度 地域別最低賃金 答申状況」 https://www.mhlw.go.jp/content/11302000/001745621.pdf を pdftotext -layout で文字にしたもの
#   2. 総務省統計局「小売物価統計調査（構造編）2025年 10大費目別消費者物価地域差指数」（e-Stat statInfId=000040506879 の Excel）
#   3. 内閣府「県民経済計算 平成23年度〜令和5年度 1人当たり県民所得」 https://www.esri.cao.go.jp/jp/sna/data/data_list/kenmin/files/contents/tables/2023/soukatu7.xlsx
import re, sys, openpyxl
mw_txt, cpi_x, inc_x, out = sys.argv[1:5]
names=['北海道','青森','岩手','宮城','秋田','山形','福島','茨城','栃木','群馬','埼玉','千葉','東京','神奈川','新潟','富山','石川','福井','山梨','長野','岐阜','静岡','愛知','三重','滋賀','京都','大阪','兵庫','奈良','和歌山','鳥取','島根','岡山','広島','山口','徳島','香川','愛媛','高知','福岡','佐賀','長崎','熊本','大分','宮崎','鹿児島','沖縄']
mw={}
for line in open(mw_txt,encoding='utf-8'):
    m=re.match(r'\s*(.+?)\s+([ABC])\s+(\d+)\s+([\d,]+)\s+（\s*([\d,]+)\s*\)\s+(\d+)\s+\S+\s+令和8年(\d+)月(\d+)日',line)
    if not m: continue
    name=re.sub(r'\s','',m.group(1))
    if name not in names: raise SystemExit('unknown '+name)
    mw[name]=dict(y2026=int(m.group(4).replace(',','')), y2025=int(m.group(5).replace(',','')), up=int(m.group(6)), eff=f'2026-{int(m.group(7)):02d}-{int(m.group(8)):02d}')
assert len(mw)==47, len(mw)
for n,v in mw.items(): assert v['y2026']-v['y2025']==v['up'], n
wb=openpyxl.load_workbook(cpi_x, read_only=True, data_only=True); ws=wb.worksheets[0]
cpi={}
for row in ws.iter_rows(values_only=True):
    r=list(row)
    if len(r)>14 and isinstance(r[9],str) and re.fullmatch(r'\d{2}000',r[9].strip()) and r[9].strip()!='00000':
        cpi[r[9].strip()[:2]]=dict(total=float(r[12]), food=float(r[14]))
assert len(cpi)==47, len(cpi)
wb=openpyxl.load_workbook(inc_x, read_only=True, data_only=True); ws=wb.worksheets[0]
inc={}
for row in ws.iter_rows(values_only=True):
    r=[c for c in row if c is not None]
    if len(r)>=15 and isinstance(r[0],str) and re.fullmatch(r'\d{2}',r[0]): inc[r[0]]=int(r[14])
assert len(inc)==47, len(inc)
lines=[]
for i,n in enumerate(names):
    code=f'{i+1:02d}'; v=mw[n]; c=cpi[code]
    lines.append(f"  '{code}': {{ minWage: {v['y2026']}, minWagePrev: {v['y2025']}, minWageFrom: '{v['eff']}', priceIndex: {c['total']}, foodIndex: {c['food']}, incomePerCapita: {inc[code]*1000} }},")
src=f'''// 都道府県の経済の数字（じろ1 5.5・5.7。docs/JIRO1_PLAN.md）。公的な統計から作った表（手で直さない。直すときは出典の表から作り直す）。
// - 最低賃金: 厚生労働省「令和8年度 地域別最低賃金 答申状況」（2026年9月3日公表）。minWage = 令和8年度の答申された改定額（円/時）、
//   minWagePrev = 改定前（令和7年度）、minWageFrom = 発効日（予定）。全国加重平均 1,177円（改定前 1,121円）
// - 物価: 総務省統計局「小売物価統計調査（構造編）2025年 消費者物価地域差指数」（全国平均 = 100）。priceIndex = 総合、foodIndex = 食料
// - 所得: 内閣府「県民経済計算（平成23年度〜令和5年度）」1人当たり県民所得 令和5年度（2023年度。円）

export interface PrefectureEconomy {{
  /** 地域別最低賃金（令和8年度、円/時） */
  minWage: number;
  /** 改定前の地域別最低賃金（令和7年度、円/時） */
  minWagePrev: number;
  /** 令和8年度の額の発効日（予定） */
  minWageFrom: string;
  /** 消費者物価地域差指数（総合、全国平均 = 100） */
  priceIndex: number;
  /** 消費者物価地域差指数（食料、全国平均 = 100） */
  foodIndex: number;
  /** 1人当たり県民所得（円） */
  incomePerCapita: number;
}}

/** 都道府県のコード（2桁）→ 経済の数字 */
export const PREFECTURE_ECONOMY: Readonly<Record<string, PrefectureEconomy>> = {{
{chr(10).join(lines)}
}};

/** 全国の目安（最低賃金の全国加重平均・1人当たり県民所得の全県計） */
export const NATIONAL_ECONOMY = {{ minWage: 1_177, minWagePrev: 1_121, priceIndex: 100, foodIndex: 100, incomePerCapita: 3_639_000 }} as const;
'''
open(out,'w',encoding='utf-8').write(src)
print('ok', len(lines))
