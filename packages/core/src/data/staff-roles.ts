// 店の役目と、その役目の人がしてよい仕事の対応（じろ7 2-3「権限はハードコードせず、役割と権限の対応関係を管理する」）。
// 店の仕事（従業員がする）と、経営の操作（店の売買・設備・借入など）を分けて持つ。
// 経営の操作は店主（プレイヤー。共同経営ではホスト）だけ。従業員はどの役目でもしない（店長も店長代理も）。

/** 店での役目（その日・その人） */
export type StaffAuthority = 'manager' | 'deputy' | 'leader' | 'staff';

/**
 * 店の仕事
 *   allTasks     担当に関係なく店の仕事を何でもする（仕事の割り振りの穴を埋める）
 *   urgentPrep   仕込み品が足りなくなりそうなら、急ぎの仕込みを先にする
 *   expressOrder 材料が閉店までに足りなくなりそうなら、当日便で仕入れる
 *   nextDayOrder 閉店後に翌日の来客を予測して、翌朝便で発注する（「店長に発注を任せる」店）
 *   complaint    クレームに、担当に関係なく最初に対応する
 */
export type StaffDuty = 'allTasks' | 'urgentPrep' | 'expressOrder' | 'nextDayOrder' | 'complaint';

/** 経営の操作（店主だけ。従業員の役目には付けない） */
export type OwnerOperation = 'storeTrade' | 'equipment' | 'loan' | 'openStore' | 'credit' | 'policy';

/** 役目 → してよい店の仕事 */
export const STAFF_DUTIES: Readonly<Record<StaffAuthority, readonly StaffDuty[]>> = {
  // 店長: 店の仕事を全部する
  manager: ['allTasks', 'urgentPrep', 'expressOrder', 'nextDayOrder', 'complaint'],
  // 店長代理（その日だけ任命された社員）: 店長がいない間、店長と同じ店の仕事をする
  deputy: ['allTasks', 'urgentPrep', 'expressOrder', 'nextDayOrder', 'complaint'],
  // シフトリーダー（社員の上位の役職）: 全部の仕事をし、店長も店長代理もいない間は店長の仕事を代わる
  leader: ['allTasks', 'urgentPrep', 'expressOrder', 'nextDayOrder', 'complaint'],
  // ほかの従業員: 担当の仕事だけ
  staff: [],
};

/** 役目 → してよい経営の操作（どの役目も空。経営の操作は店主だけ） */
export const STAFF_OPERATIONS: Readonly<Record<StaffAuthority, readonly OwnerOperation[]>> = {
  manager: [],
  deputy: [],
  leader: [],
  staff: [],
};

/** 役目の呼び名 */
export const AUTHORITY_LABEL: Readonly<Record<StaffAuthority, string>> = {
  manager: '店長',
  deputy: '店長代理',
  leader: 'シフトリーダー',
  staff: '従業員',
};

export function hasDuty(a: StaffAuthority, d: StaffDuty): boolean {
  return STAFF_DUTIES[a].includes(d);
}

export function canOperate(a: StaffAuthority, op: OwnerOperation): boolean {
  return STAFF_OPERATIONS[a].includes(op);
}
