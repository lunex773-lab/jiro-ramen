// タイトル・セーブスロット・営業終了結果・破産・遊び方・設定の画面（設計書 19.1）。

import {
  BALANCE,
  callToSpoken,
  fixedCosts,
  MENU,
  STAGES,
  type DayReport,
  type GameState,
  type SlotInfo,
} from '@jiro/core';
import type { Settings } from '../game/settings';
import { confirmDialog, h, promptDialog, stars, yenStr } from './dom';

export const GAME_TITLE = '次郎系ラーメン屋 経営シミュレーター';

function screen(cls: string, ...children: (HTMLElement | null)[]): HTMLElement {
  const el = h('div', { class: `screen ${cls}` }, h('div', { class: 'screen-inner' }, ...children));
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  return el;
}

export interface TitleCallbacks {
  onSingle(): void;
  /** チュートリアル（営業0日目の練習）だけを遊ぶ。セーブはしない */
  onTutorial(): void;
  onMulti(): void;
  onHelp(): void;
  onSettings(): void;
}

export function titleScreen(cb: TitleCallbacks, version: string): HTMLElement {
  return screen(
    'title',
    h(
      'div',
      { class: 'logo' },
      h('div', { class: 'logo-sign' }, 'ラーメン'),
      h('div', { class: 'logo-title' }, GAME_TITLE),
      h('div', { class: 'logo-sub' }, 'ヤサイ・ニンニク・アブラ・カラメ — 一杯ずつ、店を大きくしよう'),
    ),
    h(
      'div',
      { class: 'menu-col' },
      h('button', { class: 'btn big primary', onclick: () => cb.onSingle() }, '🍜 ひとりで経営する'),
      h('button', { class: 'btn', onclick: () => cb.onTutorial() }, '📘 チュートリアル（営業0日目の練習）'),
      h('button', { class: 'btn big', onclick: () => cb.onMulti() }, '👥 オンライン共同経営（最大4人）'),
      h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: () => cb.onHelp() }, '遊び方'), h('button', { class: 'btn ghost', onclick: () => cb.onSettings() }, '設定')),
    ),
    h('div', { class: 'foot' }, `v${version} ・ 店名・人物はすべて架空です`),
  );
}

export interface SlotCallbacks {
  onContinue(slot: number): void;
  onNew(slot: number, shopName: string): void;
  onDelete(slot: number): void;
  onBack(): void;
}

export function slotScreen(root: HTMLElement, slots: SlotInfo[], cb: SlotCallbacks, title = 'セーブスロットを選ぶ'): HTMLElement {
  const fmtDate = (t: number | null) => (t ? new Date(t).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  return screen(
    'slots',
    h('h2', null, title),
    h(
      'div',
      { class: 'slot-list' },
      slots.map((sl) =>
        h(
          'div',
          { class: `slot-card ${sl.empty ? 'empty' : ''} ${sl.corrupted ? 'bad' : ''}` },
          h('div', { class: 'slot-no' }, `スロット${sl.slot}`),
          sl.meta
            ? h(
                'div',
                { class: 'slot-meta' },
                h('div', { class: 'slot-shop' }, `${sl.meta.shopName}${sl.meta.bankrupt ? '（破産）' : ''}`),
                h('div', null, `${sl.meta.day}日目・${yenStr(sl.meta.money)}・${stars(sl.meta.reputation)}・${STAGES[sl.meta.stage]?.name ?? ''}`),
                h('div', { class: 'note' }, `累計${sl.meta.totalServed}杯・保存 ${fmtDate(sl.updatedAt)}`),
              )
            : h('div', { class: 'slot-meta note' }, sl.corrupted ? `データが破損しています（${sl.error ?? ''}）` : '空きスロット'),
          h(
            'div',
            { class: 'row' },
            sl.meta ? h('button', { class: 'btn primary', onclick: () => cb.onContinue(sl.slot) }, '続きから') : null,
            h(
              'button',
              {
                class: `btn ${sl.meta ? 'ghost' : 'primary'}`,
                onclick: async () => {
                  if (!sl.empty) {
                    const ok = await confirmDialog(root, '上書きの確認', `スロット${sl.slot}のデータを消して新しく始めます。元に戻せません。`, '上書きする', true);
                    if (!ok) return;
                  }
                  const name = await promptDialog(root, '店名を決めてください', 'ラーメン まし屋', '例: ラーメン まし屋');
                  if (name) cb.onNew(sl.slot, name);
                },
              },
              '新しく始める',
            ),
            !sl.empty
              ? h(
                  'button',
                  {
                    class: 'btn ghost danger-text',
                    onclick: async () => {
                      const ok = await confirmDialog(root, '削除の確認', `スロット${sl.slot}のデータを削除します。元に戻せません。`, '削除する', true);
                      if (ok) cb.onDelete(sl.slot);
                    },
                  },
                  '削除',
                )
              : null,
          ),
        ),
      ),
    ),
    h('button', { class: 'btn ghost', onclick: () => cb.onBack() }, '← 戻る'),
  );
}

export interface ResultCallbacks {
  onNextDay(): void;
  onManage(): void;
  onSaveTitle(): void;
}

export function resultScreen(s: GameState, r: DayReport, isHost: boolean, cb: ResultCallbacks): HTMLElement {
  const prev = s.history[s.history.length - 2];
  const repDelta = prev ? r.reputation - prev.reputation : r.reputation - BALANCE.reputation.initial;
  const reviews = s.reviews.filter((x) => x.day === r.day).slice(-5);
  const goals = s.notices.filter((n) => n.code.startsWith('goal:') && n.day === r.day);
  const fc = fixedCosts(s);
  const row = (k: string, v: string, cls = '') => h('div', { class: `kv ${cls}` }, h('span', null, k), h('b', null, v));
  return screen(
    'results',
    h('h2', null, `${r.day}日目 営業終了`),
    h(
      'div',
      { class: 'grid2' },
      h(
        'section',
        { class: 'card' },
        h('h4', null, '損益'),
        row('売上', yenStr(r.sales)),
        r.refunds ? row('返金', `−${yenStr(r.refunds)}`) : null,
        row('食材原価', `−${yenStr(r.cogs)}`),
        row('廃棄', `−${yenStr(r.waste)}`, r.waste > 0 ? 'warn' : ''),
        row('人件費', `−${yenStr(r.wages)}`),
        row('家賃', `−${yenStr(r.rent)}`),
        row('維持費・光熱費', `−${yenStr(r.upkeep + r.utilities)}`),
        r.repairs ? row('修理費', `−${yenStr(r.repairs)}`) : null,
        r.hiring ? row('採用・解雇', `−${yenStr(r.hiring)}`) : null,
        r.interest ? row('利息', `−${yenStr(r.interest)}`) : null,
        row('営業利益', yenStr(r.operatingProfit), r.operatingProfit < 0 ? 'bad' : 'good'),
        row('資金', `${yenStr(r.cashStart)} → ${yenStr(r.cashEnd)}`),
      ),
      h(
        'section',
        { class: 'card' },
        h('h4', null, '営業'),
        row('提供数', `${r.served}杯 / 来客 ${r.customers}人`),
        row('途中で帰った客', `${r.lost}人`, r.lost > 0 ? 'warn' : ''),
        row('平均待ち時間', `${r.avgWait.toFixed(0)}秒`),
        row('平均満足度', `${Math.round(r.avgSatisfaction * 100)}%`),
        row('評判', `${stars(r.reputation)} ${r.reputation.toFixed(2)}（${repDelta >= 0 ? '+' : ''}${repDelta.toFixed(2)}）`, repDelta < 0 ? 'bad' : 'good'),
        row('ミス / クレーム / 品切れ', `${r.mistakes} / ${r.complaints} / ${r.stockouts}`),
        row('翌日の固定費（予測）', yenStr(fc.total), s.money < fc.total ? 'bad' : ''),
      ),
      reviews.length > 0
        ? h('section', { class: 'card wide' }, h('h4', null, '今日の口コミ'), reviews.map((x) => h('div', { class: 'review' }, h('b', null, '★'.repeat(Math.max(1, Math.round(x.stars)))), ` ${x.text}`)))
        : null,
      goals.length > 0 ? h('section', { class: 'card wide good' }, h('h4', null, '達成した目標'), goals.map((g) => h('div', null, g.text))) : null,
      s.notices.some((n) => n.code.startsWith('fin:'))
        ? h('section', { class: 'card wide bad' }, h('h4', null, '資金の警告'), s.notices.filter((n) => n.code.startsWith('fin:')).map((n) => h('div', null, n.text)))
        : null,
    ),
    h(
      'div',
      { class: 'row center' },
      h('button', { class: 'btn', onclick: () => cb.onManage() }, '☰ 経営メニュー（発注・採用・設備・拡張）'),
      isHost ? h('button', { class: 'btn big primary', onclick: () => cb.onNextDay() }, '翌日の仕込みへ →') : h('div', { class: 'note' }, 'ホストが翌日に進めるのを待っています'),
      h('button', { class: 'btn ghost', onclick: () => cb.onSaveTitle() }, '保存してタイトルへ'),
    ),
  );
}

export function bankruptScreen(s: GameState, cb: { onTitle(): void; onRetry(): void }): HTMLElement {
  const b = s.bankruptcy;
  const total = s.history.reduce((a, r) => a + r.served, 0);
  return screen(
    'bankrupt',
    h('h2', null, '破産'),
    h('p', { class: 'big-text' }, b?.reason ?? ''),
    h(
      'section',
      { class: 'card' },
      h('div', { class: 'kv' }, h('span', null, '営業日数'), h('b', null, `${s.day}日`)),
      h('div', { class: 'kv' }, h('span', null, '累計提供'), h('b', null, `${total}杯`)),
      h('div', { class: 'kv' }, h('span', null, '残った資金'), h('b', null, yenStr(b?.cash ?? s.money))),
      h('div', { class: 'kv bad' }, h('span', null, '負債'), h('b', null, yenStr(b?.debt ?? 0))),
      h('div', { class: 'kv' }, h('span', null, '最終評判'), h('b', null, `${stars(s.reputation)} ${s.reputation.toFixed(2)}`)),
    ),
    h('p', { class: 'note' }, 'セーブデータは削除されません。スロット画面から確認・削除できます。'),
    h('div', { class: 'row center' }, h('button', { class: 'btn', onclick: () => cb.onTitle() }, 'タイトルへ'), h('button', { class: 'btn primary', onclick: () => cb.onRetry() }, '新しい店で再挑戦')),
  );
}

export function helpScreen(onClose: () => void, isTouch: boolean): HTMLElement {
  const step = (n: number, title: string, body: string) => h('div', { class: 'help-step' }, h('div', { class: 'help-no' }, String(n)), h('div', null, h('b', null, title), h('p', null, body)));
  return screen(
    'help',
    h('h2', null, '遊び方'),
    h(
      'section',
      { class: 'card wide' },
      h('h4', null, '操作'),
      isTouch
        ? h('p', null, 'iPhone を左に倒して（カメラが左）横向きで遊びます。画面の回転ロック中でも横画面で表示します。画面の左側をなぞって移動、右側をなぞって視点を動かします。画面中央の照準を設備や席に合わせると、右下に丸い操作ボタンが出ます（遠いときは「近づいてください」）。縁が点線のボタンは長押しの作業で、周りの輪が一周するまで押し続けてください。')
        : h('p', null, 'WASD/矢印キーで移動、画面をクリックするとマウスで視点操作。画面中央の照準を設備や席に合わせ、E（または左クリック）で右下の一番大きい丸ボタンの操作、1〜6キーで他の操作。長押しの作業はキーを押し続けます。Q=中断、Tab=経営メニュー。'),
    ),
    h(
      'section',
      { class: 'card wide' },
      h('h4', null, 'ラーメンができるまで（ロットで作る）'),
      step(1, '丼を並べる', '丼棚で「きれいな丼を取る」→ 盛り付け台で「丼を並べる」。丼は食券（注文）の順に割り当てられます。'),
      step(2, 'タレ・スープ', '盛り付け台で「タレを入れる」「スープを注ぐ」。スープ寸胴が近いほど早く注げます。'),
      step(3, '麺をゆでる', `麺釜で「麺を入れる」。極太麺は約${BALANCE.cooking.noodleIdeal}秒が食べ頃。ゆで時間は麺釜を見ると表示されます。`),
      step(4, 'コールを聞く', '麺がゆで上がる頃、席（カウンター）を見て「ニンニク入れますか？」。お客さんがヤサイ・ニンニク・アブラ・カラメ・唐辛子のコールを言います。'),
      step(5, '麺上げ・トッピング', '麺釜で「麺上げ」→ 盛り付け台で「コールどおりに盛る」。豚とヤサイ・ニンニク・アブラ・唐辛子がコールどおりに盛られます。'),
      step(6, '提供', '盛り付け台で丼を持ち、その席で「提供する」。別の席の丼を出すとミスになります。'),
      step(7, '片付け', '食べ終わった丼を下げて洗い場で洗い、カウンターを拭きます。汚れていると満足度が下がります。'),
    ),
    h(
      'section',
      { class: 'card wide' },
      h('h4', null, '仕込みと経営'),
      h('p', null, '豚・ヤサイ・ニンニク・アブラ・スープは仕込みで作ります（仕込み台・煮込み鍋・野菜ゆで釜・寸胴）。食材は「経営 → 在庫・発注」で仕入れます。閉店後に家賃・給与・維持費を精算し、利益で設備・従業員・店舗拡張に投資します。資金が尽きて支払いが滞り、期限を過ぎて払えないと破産です。'),
      h('p', null, `コールの例: 「${callToSpoken({ yasai: 2, ninniku: 1, abura: 1, karame: 0, ichimi: 1 })}」 メニュー: ${Object.values(MENU).slice(0, 3).map((m) => m.name).join('・')} など`),
    ),
    h('button', { class: 'btn primary', onclick: onClose }, '閉じる'),
  );
}

export function settingsScreen(st: Settings, onChange: (s: Settings) => void, onClose: () => void): HTMLElement {
  const cur = { ...st };
  const update = () => onChange({ ...cur });
  const toggle = (label: string, key: 'sound' | 'voice' | 'invertY') =>
    h(
      'label',
      { class: 'kv' },
      h('span', null, label),
      h('input', {
        type: 'checkbox',
        checked: cur[key],
        onchange: (e: Event) => {
          cur[key] = (e.target as HTMLInputElement).checked;
          update();
        },
      }),
    );
  return screen(
    'settings',
    h('h2', null, '設定'),
    h(
      'section',
      { class: 'card wide' },
      toggle('効果音', 'sound'),
      h(
        'label',
        { class: 'kv' },
        h('span', null, '音量'),
        h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(cur.volume), oninput: (e: Event) => { cur.volume = Number((e.target as HTMLInputElement).value); update(); } }),
      ),
      toggle('コールの読み上げ（音声合成）', 'voice'),
      h(
        'label',
        { class: 'kv' },
        h('span', null, '視点の感度'),
        h('input', { type: 'range', min: '0.3', max: '2.5', step: '0.1', value: String(cur.lookSensitivity), oninput: (e: Event) => { cur.lookSensitivity = Number((e.target as HTMLInputElement).value); update(); } }),
      ),
      toggle('上下の視点操作を反転', 'invertY'),
      h(
        'label',
        { class: 'kv' },
        h('span', null, '画質'),
        h(
          'select',
          { class: 'select', onchange: (e: Event) => { cur.quality = (e.target as HTMLSelectElement).value as Settings['quality']; update(); } },
          (['low', 'medium', 'high'] as const).map((q) => h('option', { value: q, selected: cur.quality === q }, q === 'low' ? '低（省電力）' : q === 'medium' ? '中' : '高')),
        ),
      ),
      h(
        'label',
        { class: 'kv' },
        h('span', null, 'プレイヤー名'),
        h('input', { class: 'input', value: cur.playerName, maxLength: 12, onchange: (e: Event) => { cur.playerName = (e.target as HTMLInputElement).value.trim() || '店主'; update(); } }),
      ),
    ),
    h('button', { class: 'btn primary', onclick: onClose }, '閉じる'),
  );
}
