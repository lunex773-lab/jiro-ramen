// 営業時間の設定（じろ1 5.1）: 店ごとに 開店・閉店の枠（1〜3つ・30分刻み・日をまたいでよい）と定休日の曜日を決める。
// 時間帯ごとの客の多さ（hourDemand）を帯で見せ、営業する時間を色で重ねる。決めた営業時間は次の営業日から使う。
import {
  BALANCE,
  clockText,
  hourDemand,
  hoursProblem,
  lateNightMinutes,
  openMinutesOf,
  SEC_PER_MIN,
  utilitiesBaseOf,
  WEEKDAY_LABEL,
  type StoreHours,
} from '@jiro/core';
import { h, replace, yenStr } from './dom';

const STEP = () => BALANCE.hours.stepMin;

/** 営業時間の短い説明（「11:00〜15:00・17:30〜翌1:00／定休日 月・火」） */
export function hoursSummary(hrs: StoreHours): string {
  const spans = hrs.sessions.map((x) => `${clockText(x.open)}〜${clockText(x.close)}`).join('・');
  const off = hrs.closedDays.length > 0 ? `／定休日 ${hrs.closedDays.map((d) => WEEKDAY_LABEL[d]).join('・')}` : '／定休日なし';
  return spans + off;
}

/** ゲームの1時間が×1で実時間どれくらいか（「2分15秒」） */
function realTimeOfHour(): string {
  const sec = Math.round(60 * SEC_PER_MIN);
  return `${Math.floor(sec / 60)}分${sec % 60 ? `${sec % 60}秒` : ''}`;
}

const hoursText = (min: number) => `${Math.floor(min / 60)}時間${min % 60 ? `${min % 60}分` : ''}`;

/** その時刻（分。24時を超えてよい）に営業しているか */
function isOpenAt(hrs: StoreHours, min: number): boolean {
  return hrs.sessions.some((x) => (min >= x.open && min < x.close) || (min + 1440 >= x.open && min + 1440 < x.close));
}

/** 時間帯ごとの客の多さの帯（6時〜翌5時。営業する時間は黄色） */
function demandStrip(hrs: StoreHours): HTMLElement {
  const cols: HTMLElement[] = [];
  const max = Math.max(...Array.from({ length: 24 }, (_, i) => hourDemand(i * 60 + 30)));
  for (let i = 0; i < 24; i++) {
    const hour = (6 + i) % 24;
    const min = hour * 60;
    const open = isOpenAt(hrs, min) || isOpenAt(hrs, min + 30);
    const height = Math.round((hourDemand(min + 30) / max) * 100);
    cols.push(
      h(
        'div',
        { class: `demand-col${open ? ' on' : ''}`, title: `${hour}時台` },
        h('div', { class: 'demand-bar', style: { height: `${height}%` } }),
        i % 3 === 0 ? h('span', { class: 'demand-hour' }, String(hour)) : null,
      ),
    );
  }
  return h('div', { class: 'demand-strip', 'aria-label': '時間帯ごとの客の多さ' }, cols);
}

/**
 * 営業時間を決めるダイアログ。保存なら新しい営業時間、やめたら null を返す（背景を押しても閉じない）
 */
export function hoursDialog(root: HTMLElement, title: string, current: StoreHours): Promise<StoreHours | null> {
  const draft: StoreHours = { sessions: current.sessions.map((x) => ({ ...x })), closedDays: [...current.closedDays] };
  const L = BALANCE.hours;
  return new Promise((resolve) => {
    const close = (v: StoreHours | null) => {
      overlay.remove();
      resolve(v);
    };
    const body = h('div', { class: 'hours-dlg' });
    const save = h('button', { class: 'btn primary', 'data-hours-save': '1', onclick: () => !hoursProblem(draft) && close(draft) }, '保存する');
    const opt = (v: number, label: string, sel: number) => h('option', { value: String(v), selected: v === sel }, label);
    const render = () => {
      const problem = hoursProblem(draft);
      save.disabled = !!problem;
      const rows = draft.sessions.map((x, i) => {
        const prevClose = i > 0 ? draft.sessions[i - 1]!.close : -Infinity;
        const firstOpen = Math.max(0, Math.ceil((prevClose + L.minBreakMin) / STEP()) * STEP());
        const opens: HTMLElement[] = [];
        for (let m = Number.isFinite(firstOpen) ? firstOpen : 0; m < 1440; m += STEP()) opens.push(opt(m, clockText(m), x.open));
        if (!opens.length) opens.push(opt(x.open, clockText(x.open), x.open));
        const closes: HTMLElement[] = [];
        for (let m = x.open + L.minSessionMin; m <= x.open + L.maxOpenMin; m += STEP()) closes.push(opt(m, clockText(m), x.close));
        return h(
          'div',
          { class: 'hours-row', 'data-session': String(i) },
          h('span', { class: 'hours-label' }, `営業${draft.sessions.length > 1 ? i + 1 : ''}`),
          h(
            'select',
            {
              class: 'select',
              'data-open': String(i),
              onchange: (e: Event) => {
                const v = Number((e.target as HTMLSelectElement).value);
                const len = x.close - x.open;
                x.open = v;
                x.close = v + Math.max(L.minSessionMin, Math.min(len, L.maxOpenMin));
                render();
              },
            },
            opens,
          ),
          h('span', null, '〜'),
          h(
            'select',
            {
              class: 'select',
              'data-close': String(i),
              onchange: (e: Event) => {
                x.close = Number((e.target as HTMLSelectElement).value);
                render();
              },
            },
            closes,
          ),
          draft.sessions.length > 1
            ? h(
                'button',
                {
                  class: 'mini ghost',
                  'data-remove-session': String(i),
                  onclick: () => {
                    draft.sessions.splice(i, 1);
                    render();
                  },
                },
                '✕',
              )
            : null,
        );
      });
      const last = draft.sessions[draft.sessions.length - 1]!;
      const nextOpen = Math.ceil((last.close + 60) / STEP()) * STEP();
      const canAdd = draft.sessions.length < L.maxSessions && nextOpen < 1440;
      const openMin = openMinutesOf(draft);
      const late = lateNightMinutes(draft);
      replace(
        body,
        h(
          'div',
          null,
          h('p', { class: 'note' }, '昼と夜に分けるなど、営業の枠は3つまで決められます（30分刻み・日をまたいでもよい）。枠と枠の間は仕込みの時間で、「開店する」で次の枠を始めます。'),
          ...rows,
          h(
            'button',
            {
              class: 'mini',
              'data-add-session': '1',
              disabled: !canAdd,
              onclick: () => {
                draft.sessions.push({ open: nextOpen, close: Math.min(nextOpen + 180, nextOpen + L.maxOpenMin) });
                render();
              },
            },
            '＋ 営業の枠を足す',
          ),
          h('h5', null, '時間帯ごとの客の多さ（黄色 = 営業する時間）'),
          demandStrip(draft),
          h('h5', null, '定休日'),
          h(
            'div',
            { class: 'row wrap' },
            WEEKDAY_LABEL.map((label, d) =>
              h(
                'button',
                {
                  class: `chip${draft.closedDays.includes(d) ? ' on' : ''}`,
                  'data-closed-day': String(d),
                  onclick: () => {
                    draft.closedDays = draft.closedDays.includes(d) ? draft.closedDays.filter((x) => x !== d) : [...draft.closedDays, d].sort((a, b) => a - b);
                    render();
                  },
                },
                label,
              ),
            ),
          ),
          h(
            'div',
            { class: 'hours-sum' },
            h('div', { class: 'kv' }, h('span', null, '1日の営業'), h('b', null, `${hoursText(openMin)}${late > 0 ? `（うち深夜 ${hoursText(late)}）` : ''}`)),
            h('div', { class: 'kv' }, h('span', null, '光熱費の基本（1日）'), h('b', null, yenStr(utilitiesBaseOf(draft, true)))),
          ),
          problem ? h('p', { class: 'note bad', 'data-hours-problem': '1' }, problem) : null,
          h(
            'p',
            { class: 'note' },
            `決めた営業時間は次の営業日から使います。長く開けるほど客は増えますが、光熱費と給料もかかります（1日8時間を超えた分と深夜22時〜翌5時は25%増し）。時間の進み方は今までと同じです（ゲームの1時間 = ×1で${realTimeOfHour()}）。`,
          ),
        ),
      );
    };
    const overlay = h(
      'div',
      { class: 'modal-overlay' },
      h('div', { class: 'modal hours-modal' }, h('h3', null, title), h('div', { class: 'modal-body' }, body), h('div', { class: 'row end' }, h('button', { class: 'btn ghost', onclick: () => close(null) }, 'やめる'), save)),
    );
    render();
    root.appendChild(overlay);
  });
}
