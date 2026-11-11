// 出店の地図の候補地の見込み（じろ2: 改修設計書03 §5）。想定客数・予想売上・予想利益・投資回収・競合・過密の注意と、
// 「見込みと実際は違う」の注意。ひとりの経営と共通市場で同じ書き方にする
import { FORECAST_DISCLAIMER, siteForecast, type GameState } from '@jiro/core';
import { yenStr } from './dom';

export function forecastLines(s: GameState, code: string, propertyId: string, others: { location: string; propertyId: string }[] = [], includeOwn = true): string[] {
  const f = siteForecast(s, code, propertyId, others, includeOwn);
  const lines = [
    `交通量 ${f.traffic}・競合 同じ場所${f.rivalsSame}店／同じ市区町村の別の場所${f.rivalsNear}店`,
    `見込み: 来客 約${f.customers}人/日・売上 約${yenStr(f.sales)}/日・利益 約${f.profit >= 0 ? '' : '−'}${yenStr(Math.abs(f.profit))}/日（家賃 ${yenStr(f.rent)}/日・人件費の目安を引いた額）`,
    `初期投資 ${yenStr(f.initialCost)}・回収 ${f.paybackDays !== null ? `約${f.paybackDays}日` : '見込みでは回収できない'}・仕入れ値 ${Math.round(f.purchaseLevel * 100)}%・地域の物価 ${f.priceIndex.toFixed(1)}・値段の許容度 ×${f.tolerance.toFixed(2)}`,
  ];
  if (f.crowded) lines.push(`⚠ ${f.crowded}`);
  lines.push(`※ ${FORECAST_DISCLAIMER}`);
  return lines;
}
