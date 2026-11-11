// 銀行の融資（じろ2: 改修設計書04。オーナーの判断「額を選べる・返済能力で上限」）。
// 5万円刻みで額を選び、借入の残りの合計は50万円と返済能力（直近7日の営業利益の平均 × 30日分。最低20万円）の小さいほうまで
import { BALANCE, loanLimit, type GameState } from '@jiro/core';
import { confirmDialog, h, yenStr } from './dom';

/** 融資の欄（借りられる額の選択と「借りる」。借りられなければ理由） */
export function loanControl(root: HTMLElement, s: GameState, take: (amount: number) => Promise<unknown> | void): HTMLElement {
  const L = BALANCE.loan;
  const lim = loanLimit(s);
  const info = `借入の残り ${yenStr(lim.outstanding)}／上限 ${yenStr(lim.cap)}（返済能力 ${yenStr(lim.capacity)}・最大 ${yenStr(L.maxTotal)}）`;
  if (lim.reason) return h('div', { class: 'loan-control', 'data-loan': 'blocked' }, h('p', { class: 'note' }, `🏦 ${info}`), h('p', { class: 'note warn' }, lim.reason));
  const amounts: number[] = [];
  for (let a = L.step; a <= lim.max; a += L.step) amounts.push(a);
  const sel = h(
    'select',
    { class: 'select', 'data-loan-amount': '' },
    amounts.map((a) => h('option', { value: String(a), selected: a === Math.min(L.amount, lim.max) }, yenStr(a))),
  ) as HTMLSelectElement;
  return h(
    'div',
    { class: 'loan-control', 'data-loan': 'open' },
    h('p', { class: 'note' }, `🏦 ${info}`),
    h(
      'div',
      { class: 'row' },
      sel,
      h(
        'button',
        {
          class: 'mini ghost',
          'data-take-loan': '',
          onclick: async () => {
            const amt = Number(sel.value);
            const daily = Math.ceil(amt / L.days);
            const ok = await confirmDialog(
              root,
              '銀行の融資',
              `${yenStr(amt)}を借ります。日利${(L.dailyRate * 100).toFixed(1)}%、${L.days}日で毎日 ${yenStr(daily)}＋利息を返します。\n借入の残りの合計は ${yenStr(lim.cap)} まで（今 ${yenStr(lim.outstanding)}）。`,
              '借りる',
            );
            if (ok) await take(amt);
          },
        },
        '融資を受ける',
      ),
    ),
  );
}
