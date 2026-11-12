// 銀行の融資（じろ2: 改修設計書04。オーナーの判断「額を選べる・返済能力で上限」）。
// 5万円刻みで額を選び、借入の残りの合計は50万円と返済能力（直近7日の営業利益の平均 × 30日分。最低20万円）の小さいほうまで
import { BALANCE, loanLimit, type GameState } from '@jiro/core';
import { confirmDialog, h, yenStr } from './dom';
import { meterBar } from './kit';

/** 融資の欄（借りられる額の選択と「借りる」。借りられなければ理由） */
export function loanControl(root: HTMLElement, s: GameState, take: (amount: number) => Promise<unknown> | void): HTMLElement {
  const L = BALANCE.loan;
  const lim = loanLimit(s);
  const info = `借入の残り ${yenStr(lim.outstanding)}／上限 ${yenStr(lim.cap)}（返済能力 ${yenStr(lim.capacity)}・最大 ${yenStr(L.maxTotal)}）`;
  if (lim.reason) return h('div', { class: 'loan-control', 'data-loan': 'blocked' }, h('p', { class: 'note' }, `🏦 ${info}`), h('p', { class: 'note warn' }, lim.reason, '（毎日の返済で残りが減るか、営業利益が増えると、また借りられます）'));
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
            const dailyNow = s.loans.reduce((a, l) => a + Math.min(l.remaining, l.dailyPayment), 0);
            // 変える前と後を見せる（じろ6）
            const ok = await confirmDialog(
              root,
              '銀行の融資',
              `${yenStr(amt)}を借ります。日利${(L.dailyRate * 100).toFixed(1)}%、${L.days}日で毎日 ${yenStr(daily)}＋利息を返します。\n` +
                `現金: ${yenStr(s.money)} → ${yenStr(s.money + amt)}\n` +
                `返済の残り: ${yenStr(lim.outstanding)} → ${yenStr(lim.outstanding + amt)}（上限 ${yenStr(lim.cap)}）\n` +
                `毎日の返済（元金）: ${yenStr(dailyNow)} → ${yenStr(dailyNow + daily)}`,
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

/**
 * 借入の内訳（じろ6: 改修設計書06「借入総額と返済残額」）。借りた額の合計（借入の総額）と、まだ返していない額（返済の残り）を分けて出し、
 * 1件ごとに返した割合の棒を付ける
 */
export function loanSummary(s: GameState): HTMLElement {
  const borrowed = s.loans.reduce((a, l) => a + l.principal, 0);
  const remaining = s.loans.reduce((a, l) => a + l.remaining, 0);
  const daily = s.loans.reduce((a, l) => a + Math.min(l.remaining, l.dailyPayment), 0);
  const arrears = s.arrears.reduce((a, b) => a + b.amount, 0);
  const cell = (label: string, value: string, cls = '') => h('div', { class: `loan-cell ${cls}` }, h('small', null, label), h('b', null, value));
  return h(
    'div',
    { class: 'loan-summary', 'data-loan-summary': '' },
    h(
      'div',
      { class: 'loan-cells' },
      cell('借入の総額（借りた額）', yenStr(borrowed)),
      cell('返済の残り', yenStr(remaining), remaining > 0 ? 'warn' : ''),
      cell('返し終えた額', yenStr(borrowed - remaining), 'good'),
      cell('毎日の返済（元金）', yenStr(daily)),
      arrears > 0 ? cell('未払金', yenStr(arrears), 'bad') : null,
    ),
    s.loans.length === 0
      ? h('p', { class: 'note' }, '借入はありません')
      : s.loans.map((l) =>
          h(
            'div',
            { class: 'loan-row', 'data-loan-id': l.id },
            h('span', null, `${l.takenDay}日目に ${yenStr(l.principal)}`),
            meterBar(1 - l.remaining / Math.max(1, l.principal), 'good', `返した割合 ${Math.round((1 - l.remaining / Math.max(1, l.principal)) * 100)}%`),
            h('b', null, `残り ${yenStr(l.remaining)}`),
          ),
        ),
  );
}
