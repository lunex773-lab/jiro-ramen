// 企業間の貸し借りの欄（じろ2: 改修設計書04。オーナーの判断「自動で返す形」）。
// 貸す: 相手（プレイヤーの会社）・金額・返す日数・日利（0 = 無利子）を決めて申し込む。借りる: 届いた申し込みを承認する・断る。
// 契約ごとに状態・残り・期限と、申し込みから返済までの記録を出す（貸し手・借り手の両方に見える）
import { BALANCE, creditOwed, type CompanyCredit, type CreditOp, type CreditStatus, type MarketView } from '@jiro/core';
import { confirmDialog, h, yenStr } from './dom';
import { cardHead } from './kit';

const STATUS_LABEL: Record<CreditStatus, string> = {
  offered: '返事待ち',
  approved: '承認済み（貸し手の営業が終わったらお金が動く）',
  active: '返している最中',
  overdue: '延滞',
  defaulted: '債務不履行',
  repaid: '返し終わった',
  declined: '断られた',
  cancelled: '取り消し',
  expired: '期限切れ',
  failed: '貸し手のお金が足りず中止',
  writtenOff: '返せるだけ返して終わり',
};

const rateText = (r: number) => (r === 0 ? '無利子' : `日利${(r * 100).toFixed(1)}%`);

export interface CreditHandlers {
  op: (op: CreditOp, okMsg: string) => Promise<void>;
}

/** 企業間の貸し借りの欄 */
export function creditCard(root: HTMLElement, v: MarketView, handlers: CreditHandlers): HTMLElement | null {
  const mine = v.mine;
  if (!mine) return null;
  const C = BALANCE.market.credit;
  const me = mine.companyId;
  const money = mine.state.money;
  const blocked = mine.state.creditBlocked ?? null;
  const targets = v.companies.filter((c) => c.kind === 'player' && c.status === 'active' && !c.mine);
  const list = mine.credits ?? [];
  const book = mine.state.companyCredit;
  // 貸す（申し込む）
  const who = h('select', { class: 'select', 'data-credit-to': '' }, targets.map((c) => h('option', { value: c.id, disabled: !!c.defaulted }, `${c.name}${c.defaulted ? '（債務不履行）' : ''}`))) as HTMLSelectElement;
  const amounts = [10_000, 30_000, 50_000, 100_000, 200_000, 300_000, 500_000, 1_000_000, 2_000_000, 5_000_000].filter((a) => a <= Math.min(C.maxAmount, money));
  const amount = h('select', { class: 'select', 'data-credit-amount': '' }, amounts.map((a) => h('option', { value: String(a) }, yenStr(a)))) as HTMLSelectElement;
  const days = h('select', { class: 'select', 'data-credit-days': '' }, [3, 7, 14, 30, 60].filter((d) => d >= C.minDays && d <= C.maxDays).map((d) => h('option', { value: String(d), selected: d === 7 }, `${d}日`))) as HTMLSelectElement;
  const rates: number[] = [];
  for (let r = 0; r <= C.maxDailyRate + 1e-9; r += C.rateStep) rates.push(Math.round(r * 1000) / 1000);
  const rate = h('select', { class: 'select', 'data-credit-rate': '' }, rates.map((r) => h('option', { value: String(r), selected: r === 0.004 }, rateText(r)))) as HTMLSelectElement;
  const canOffer = !v.ended && targets.length > 0 && amounts.length > 0;
  const offerForm = h(
    'div',
    { class: 'credit-offer' },
    h('div', { class: 'kv' }, h('span', null, '貸す相手'), targets.length > 0 ? who : h('b', null, 'ほかのプレイヤーの会社がいません')),
    h('div', { class: 'kv' }, h('span', null, '金額'), amounts.length > 0 ? amount : h('b', null, 'お金が足りません')),
    h('div', { class: 'kv' }, h('span', null, '返す日数'), days),
    h('div', { class: 'kv' }, h('span', null, '利率'), rate),
    h(
      'button',
      {
        class: 'btn',
        'data-credit-offer': '',
        disabled: !canOffer,
        onclick: async () => {
          const to = targets.find((c) => c.id === who.value);
          if (!to) return;
          const amt = Number(amount.value);
          const d = Number(days.value);
          const r = Number(rate.value);
          const interest = Math.round(amt * r) * d;
          const ok = await confirmDialog(
            root,
            '貸し出しを申し込む',
            `${to.name}に ${yenStr(amt)} を貸す申し込みをします（${d}日・${rateText(r)}。期限までの利息 約${yenStr(interest)}）。\n相手が承認するとお金が動きます。期限の日に相手の現金から自動で返してもらい、足りなければ延滞（利息を上乗せして毎日回収）。期限から${C.defaultAfterDays}日で債務不履行。相手が市場を抜けた・破産したときは、返せなかった分はあなたの損です。`,
            '申し込む',
          );
          if (ok) await handlers.op({ op: 'offer', borrowerId: to.id, amount: amt, days: d, dailyRate: r }, '申し込みました（相手の返事を待っています）');
        },
      },
      '貸し出しを申し込む',
    ),
  );
  const row = (cr: CompanyCredit) => {
    const lending = cr.lenderId === me;
    const other = lending ? cr.borrowerName : cr.lenderName;
    const open = cr.status === 'active' || cr.status === 'overdue' || cr.status === 'defaulted';
    const owed = creditOwed(cr);
    const actions: HTMLElement[] = [];
    if (cr.status === 'offered' && !lending) {
      actions.push(
        h(
          'button',
          {
            class: 'mini',
            'data-credit-accept': cr.id,
            disabled: !!blocked,
            onclick: async () => {
              const ok = await confirmDialog(
                root,
                '借りる',
                `${cr.lenderName}から ${yenStr(cr.principal)} を借ります（${cr.days}日・${rateText(cr.dailyRate)}）。\n期限の日にあなたの現金から自動で返します。足りなければ延滞（利息に日${(C.overdueRate * 100).toFixed(1)}%を上乗せし、毎日自動で回収）、期限から${C.defaultAfterDays}日で債務不履行（新しく借りられない・評判が下がる）。前倒しでいつでも全部返せます。`,
                '承認して借りる',
              );
              if (ok) await handlers.op({ op: 'accept', creditId: cr.id }, '承認しました');
            },
          },
          '承認する',
        ),
        h('button', { class: 'mini ghost', 'data-credit-decline': cr.id, onclick: () => void handlers.op({ op: 'decline', creditId: cr.id }, '断りました') }, '断る'),
      );
    }
    if (cr.status === 'offered' && lending) actions.push(h('button', { class: 'mini ghost', 'data-credit-cancel': cr.id, onclick: () => void handlers.op({ op: 'cancel', creditId: cr.id }, '取り消しました') }, '取り消す'));
    if (open && !lending)
      actions.push(
        h(
          'button',
          {
            class: 'mini',
            'data-credit-repay': cr.id,
            disabled: money < owed,
            onclick: async () => {
              if (await confirmDialog(root, '前倒しで返す', `${cr.lenderName}に ${yenStr(owed)}（元本 ${yenStr(cr.remaining)}＋今日までの利息 ${yenStr(cr.interestDue)}）を返します。`, '全部返す')) {
                await handlers.op({ op: 'repay', creditId: cr.id }, '返し終わりました');
              }
            },
          },
          `前倒しで全部返す（${yenStr(owed)}）`,
        ),
      );
    const tone = cr.status === 'defaulted' || cr.status === 'writtenOff' ? 'bad' : cr.status === 'overdue' ? 'warn' : cr.status === 'repaid' ? 'good' : '';
    return h(
      'details',
      { class: `credit-row ${tone}`, 'data-credit': cr.id, 'data-credit-status': cr.status },
      h(
        'summary',
        null,
        h('b', null, `${lending ? '貸し' : '借り'}: ${other}`),
        ` ${yenStr(cr.principal)}・${cr.days}日・${rateText(cr.dailyRate)}`,
        h('span', { class: `chip ${tone}` }, STATUS_LABEL[cr.status]),
        open ? h('small', null, `残り ${yenStr(owed)}（期限 市場の${cr.dueDay}日目）`) : cr.lost > 0 ? h('small', null, `返せなかった分 ${yenStr(cr.lost)}`) : null,
      ),
      actions.length > 0 ? h('div', { class: 'row' }, ...actions) : null,
      h(
        'ul',
        { class: 'credit-events' },
        cr.events
          .slice()
          .reverse()
          .map((e) => h('li', null, `${new Date(e.at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}（市場の${e.day}日目） ${e.text}`)),
      ),
    );
  };
  return h(
    'section',
    { class: 'card market-credit', 'data-market-credit': '' },
    cardHead(
      '企業間の貸し借り',
      `ほかのプレイヤーの会社にお金を貸せます（相手の承認でお金が動く）。日数は市場の日付（全社がそろった日付）で数え、利息は0時の同期で足します。期限の日に借り手の現金から自動で返し、足りなければ延滞（利息に日${(C.overdueRate * 100).toFixed(1)}%を上乗せし毎日回収）、期限から${C.defaultAfterDays}日で債務不履行（新しく借りられない・評判 −${C.defaultReputation}）。借り手はいつでも前倒しで全部返せます（利息はその日まで）。借り手が抜けた・破産した・市場が終わったときは、返せるだけ返して残りは貸し手の損。`,
    ),
    book ? h('p', { class: 'note', 'data-credit-book': '' }, `借りている ${yenStr(book.owed)}・貸している ${yenStr(book.lent)}（企業価値では、貸しているお金は資産・借りているお金は負債）`) : null,
    blocked ? h('p', { class: 'note bad' }, blocked) : null,
    offerForm,
    list.length === 0 ? h('p', { class: 'note' }, 'まだ契約はありません') : h('div', { class: 'credit-list' }, list.map(row)),
  );
}
