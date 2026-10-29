// 初心者向けの「次にやること」ガイド。状態から次の一手を提案する（最初の数日だけ表示）。

import {
  BALANCE,
  bowlForOrder,
  bowlsOnAssembly,
  EQUIPMENT,
  isBowlComplete,
  stockOf,
  waitingOrders,
  type GameState,
} from '@jiro/core';

export function nextHint(s: GameState, myId: string): string | null {
  const me = s.players.find((p) => p.id === myId);
  if (!me) return null;
  if (s.phase === 'prep') {
    if (s.day === 1) return '仕込み時間です。準備ができたら「開店する」を押しましょう';
    if (stockOf(s, 'buta') < 10 && stockOf(s, 'pork_block') > 0) return '豚が少ないです。仕込み台で「🔪 豚切り」';
    return null;
  }
  if (s.phase !== 'open' && s.phase !== 'closing') return null;
  const orders = waitingOrders(s);
  const roleOf = (id: string) => EQUIPMENT[s.equipment.find((e) => e.id === id)?.type ?? '']?.role;
  const asms = s.equipment.filter((e) => e.placed && roleOf(e.id) === 'assembly');
  const onAsm = asms.flatMap((a) => bowlsOnAssembly(s, a));
  const hand = me.hand;
  if (hand.kind === 'bowl') {
    const b = s.bowls.find((x) => x.id === hand.bowlId);
    if (b && isBowlComplete(b.contents)) {
      const o = s.orders.find((x) => x.id === b.orderId);
      const seat = o ? s.seats.find((x) => x.id === o.seatId) : undefined;
      return seat ? `カウンターの${seat.index + 1}番席を見て「🍽️ 提供」` : '注文のある席を見て「🍽️ 提供」';
    }
    return '盛り付け台に丼を置きましょう';
  }
  if (hand.kind === 'clean') return '盛り付け台を見て「🥣 並べる」';
  if (hand.kind === 'dirty') return '洗い場を見て「🧺 置く」→「🧽 洗う」';
  if (hand.kind === 'mop') return '床の汚れを見て掃除。終わったら掃除用具入れにモップを戻す';
  if (hand.kind === 'lostItem') return '事務机で「📦 保管」';
  if (orders.length === 0) {
    // 食べ終わった席（汚れた丼がある）: 汚れていれば先に拭く（拭くまでは丼を下げられない）
    const dirtySeat = s.seats.find((x) => s.bowls.find((b) => b.id === x.bowlId)?.state === 'dirty');
    if (dirtySeat) {
      return dirtySeat.dirt >= BALANCE.cleaning.counterCleanBelow
        ? `${dirtySeat.index + 1}番席のカウンターを「🧻 拭く」→ 丼を「🧺 下げる」`
        : `${dirtySeat.index + 1}番席の丼を「🧺 下げる」`;
    }
    const dirty = s.seats.find((x) => x.dirt > 0.4 && !x.customerId);
    if (dirty) return `${dirty.index + 1}番席のカウンターを拭きましょう`;
    return 'お客さんを待っています。今のうちに仕込みや洗い物を';
  }
  const done = onAsm.find((x) => isBowlComplete(x.bowl.contents));
  if (done) return '完成した丼があります。盛り付け台で「✋ 持つ」';
  const needToppings = onAsm.find((x) => x.bowl.contents && x.bowl.contents.noodleG > 0);
  if (needToppings) {
    const o = s.orders.find((x) => x.id === needToppings.bowl.orderId);
    if (o && !o.callRevealed) {
      const seat = s.seats.find((x) => x.id === o.seatId);
      return `${(seat?.index ?? 0) + 1}番席を見て「👂 コール」（ニンニク入れますか？）`;
    }
    return '盛り付け台で「🥬 盛る」';
  }
  const boilerReady = s.equipment.some((e) => e.slots.some((sl) => sl && sl.elapsed >= sl.ideal - 3));
  if (boilerReady && onAsm.some((x) => x.bowl.contents && x.bowl.contents.soupL > 0 && x.bowl.contents.noodleG === 0)) return '麺がゆで上がります！麺釜で「🥢 麺上げ」';
  const needBowl = orders.filter((o) => !bowlForOrder(s, o.id));
  if (needBowl.length > 0 && onAsm.length < 4) return '丼棚で「🥣 丼取る」→ 盛り付け台で「🥣 並べる」';
  if (onAsm.some((x) => x.bowl.contents && x.bowl.contents.tare === 0)) return '盛り付け台で「🫗 タレ」';
  if (onAsm.some((x) => x.bowl.contents && x.bowl.contents.soupL === 0)) return '盛り付け台で「🍲 スープ」';
  const boiling = s.equipment.some((e) => e.slots.some(Boolean));
  if (!boiling) return `麺釜で「🍜 麺入れ」（約${BALANCE.cooking.noodleIdeal}秒でゆで上がり）`;
  return '麺がゆで上がるまでに、コールを聞いておきましょう';
}
