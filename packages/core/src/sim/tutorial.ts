// チュートリアル: 営業0日目（練習の日）と、3日目に受けるかを選べる「従業員」の回。
// 手順ごとに「何をするか」「どこを見るか」「何をしたら次へ進むか」を決め、プレイヤーの操作で状態が変わったら次へ進める。
// 状態（GameState.tutorial）には手順の番号と基準値だけを持ち、文言や判定はここに置く（セーブを小さく保つため）。

import { STAGES } from '../data/stages';
import { EQUIPMENT, type EquipmentRole } from '../data/equipment';
import { DEFAULT_CALL } from '../data/menu';
import type { Bowl, CallLevels, Customer, Employee, Equipment, GameState, Order, Player, TutorialState } from '../types';
import { dist } from '../util';
import { isBowlComplete } from './cooking';
import { addDirt, makeCustomer } from './customers';
import { startClosing } from './day';
import { refreshCandidates } from './employees';
import { statusFromCondition } from './equipment';
import { bowlForOrder, noodlesStartedFor } from './interact';
import { stockOf } from './inventory';
import { emit, type SimCtx } from './notices';

export type TutorialKind = TutorialState['kind'];

/** 画面側で判定する条件（経営メニューのどのタブを開いているか等） */
export type TutorialUi = 'manage:stock' | 'manage:staff' | 'closedAll';

/** 目印を付ける対象 */
export type TutorialTarget =
  | { kind: 'role'; role: EquipmentRole }
  | { kind: 'seat' }
  | { kind: 'spill' }
  | { kind: 'ui'; id: 'menu' | 'open' | 'close' | 'results' };

export interface TutorialStep {
  id: string;
  title: string;
  text: string;
  target?: TutorialTarget;
  /** 状態から判定する完了条件（満たしたら自動で次へ進む） */
  auto?: (s: GameState, t: TutorialState) => boolean;
  /** 画面側で判定する完了条件（満たしたら画面から「次へ」を送る） */
  ui?: TutorialUi;
  /** 関係する経営メニューのタブ（画面で目立たせる） */
  tab?: 'stock' | 'menu' | 'equip' | 'staff' | 'layout';
  /** 押すと次へ進むボタンの文言（説明だけの手順など） */
  button?: string;
  /** もう一つの選択肢。押すと指定の手順へ飛ぶ */
  alt?: { label: string; goto: string };
  /** 「閉店する」ボタンを出す */
  closeButton?: boolean;
  /** 自分でやってみる手順。画面に「次にやること」の案内も出す */
  showGuide?: boolean;
  /** 手順を始めたときの処理（客を呼ぶ、設備を劣化させる等） */
  enter?: (s: GameState, ctx: SimCtx, t: TutorialState) => void;
  /** この手順を終えたらチュートリアルを終える */
  last?: boolean;
}

// ───────────────────────── 判定の部品 ─────────────────────────

const me = (s: GameState): Player => s.players[0]!;
const str = (t: TutorialState, k: string): string => String(t.mark[k] ?? '');
const num = (t: TutorialState, k: string): number => Number(t.mark[k] ?? 0);

function customer(s: GameState, t: TutorialState, key: string): Customer | undefined {
  return s.customers.find((c) => c.id === str(t, key));
}

function orderOf(s: GameState, t: TutorialState, key = 'cust'): Order | undefined {
  const c = customer(s, t, key);
  return c?.orderId ? s.orders.find((o) => o.id === c.orderId) : undefined;
}

/** 1人目のお客さんの丼（盛り付け中は注文から、提供後は席から、下げた後は記録した ID から探す） */
function bowlOf(s: GameState, t: TutorialState): Bowl | undefined {
  const o = orderOf(s, t);
  const onAsm = o ? bowlForOrder(s, o.id) : undefined;
  if (onAsm) return onAsm;
  const seat = s.seats.find((x) => x.id === str(t, 'seat'));
  const atSeat = seat?.bowlId ? s.bowls.find((b) => b.id === seat.bowlId) : undefined;
  return atSeat ?? s.bowls.find((b) => b.id === str(t, 'bowl'));
}

function equipmentByRole(s: GameState, role: EquipmentRole): Equipment | undefined {
  return s.equipment.find((e) => e.placed && EQUIPMENT[e.type]?.role === role);
}

function staffSignature(s: GameState): string {
  return JSON.stringify(s.employees.map((e: Employee) => [e.id, e.profile.role, e.priorities]));
}

/** チュートリアル用のお客さん（注文と食べる時間が決まっていて、待たせても帰らない） */
function spawnScriptedCustomer(s: GameState, ctx: SimCtx, menuId: string, call: Partial<CallLevels>, eatTime: number): Customer {
  const c = makeCustomer(s, null);
  c.traits = { ...c.traits, patience: 1, complaintPropensity: 0, reviewPropensity: 0, loyaltyPropensity: 0, manners: 1 };
  c.call = { ...DEFAULT_CALL, ...call };
  c.patience = 1e6;
  c.script = { menuId, eatTime };
  s.customers.push(c);
  s.queue.push(c.id);
  s.today.customers += 1;
  emit(ctx, { type: 'arrive', targetId: c.id });
  return c;
}

/** お客さんが座って注文したら、席と注文を記録する */
function rememberSeat(s: GameState, t: TutorialState): void {
  const c = customer(s, t, 'cust');
  if (c?.seatId) t.mark.seat = c.seatId;
}

// ───────────────────────── 営業0日目 ─────────────────────────

const BASICS: TutorialStep[] = [
  {
    id: 'welcome',
    title: 'ようこそ！',
    text: '今日は営業0日目、練習の日です。ラーメンの作り方と店の経営を、1つずつ体験しましょう。売上や評判は本番に残りません。',
    button: 'はじめる',
  },
  {
    id: 'move',
    title: '移動と視点',
    text: '画面の左側をなぞると移動、右側をなぞると向きが変わります（PC は WASD とマウス）。少し歩いてみよう。',
    enter: (s, _ctx, t) => {
      t.mark.px = me(s).pos.x;
      t.mark.pz = me(s).pos.z;
    },
    auto: (s, t) => dist(me(s).pos, { x: num(t, 'px'), z: num(t, 'pz') }) > 1.2,
  },
  {
    id: 'prep_pork',
    title: '仕込み: 豚を切る',
    text: '画面中央の照準を目印の「仕込み台」に合わせると、右下に丸い操作ボタンが出ます。「🔪 豚切り」を押し続けよう（縁が点線のボタンは長押し。周りの輪が一周するまで押し続けます）。',
    target: { kind: 'role', role: 'prep' },
    enter: (s, _ctx, t) => {
      t.mark.buta = stockOf(s, 'buta');
    },
    auto: (s, t) => stockOf(s, 'buta') > num(t, 'buta'),
  },
  {
    id: 'stock_open',
    tab: 'stock',
    title: '経営: 在庫と発注',
    text: '右上の「☰ 経営」を押して経営メニューを開き、「在庫・発注」タブを開こう。',
    target: { kind: 'ui', id: 'menu' },
    ui: 'manage:stock',
  },
  {
    id: 'stock_order',
    tab: 'stock',
    title: '経営: 在庫と発注',
    text: '食材の残りと消費期限が見られます。足りない食材は「仕入れ」で発注します。「翌朝便」は翌日の開店前に、「当日便」は3割高で約60秒後に届きます。自動発注の量を決めておくと、閉店後に不足分を頼みます。試しに、どれか1つ仕入れてみよう（冷蔵庫がいっぱいのときは、冷蔵庫に入れない醤油や一味唐辛子なら頼めます）。',
    enter: (s, _ctx, t) => {
      t.mark.purchases = s.today.purchases;
    },
    auto: (s, t) => s.today.purchases > num(t, 'purchases'),
  },
  {
    id: 'price',
    tab: 'menu',
    title: '経営: 値段を決める',
    text: '「メニュー」タブで値段を変えられます。高くすると1杯の利益は増えますが、お客さんは減り、割高だと満足度も下がります。試しにどれか1つ値段を変えてみよう（営業中は変えられません）。',
    enter: (s, _ctx, t) => {
      t.mark.prices = JSON.stringify(s.prices);
    },
    auto: (s, t) => JSON.stringify(s.prices) !== str(t, 'prices'),
  },
  {
    id: 'equip',
    tab: 'equip',
    title: '経営: 設備の手入れ',
    text: '「設備」タブを開くと、券売機が「劣化」しています。劣化・不調のうちに直すと修理費は半額で、壊れると営業に響きます。「修理」を押すか、「自動メンテ」をON（状態が下がった日の閉店後に整備）にしよう。',
    enter: (s, _ctx, t) => {
      const tm = equipmentByRole(s, 'ticket');
      if (!tm) return;
      tm.condition = Math.min(tm.condition, 55);
      tm.status = statusFromCondition(tm.condition);
      t.mark.equip = tm.id;
    },
    auto: (s, t) => {
      const e = s.equipment.find((x) => x.id === str(t, 'equip'));
      return !e || e.status === 'repairing' || e.maintenanceBooked || e.condition >= 95;
    },
  },
  {
    id: 'layout',
    tab: 'layout',
    title: '経営: レイアウト',
    text: '「店舗」タブの「レイアウト編集を開く」で、設備や椅子の配置を変えられます。よく使う設備を近くにまとめると早く作れます。何か1つ動かしてみよう。',
    enter: (s, _ctx, t) => {
      t.mark.layout = s.layoutVersion;
    },
    auto: (s, t) => s.layoutVersion > num(t, 'layout'),
  },
  {
    id: 'layout_close',
    title: '経営: レイアウト',
    text: '「完了」でレイアウト編集を閉じ、経営メニューも「✕ 閉じる」で閉じよう。',
    ui: 'closedAll',
  },
  {
    id: 'open',
    title: '開店',
    text: '準備ができました。「開店する」を押して営業を始めよう！',
    target: { kind: 'ui', id: 'open' },
    auto: (s) => s.phase !== 'prep',
  },
  {
    id: 'customer1',
    title: 'お客さんが来た',
    text: 'お客さんは券売機で食券を買い、カウンターに座ります。座ると、左上に食券（注文）が並びます。少し待とう。',
    enter: (s, ctx, t) => {
      t.mark.cust = spawnScriptedCustomer(s, ctx, 'small', { yasai: 1, ninniku: 1, abura: 1 }, 14).id;
    },
    auto: (s, t) => orderOf(s, t)?.status === 'waiting',
  },
  {
    id: 'bowl_take',
    title: '丼を用意する',
    text: '目印の「丼棚」を見て「🥣 丼取る」。',
    target: { kind: 'role', role: 'rack' },
    enter: (s, _ctx, t) => rememberSeat(s, t),
    auto: (s, t) => me(s).hand.kind === 'clean' || !!bowlOf(s, t),
  },
  {
    id: 'bowl_place',
    title: '丼を並べる',
    text: '「盛り付け台」を見て「🥣 並べる」。丼は食券の順にお客さんへ割り当てられます。',
    target: { kind: 'role', role: 'assembly' },
    auto: (s, t) => !!bowlOf(s, t),
  },
  {
    id: 'tare',
    title: 'タレを入れる',
    text: '盛り付け台で「🫗 タレ」を押し続けよう。',
    target: { kind: 'role', role: 'assembly' },
    enter: (s, _ctx, t) => {
      const b = bowlOf(s, t);
      if (b) t.mark.bowl = b.id;
    },
    auto: (s, t) => (bowlOf(s, t)?.contents?.tare ?? 0) > 0,
  },
  {
    id: 'soup',
    title: 'スープを注ぐ',
    text: '続けて「🍲 スープ」。寸胴が近いほど早く注げます。',
    target: { kind: 'role', role: 'assembly' },
    auto: (s, t) => (bowlOf(s, t)?.contents?.soupL ?? 0) > 0,
  },
  {
    id: 'noodles_in',
    title: '麺をゆでる',
    text: '「麺釜」を見て「🍜 麺入れ」。ゆで上がりまで約18秒。釜の上の輪が緑になったら食べ頃です。',
    target: { kind: 'role', role: 'boiler' },
    auto: (s, t) => {
      const o = orderOf(s, t);
      return !!o && noodlesStartedFor(s, o.id);
    },
  },
  {
    id: 'ask_call',
    title: 'コールを聞く',
    text: 'ゆでている間に、お客さんの席を見て「👂 コール」で「ニンニク入れますか？」と聞こう。トッピングの量（ヤサイ・ニンニク・アブラ・カラメ）を答えてくれます。',
    target: { kind: 'seat' },
    auto: (s, t) => !!orderOf(s, t)?.callRevealed,
  },
  {
    id: 'noodles_up',
    title: '麺上げ',
    text: '麺釜の輪が緑になったら「🥢 麺上げ」。遅すぎると麺がのびて味が落ちます。',
    target: { kind: 'role', role: 'boiler' },
    auto: (s, t) => (bowlOf(s, t)?.contents?.noodleG ?? 0) > 0,
  },
  {
    id: 'toppings',
    title: 'コールどおりに盛る',
    text: '盛り付け台で「🥬 盛る」。食券に聞いたコールが出ています（今回は ニンニク・アブラ）。',
    target: { kind: 'role', role: 'assembly' },
    auto: (s, t) => isBowlComplete(bowlOf(s, t)?.contents ?? null),
  },
  {
    id: 'bowl_pick',
    title: '丼を持つ',
    text: '完成しました！盛り付け台で「✋ 持つ」。',
    target: { kind: 'role', role: 'assembly' },
    auto: (s, t) => {
      const h = me(s).hand;
      return (h.kind === 'bowl' && h.bowlId === bowlOf(s, t)?.id) || orderOf(s, t)?.status === 'served';
    },
  },
  {
    id: 'serve',
    title: '提供する',
    text: 'お客さんの席を見て「🍽️ 提供」。冷めないうちに出しましょう。',
    target: { kind: 'seat' },
    auto: (s, t) => {
      const b = bowlOf(s, t);
      return orderOf(s, t)?.status === 'served' || b?.state === 'served' || b?.state === 'dirty';
    },
  },
  {
    id: 'eat_wait',
    title: 'お客さんが食べています',
    text: '食べ終わるまで少し待とう。味・速さ・接客・清潔さなどで満足度が決まり、口コミや評判につながります。',
    auto: (s, t) => bowlOf(s, t)?.state === 'dirty',
  },
  {
    id: 'collect',
    title: '片付け: 丼を下げる',
    text: '席を見て「🧺 下げる」。',
    target: { kind: 'seat' },
    enter: (s, _ctx, t) => {
      const b = bowlOf(s, t);
      if (b) t.mark.bowl = b.id;
    },
    auto: (s) => me(s).hand.kind === 'dirty',
  },
  {
    id: 'wash_drop',
    title: '片付け: 洗い場へ',
    text: '「洗い場」を見て「🧺 置く」。',
    target: { kind: 'role', role: 'sink' },
    auto: (s, t) => {
      const b = s.bowls.find((x) => x.id === str(t, 'bowl'));
      return !b || b.loc.at === 'sink' || b.state === 'clean';
    },
  },
  {
    id: 'wash',
    title: '片付け: 丼を洗う',
    text: '洗い場で「🧽 洗う」を押し続けよう。洗った丼は丼棚に戻り、また使えます。',
    target: { kind: 'role', role: 'sink' },
    auto: (s, t) => {
      const b = s.bowls.find((x) => x.id === str(t, 'bowl'));
      return !b || b.state === 'clean';
    },
  },
  {
    id: 'wipe',
    title: '片付け: カウンターを拭く',
    text: 'カウンターが汚れています。席を見て「🧻 拭く」。汚れたままだと次のお客さんの満足度が下がります。',
    target: { kind: 'seat' },
    enter: (s, _ctx, t) => {
      const seat = s.seats.find((x) => x.id === str(t, 'seat'));
      if (seat) seat.dirt = Math.max(seat.dirt, 0.6);
    },
    auto: (s, t) => (s.seats.find((x) => x.id === str(t, 'seat'))?.dirt ?? 0) < 0.05,
  },
  {
    id: 'mop_take',
    title: '掃除: モップを持つ',
    text: '床にスープがこぼれています。滑ると危ないので掃除しよう。まず「掃除用具入れ」を見て「🧹 持つ」。',
    target: { kind: 'role', role: 'locker' },
    enter: (s, _ctx, t) => {
      const st = STAGES[s.career.stage]!;
      const before = new Set(s.dirt.map((d) => d.id));
      addDirt(s, { x: st.playerSpawn.x + 1.2, z: st.playerSpawn.z }, 'spill', 'kitchen');
      const spill = s.dirt.find((d) => !before.has(d.id)) ?? s.dirt.find((d) => d.kind === 'spill');
      if (spill) t.mark.spill = spill.id;
    },
    auto: (s, t) => me(s).hand.kind === 'mop' || !s.dirt.some((d) => d.id === str(t, 'spill')),
  },
  {
    id: 'mop',
    title: '掃除: 床を拭く',
    text: '目印のこぼれたスープを見下ろして「🧹 掃除」を押し続けよう。',
    target: { kind: 'spill' },
    auto: (s, t) => !s.dirt.some((d) => d.id === str(t, 'spill')),
  },
  {
    id: 'mop_return',
    title: '掃除: 片付け',
    text: '掃除用具入れを見て「🧹 片付け」。',
    target: { kind: 'role', role: 'locker' },
    auto: (s) => me(s).hand.kind !== 'mop',
  },
  {
    id: 'customer2',
    title: '自分でやってみよう',
    text: '2人目のお客さんです。今度は自分で作って提供しよう。丼を並べる → タレ → スープ → 麺 → コールを聞く → 麺上げ → 盛る → 提供。迷ったら下の案内を見てね。',
    showGuide: true,
    enter: (s, ctx, t) => {
      t.mark.cust2 = spawnScriptedCustomer(s, ctx, 'small', { yasai: 2, karame: 1 }, 14).id;
    },
    auto: (s, t) => {
      const c = customer(s, t, 'cust2');
      if (!c) return true;
      const o = c.orderId ? s.orders.find((x) => x.id === c.orderId) : undefined;
      return o?.status === 'served' || c.state === 'eating' || c.state === 'leaving' || c.state === 'left';
    },
  },
  {
    id: 'cleanup2',
    title: '片付けまでが仕事',
    text: '食べ終わったら丼を下げて洗い、カウンターも拭こう。',
    showGuide: true,
    auto: (s) => s.bowls.every((b) => b.state !== 'served' && b.state !== 'dirty' && b.state !== 'washing'),
  },
  {
    id: 'close',
    title: '閉店',
    text: '本番の営業は11時〜15時（約9分）で、次々にお客さんが来ます。今日は練習なので、ここで閉店しよう。',
    target: { kind: 'ui', id: 'close' },
    closeButton: true,
    auto: (s) => s.phase === 'closed',
  },
  {
    id: 'results',
    title: '1日の精算',
    text: '売上から食材の原価・家賃・光熱費・維持費などを引いたものが利益です。資金が尽きて払えないまま期限を過ぎると破産します。経営メニューの「経営」でいつでも確認できます。',
    target: { kind: 'ui', id: 'results' },
    button: '次へ',
  },
  {
    id: 'finish',
    title: 'チュートリアル完了！',
    text: 'お疲れさまでした。練習の結果はリセットされ、1日目は資金¥300,000から始まります。3日目には従業員の雇い方も案内します。',
    button: '1日目を始める',
    last: true,
  },
];

// ───────────────────────── 3日目: 従業員 ─────────────────────────

const STAFF: TutorialStep[] = [
  {
    id: 'staff_intro',
    title: '従業員を雇う',
    text: '従業員を雇うと、仕込み・調理・接客・片付けを任せられます。そのぶん毎日の給与がかかります。',
    button: 'はじめる',
  },
  {
    id: 'staff_open',
    tab: 'staff',
    title: '従業員の画面',
    text: '右上の「☰ 経営」から経営メニューを開き、「従業員」タブを開こう。',
    target: { kind: 'ui', id: 'menu' },
    ui: 'manage:staff',
  },
  {
    id: 'staff_read',
    tab: 'staff',
    title: '候補者の見方',
    text: '能力（速さ・調理・接客・衛生・移動・信頼性）と、日給・採用費を比べます。採用費は雇うときに1回、日給は毎日の閉店時に払います。信頼性が低いと休むことがあります。',
    button: '次へ',
  },
  {
    id: 'staff_hire',
    tab: 'staff',
    title: '雇ってみる',
    text: '雇いたい人がいれば「採用する」を押そう。今は雇わない場合は下のボタンを押してください（あとでいつでも雇えます）。',
    enter: (s, _ctx, t) => {
      t.mark.emps = s.employees.length;
    },
    auto: (s, t) => s.employees.length > num(t, 'emps'),
    alt: { label: '今は雇わない', goto: 'staff_skip' },
  },
  {
    id: 'staff_roles',
    tab: 'staff',
    title: '担当を決める',
    text: '雇った人の「担当設定」を開くと、仕事の種類ごとの優先度を変えられます。例えば調理を任せて、あなたは接客と片付けに回る、など。',
    enter: (s, _ctx, t) => {
      t.mark.sig = staffSignature(s);
    },
    auto: (s, t) => staffSignature(s) !== str(t, 'sig'),
    button: 'このままでよい',
  },
  {
    id: 'staff_done',
    title: '任せてみよう',
    text: '開店すると、従業員は任せた仕事を自分で見つけて進めます。手が回らない仕事はあなたが手伝いましょう。採用・解雇・担当の変更は、従業員の画面でいつでもできます。',
    button: 'わかった',
    last: true,
  },
  {
    id: 'staff_skip',
    title: 'またいつでも',
    text: '雇いたくなったら、経営メニューの「従業員」からいつでも採用できます。お客さんが増えて手が回らなくなってきたら考えてみましょう。',
    button: 'わかった',
    last: true,
  },
];

export const TUTORIAL_STEPS: Record<TutorialKind, TutorialStep[]> = { basics: BASICS, staff: STAFF };

// ───────────────────────── 進行 ─────────────────────────

export function newTutorial(kind: TutorialKind): TutorialState {
  return { kind, step: 0, mark: {}, entered: false, finished: false };
}

/** 練習の日（営業0日目）か。自然な来店を止め、次の日へは進めない */
export function inBasicsTutorial(s: GameState): boolean {
  return s.tutorial?.kind === 'basics';
}

export function currentTutorialStep(s: GameState): TutorialStep | null {
  const t = s.tutorial;
  if (!t || t.finished) return null;
  return TUTORIAL_STEPS[t.kind][t.step] ?? null;
}

/** 進み具合（何番目 / 全体）。分岐先の手順は数えない */
export function tutorialProgress(s: GameState): { index: number; total: number } | null {
  const t = s.tutorial;
  if (!t) return null;
  const steps = TUTORIAL_STEPS[t.kind];
  const total = steps.findIndex((x) => x.last) + 1 || steps.length;
  return { index: Math.min(t.step + 1, total), total };
}

/** 目印を付ける対象の ID（設備・席・床の汚れ）。画面の部品なら ui を返す */
export function tutorialTarget(s: GameState): { id: string } | { ui: 'menu' | 'open' | 'close' | 'results' } | null {
  const t = s.tutorial;
  const st = currentTutorialStep(s);
  if (!t || !st?.target) return null;
  const tg = st.target;
  switch (tg.kind) {
    case 'role': {
      const e = equipmentByRole(s, tg.role);
      return e ? { id: e.id } : null;
    }
    case 'seat': {
      const id = str(t, 'seat');
      return id ? { id } : null;
    }
    case 'spill': {
      const id = str(t, 'spill');
      return id && s.dirt.some((d) => d.id === id) ? { id } : null;
    }
    case 'ui':
      return { ui: tg.id };
  }
}

function goTo(s: GameState, ctx: SimCtx, t: TutorialState, index: number): void {
  const steps = TUTORIAL_STEPS[t.kind];
  const cur = steps[t.step];
  if (cur?.last || index >= steps.length) {
    if (t.kind === 'basics') t.finished = true;
    else s.tutorial = null;
    emit(ctx, { type: 'tutorialDone' });
    return;
  }
  t.step = index;
  t.entered = true;
  steps[index]!.enter?.(s, ctx, t);
  emit(ctx, { type: 'tutorialStep', text: steps[index]!.id });
}

/** 毎ステップ呼ぶ: 開始処理と、条件を満たした手順を次へ進める */
export function updateTutorial(s: GameState, ctx: SimCtx): void {
  const t = s.tutorial;
  if (!t || t.finished) return;
  const steps = TUTORIAL_STEPS[t.kind];
  if (!t.entered) {
    t.entered = true;
    steps[t.step]?.enter?.(s, ctx, t);
  }
  // 一度に満たしていれば続けて進める（すでに丼を持っている等）
  for (let guard = 0; guard < 8; guard++) {
    const cur = s.tutorial;
    if (!cur || cur.finished) return;
    const st = TUTORIAL_STEPS[cur.kind][cur.step];
    if (!st?.auto || !st.auto(s, cur)) return;
    goTo(s, ctx, cur, cur.step + 1);
  }
}

export type TutorialOp = 'next' | 'alt' | 'close' | 'quit' | 'staffStart' | 'staffDecline';

/** チュートリアルの操作（「次へ」「今は雇わない」「閉店する」など） */
export function tutorialAction(s: GameState, ctx: SimCtx, op: TutorialOp, stepId?: string): { ok: boolean; reason?: string } {
  if (op === 'staffStart' || op === 'staffDecline') {
    if (s.tutorial) return { ok: false, reason: 'チュートリアル中です' };
    if (s.career.staffTutorialOffered) return { ok: false, reason: '案内済みです' };
    if (s.day < 3 || s.phase !== 'prep') return { ok: false, reason: '3日目以降の準備時間にだけ受けられます' };
    if (s.players.length !== 1) return { ok: false, reason: 'ひとりで経営しているときだけ受けられます' };
    s.career.staffTutorialOffered = true;
    if (op === 'staffDecline') return { ok: true };
    // 雇い方を学ぶ回なので、まだ解放されていなければ採用を解放する
    if (!s.career.unlocked.includes('hiring')) s.career.unlocked.push('hiring');
    if (s.candidates.length === 0) refreshCandidates(s);
    s.tutorial = newTutorial('staff');
    updateTutorial(s, ctx);
    return { ok: true };
  }
  const t = s.tutorial;
  if (!t || t.finished) return { ok: false, reason: 'チュートリアル中ではありません' };
  const steps = TUTORIAL_STEPS[t.kind];
  const st = steps[t.step];
  if (!st) return { ok: false, reason: '手順が見つかりません' };
  if (stepId !== undefined && stepId !== st.id) return { ok: false, reason: '手順が変わりました' };
  switch (op) {
    case 'next':
      if (!st.button && !st.ui) return { ok: false, reason: 'この手順は、やってみると次へ進みます' };
      goTo(s, ctx, t, t.step + 1);
      return { ok: true };
    case 'alt': {
      const to = st.alt ? steps.findIndex((x) => x.id === st.alt!.goto) : -1;
      if (to < 0) return { ok: false, reason: '選べません' };
      t.step = to;
      t.entered = true;
      steps[to]!.enter?.(s, ctx, t);
      return { ok: true };
    }
    case 'close':
      if (!st.closeButton || s.phase !== 'open') return { ok: false, reason: '今は閉店できません' };
      startClosing(s, ctx);
      return { ok: true };
    case 'quit':
      if (t.kind === 'basics') t.finished = true;
      else s.tutorial = null;
      return { ok: true };
  }
}
