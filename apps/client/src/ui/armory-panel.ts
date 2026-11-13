// 武器の棚（隠し扉の武器庫。じろ2: 改修設計書05。オーナーの判断「案の2倍の値段」→ 2026-11-13 に半額）。
// 武器の種類が多く、操作のボタン（5つまで）に入りきらないため、棚を見ると一覧を開く。
// 武器ごとに「持つ・買う・弾を買う」。買うのは高い買い物なので確かめてから。一度買った武器は武器庫に残り、弾と爆弾は使うとなくなる
import { ARMORY_RACK_ID, listVerbs, WEAPON_IDS, WEAPONS, type GameState, type VerbInfo } from '@jiro/core';
import { confirmDialog, h, replace, toast, yenStr } from './dom';

export interface ArmoryHost {
  readonly state: GameState;
  act(a: { type: 'interact'; targetId: string; verb: string }): Promise<{ ok: boolean; reason?: string }>;
}

export function openArmoryPanel(root: HTMLElement, host: ArmoryHost, meId: string): void {
  const list = h('div', { class: 'armory-list' });
  const money = h('p', { class: 'note' });
  const close = () => overlay.remove();
  const overlay = h(
    'div',
    { class: 'modal-overlay', 'data-armory-panel': '' },
    h(
      'div',
      { class: 'modal armory-panel' },
      h('div', { class: 'armory-head' }, h('h3', null, '武器の棚'), money, h('button', { class: 'btn ghost', 'data-armory-close': '', onclick: close }, '閉じる')),
      list,
      h('p', { class: 'note' }, '買った武器は武器庫に残る。弾と爆弾は使うとなくなる。'),
    ),
  );
  const run = async (v: VerbInfo, confirmText: string | null) => {
    if (confirmText && !(await confirmDialog(root, '武器庫で買う', confirmText, '買う', true))) return;
    const r = await host.act({ type: 'interact', targetId: ARMORY_RACK_ID, verb: v.verb });
    if (!r.ok && r.reason) toast(root, r.reason, 'warn', 1800);
    // 持ったら棚を閉じる（すぐ使える）
    if (r.ok && v.verb.startsWith('weapon:')) close();
    else render();
  };
  const render = () => {
    const s = host.state;
    money.textContent = `お金 ${yenStr(s.money)}`;
    const verbs = listVerbs(s, meId, ARMORY_RACK_ID);
    const by = (verb: string) => verbs.find((v) => v.verb === verb);
    replace(
      list,
      WEAPON_IDS.map((id) => {
        const w = WEAPONS[id]!;
        const take = by(`weapon:${id}`);
        const buy = by(`buy_weapon:${id}`);
        const ammo = by(`buy_ammo:${id}`);
        const btn = (v: VerbInfo | undefined, text: string, cls: string, confirmText: string | null) =>
          // 押せない理由は押したとき（title）に出す
          v ? h('button', { class: `mini ${cls}`, disabled: !v.enabled, title: v.enabled ? v.label : `${v.label}: ${v.reason ?? ''}`, 'data-armory-verb': v.verb, onclick: () => void run(v, confirmText) }, text) : null;
        const status = id === 'bomb' ? `武器庫に ${s.armory?.bombStock ?? 0}個` : take ? (w.kind === 'gun' ? `持っている・弾 ${s.armory?.ammo?.[id] ?? 0}発` : '持っている') : yenStr(w.price);
        return h(
          'div',
          { class: 'armory-row', 'data-armory-weapon': id },
          h('b', null, w.name),
          h('small', null, status),
          h(
            'div',
            { class: 'armory-btns' },
            btn(take, '持つ', '', null),
            btn(buy, `買う ${yenStr(w.price)}`, 'danger', `${w.name}${w.consumable ? 'を1個' : 'を'}${yenStr(w.price)}で買います。${w.consumable ? '投げるとなくなります。' : '一度買うと武器庫に残ります。'}`),
            btn(ammo, `弾 ${yenStr(w.ammoPrice ?? 0)}`, 'danger', `${w.name}の弾を1発 ${yenStr(w.ammoPrice ?? 0)}で買います。撃つと減ります。`),
          ),
        );
      }),
    );
  };
  render();
  root.appendChild(overlay);
}
