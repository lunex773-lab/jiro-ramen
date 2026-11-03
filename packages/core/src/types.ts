// ゲーム状態の型定義。
// GameState は JSON にそのまま変換できるプレーンなオブジェクトだけで構成する（Map/クラス禁止）。
// セーブ・ネットワーク同期・サーバー権威シミュレーションのすべてがこの形を前提にしている。

export type Id = string;

export interface Vec2 {
  x: number;
  z: number;
}

export type DayPhase = 'prep' | 'open' | 'closing' | 'closed' | 'bankrupt';

/** コールの種類。カラメはタレ増量。 */
export type CallKey = 'yasai' | 'ninniku' | 'abura' | 'karame' | 'ichimi';
export type CallLevels = Record<CallKey, number>;
export type ToppingKey = 'yasai' | 'ninniku' | 'abura' | 'ichimi';

// ───────────────────────── 調理 ─────────────────────────

export interface BowlContents {
  /** タレの投入回数（1=標準, 2=カラメ, 3=カラカラ） */
  tare: number;
  tareQuality: number;
  soupL: number;
  soupQuality: number;
  /** スープ投入時の温度 */
  soupTemp: number;
  noodleG: number;
  /** ゆで加減の品質 0..1 */
  noodleQuality: number;
  /** ゆで時間と理想時間の差（秒, 正=ゆですぎ） */
  noodleBoilDelta: number;
  toppings: Record<ToppingKey, number>;
  buta: number;
  butaQuality: number;
  /** 使用した食材の最低鮮度 0..1 */
  freshness: number;
  /** 実行した工程の順序 */
  steps: string[];
  /** 最初に中身を入れた時刻（sim秒） */
  startedAt: number;
  /** 現在の温度（℃） */
  heat: number;
  /** 投入した食材の原価合計（提供時に売上原価、廃棄時に廃棄損として計上） */
  cost: number;
  /** 生卵などの追加 */
  extras: Record<string, number>;
}

export type BowlState = 'clean' | 'assembling' | 'served' | 'dirty' | 'washing' | 'broken';

export type BowlLoc =
  | { at: 'rack' }
  | { at: 'hand'; actorId: Id }
  | { at: 'station'; stationId: Id; slot: number }
  | { at: 'seat'; seatId: Id }
  | { at: 'sink'; stationId: Id };

export interface Bowl {
  id: Id;
  state: BowlState;
  loc: BowlLoc;
  contents: BowlContents | null;
  orderId: Id | null;
}

export interface NoodleSlot {
  orderId: Id | null;
  grams: number;
  elapsed: number;
  /** 理想のゆで時間 */
  ideal: number;
  quality: number;
  freshness: number;
  unitCost: number;
}

export interface PotProcess {
  recipeId: string;
  elapsed: number;
  duration: number;
  /** 投入済み食材の原価合計（完成品へ引き継ぐ） */
  cost: number;
  quality: number;
  freshness: number;
  startedBy: Id;
}

// ───────────────────────── 行為者 ─────────────────────────

export type Hand =
  | { kind: 'none' }
  | { kind: 'bowl'; bowlId: Id }
  | { kind: 'clean'; bowlIds: Id[] }
  | { kind: 'dirty'; bowlIds: Id[] }
  | { kind: 'mop' }
  | { kind: 'lostItem'; lostItemId: Id }
  | { kind: 'trash'; amount: number };

/** 時間のかかる作業（長押し作業）。 */
export interface Work {
  verb: string;
  targetId: Id;
  /** 経過時間（秒） */
  progress: number;
  /** 合計所要時間（秒） */
  duration: number;
  /** 1単位あたりの時間（丼1杯ずつ洗う、など） */
  unitTime: number;
  units: number;
  done: number;
  args: Record<string, string | number | boolean> | null;
}

export interface ActorBase {
  id: Id;
  pos: Vec2;
  yaw: number;
  hand: Hand;
  work: Work | null;
}

export interface Player extends ActorBase {
  kind: 'player';
  name: string;
  color: string;
  connected: boolean;
  isHost: boolean;
  /** 最後に位置を受け付けたsim時刻（サーバーの速度検証用） */
  lastMoveAt: number;
}

export type EmployeeRole = 'cook' | 'server' | 'cleaner';

export interface EmployeeSkills {
  speed: number;
  cooking: number;
  service: number;
  hygiene: number;
  movement: number;
  /**
   * 第2版より前の「信頼性」（画面に出していた能力）。今は隠しパラメータ「勤怠」（EmployeeProfile.diligence）に置き換えた。
   * 古いセーブの値は勤怠の初期値として読むだけで、新しく作る人には付けない
   */
  reliability?: number;
}

/** 雇用形態。part = アルバイト（時給・シフト）、full = 社員（日給・毎日・仕込みから閉店まで） */
export type Employment = 'part' | 'full';

/**
 * 1日分のシフト（営業 11:00〜15:00 の中で、開店からの分。30分刻み）。
 * fromPrep のときは仕込みの時間から出勤する（start は 0）
 */
export interface ShiftDay {
  start: number;
  end: number;
  /** 休憩の開始（開店からの分）と長さ（分）。休憩なしは breakLen = 0 */
  breakAt: number;
  breakLen: number;
  fromPrep: boolean;
}

/** 勤務の出来事（実際に起きたことだけを記録する） */
export type StaffLogKind = 'late' | 'absent' | 'slack' | 'private' | 'postpone' | 'argue' | 'rude' | 'abandon' | 'calm' | 'promoted' | 'calledIn';

export interface StaffLogEntry {
  day: number;
  kind: StaffLogKind;
  text: string;
}

/** 勤務の記録（昇格の参考情報・履歴） */
export interface StaffRecord {
  daysWorked: number;
  /** 予定のあった日（休みの日は数えない） */
  daysScheduled: number;
  late: number;
  absent: number;
  slack: number;
  postpone: number;
  argue: number;
  /** 客への態度が悪かった（クレーム対応） */
  rude: number;
  /** クレーム対応を途中で放棄した */
  abandon: number;
  calm: number;
  /** 対応したクレームの数（受け入れてもらえたもの） */
  complaintsSettled: number;
  /** 提供した丼の数 */
  served: number;
  log: StaffLogEntry[];
}

export type AttendanceStatus = 'off' | 'scheduled' | 'late' | 'working' | 'break' | 'left' | 'absent' | 'closed';

/** その日の出勤の状況（毎朝の出勤確認で作る） */
export interface Attendance {
  day: number;
  /** その日の予定（休みは null）。予定を変えたら作り直す */
  shift: ShiftDay | null;
  /** 朝に引いた結果（その日のうちは引き直さない） */
  absent: boolean;
  lateMin: number;
  status: AttendanceStatus;
  /** 店に着く時刻（開店からの sim 秒。仕込みから来る人は -1） */
  arriveAt: number;
  leaveAt: number;
  breakFrom: number;
  breakTo: number;
  arrived: boolean;
  /** その日の勤務（営業中の sim 秒）。給与の計算に使う */
  workedSec: number;
  /** 仕込みの時間に出勤した */
  prepWorked: boolean;
  /** 休みの日に呼び出した */
  calledIn: boolean;
  /** 遅刻・サボりの記録を一度だけ残すための印 */
  lateNoted: boolean;
}

export interface EmployeeProfile {
  name: string;
  role: EmployeeRole;
  skills: EmployeeSkills;
  /** 日給（社員）。古いセーブの従業員は社員として扱うのでこの値をそのまま使う */
  wage: number;
  hireFee: number;
  experience: number;
  /** 雇用形態（古いセーブにはない → 社員） */
  employment?: Employment;
  /** 時給（アルバイト） */
  hourly?: number;
  /** 隠しパラメータ「勤怠」0..1（画面には数値を出さない）。古いセーブは skills.reliability */
  diligence?: number;
  /** 隠しパラメータ「辛抱」0..1（画面には数値を出さない） */
  patience?: number;
}

export type EmployeeAiState = 'idle' | 'moving' | 'working' | 'waiting' | 'absent' | 'stuck' | 'slacking' | 'break' | 'off';

export interface Employee extends ActorBase {
  kind: 'employee';
  profile: EmployeeProfile;
  hiredDay: number;
  /** 担当タスク種類の優先度上書き（担当設定） */
  priorities: Record<string, number>;
  ai: {
    state: EmployeeAiState;
    taskId: Id | null;
    /** 実行中のタスクの残り手順 */
    steps: TaskStep[];
    path: Vec2[];
    stuckTime: number;
    idleTime: number;
    /** 次にタスクを選び直すまでの待ち */
    cooldown: number;
    note: string;
  };
  /** 今、店で働いている（休憩中・退勤後・出勤前は false） */
  presentToday: boolean;
  tasksDone: number;
  /** 曜日（月=0 … 日=6）ごとのシフト。アルバイトだけが使う（ない曜日は休み）。古いセーブにはない → 毎日・全時間 */
  shifts?: (ShiftDay | null)[];
  /** その日の出勤の状況 */
  att?: Attendance;
  /** 勤務の記録 */
  record?: StaffRecord;
  /** サボり・私的な休憩の状況（営業中の sim 秒） */
  conduct?: {
    nextCheck: number;
    until: number;
    kind: 'slack' | 'private' | null;
    lastAt: number;
    today: number;
    day: number;
  };
  /** その日に伸びた能力の量（1日の上限のため） */
  growth?: { day: number; gained: Partial<Record<keyof EmployeeSkills, number>> };
  /** 従業員の吹き出し（クレームで言い返したときなど） */
  say?: { text: string; until: number } | null;
}

export interface TaskStep {
  targetId: Id;
  verb: string;
  args: Record<string, string | number | boolean> | null;
}

export interface Candidate {
  id: Id;
  profile: EmployeeProfile;
}

// ───────────────────────── 設備・レイアウト ─────────────────────────

export type EquipmentStatus = 'normal' | 'worn' | 'faulty' | 'broken' | 'repairing';
export type Rot = 0 | 1 | 2 | 3;

export interface Equipment {
  id: Id;
  type: string;
  placed: boolean;
  gx: number;
  gz: number;
  rot: Rot;
  /** 微調整オフセット（m）。微調整可能な種類のみ非0 */
  offset: Vec2;
  /** 状態 0..100 */
  condition: number;
  status: EquipmentStatus;
  repairUntil: number | null;
  uses: number;
  maintenanceBooked: boolean;
  /** 麺釜のスロット */
  slots: (NoodleSlot | null)[];
  /** 鍋の加工工程 */
  process: PotProcess | null;
  /** 寸胴のスープ量 */
  soupL: number;
  soupQuality: number;
  /** 寸胴のスープの原価合計 */
  soupCost: number;
  /** 盛り付け台に置かれた丼 */
  bowlSlots: (Id | null)[];
  /** 食洗機の中身 */
  washing: Id[];
  washElapsed: number;
  /** ゴミ量 */
  fill: number;
}

export interface Seat {
  id: Id;
  index: number;
  installed: boolean;
  offset: Vec2;
  /** カウンターの汚れ 0..1 */
  dirt: number;
  customerId: Id | null;
  /** 返却待ちの丼 */
  bowlId: Id | null;
  lostItemId: Id | null;
}

export interface DirtSpot {
  id: Id;
  pos: Vec2;
  amount: number;
  kind: 'grime' | 'spill';
  zone: 'kitchen' | 'dining';
}

export interface LostItem {
  id: Id;
  kind: string;
  ownerCustomerId: Id;
  ownerRegularId: Id | null;
  /** 発生場所 */
  seatId: Id | null;
  state: 'lying' | 'carried' | 'stored' | 'returned' | 'discarded';
  createdAt: number;
  createdDay: number;
  /** 放置時間（秒） */
  neglect: number;
  /** 持ち主が取りに来る予定日 */
  returnDay: number;
}

// ───────────────────────── 客・注文 ─────────────────────────

export interface CustomerTraits {
  patience: number;
  priceSensitivity: number;
  tasteCritic: number;
  serviceSensitivity: number;
  eatSpeed: number;
  orderComplexity: number;
  cleanlinessDemand: number;
  reviewPropensity: number;
  loyaltyPropensity: number;
  complaintPropensity: number;
  manners: number;
  appetite: number;
}

export type CustomerState =
  | 'arriving'
  | 'queue'
  | 'ticket'
  | 'waitingSeat'
  | 'toSeat'
  | 'seated'
  | 'eating'
  | 'complaint'
  | 'leaving'
  | 'left'
  | 'abandoned';

export interface SatisfactionParts {
  taste: number;
  speed: number;
  service: number;
  cleanliness: number;
  accuracy: number;
  stock: number;
  value: number;
  comfort: number;
}

export interface Customer {
  id: Id;
  traits: CustomerTraits;
  regularId: Id | null;
  appearance: number;
  state: CustomerState;
  pos: Vec2;
  path: Vec2[];
  stateTime: number;
  arrivedAt: number;
  /** 行列で待った時間 */
  queueWait: number;
  /** 着席から提供までの時間 */
  seatWait: number;
  patience: number;
  seatId: Id | null;
  orderId: Id | null;
  menuId: string | null;
  call: CallLevels;
  /** 第一希望が品切れだった */
  stockout: boolean;
  eatLeft: number;
  sat: SatisfactionParts;
  /** 吹き出し表示用 */
  say: string;
  sayUntil: number;
  complaintReason: string | null;
  /** 列に並ぶための目標位置インデックス */
  slot: number;
  /** 忘れ物を取りに来た客 */
  forLostItem: Id | null;
  /** チュートリアル用の客（注文と食べる時間が決まっていて、帰ったりクレームを言ったりしない） */
  script?: { menuId: string; eatTime: number } | null;
  // 以下は営業中のイベント（sim/events.ts, sim/complaints.ts）で使う。古いセーブにはないので任意の項目
  /** 言っている最中のクレーム（complaint 状態のとき） */
  complaint?: CustomerComplaint | null;
  /** この来店で言ったクレーム（同じクレームを繰り返さないため） */
  complaintLog?: { cause: ComplaintCause; remakes: number }[];
  /** この来店で抽選を済ませた確認（遅延・汚れ・理不尽な要求など。同じ確認を何度も抽選しない） */
  rolled?: string[];
  /** 特別な客（覆面調査員・珍しい客）。正体は画面に出さない */
  special?: CustomerSpecial | null;
  /** 一緒に来た客の ID（カップル） */
  partyId?: Id | null;
  /** 見た目の指定（珍しい客）。なければ appearance から決まる */
  look?: CustomerLook | null;
  /** SNS を見て来た客 */
  fromBuzz?: boolean;
  /** 吹き出しの種類（小声） */
  sayStyle?: 'whisper' | null;
  /** 食事の合計時間（秒。食事の途中のセリフに使う） */
  eatTotal?: number;
}

/** クレームの原因 */
export type ComplaintCause = 'mistake' | 'quality' | 'delay' | 'dirty' | 'unreasonable';
/** クレームへの対応 */
export type ComplaintResponse = 'apologize' | 'remake' | 'refund' | 'explain' | 'refuse';

export interface CustomerComplaint {
  id: Id;
  cause: ComplaintCause;
  /** 提供したあとのクレームか（提供前は作り直せず、返金は食券の払い戻しになる） */
  served: boolean;
  text: string;
  /** 試して受け入れてもらえなかった対応（同じクレームの間は選べない） */
  tried: ComplaintResponse[];
}

export type SpecialKind = 'critic' | 'couple_her' | 'couple_him' | 'ramen_lover';

export interface CustomerSpecial {
  kind: SpecialKind;
  /** 発生したイベントの ID */
  eventId: Id;
  /** セリフを言い終えた（一度の来店で一度だけ） */
  spoken: boolean;
}

export type CustomerLook = 'blonde_woman' | 'boyfriend';

export type OrderStatus = 'waiting' | 'served' | 'cancelled' | 'refunded';

export interface Order {
  id: Id;
  customerId: Id;
  seatId: Id;
  menuId: string;
  call: CallLevels;
  callRevealed: boolean;
  callAskedAt: number | null;
  createdAt: number;
  status: OrderStatus;
  servedAt: number | null;
  price: number;
  quality: number | null;
  mistakes: string[];
  remakes: number;
  /** 調理担当として予約した行為者 */
  cookId: Id | null;
}

// ───────────────────────── 在庫 ─────────────────────────

export interface Lot {
  id: Id;
  itemId: string;
  qty: number;
  unitCost: number;
  quality: number;
  createdDay: number;
  expiresDay: number;
}

export interface Delivery {
  id: Id;
  itemId: string;
  qty: number;
  unitCost: number;
  arriveDay: number;
  /** 当日便の到着sim時刻。翌朝便は null */
  arriveAt: number | null;
}

// ───────────────────────── 経済 ─────────────────────────

export type TxnType =
  | 'sale'
  | 'refund'
  | 'purchase'
  | 'wage'
  | 'rent'
  | 'upkeep'
  | 'utilities'
  | 'repair'
  | 'maintenance'
  | 'hire'
  | 'severance'
  | 'equipment'
  | 'equipmentSale'
  | 'expansion'
  | 'loan'
  | 'loanRepay'
  | 'interest'
  | 'arrearsPay'
  | 'relocation';

export interface Txn {
  id: Id;
  day: number;
  t: number;
  type: TxnType;
  amount: number;
  memo: string;
  /** 二重計上防止のためのキー（同じキーは一度だけ） */
  key: string;
}

export interface DayStats {
  sales: number;
  refunds: number;
  cogs: number;
  waste: number;
  wages: number;
  rent: number;
  upkeep: number;
  utilities: number;
  repairs: number;
  hiring: number;
  interest: number;
  purchases: number;
  capex: number;
  served: number;
  customers: number;
  lost: number;
  balked: number;
  totalSeatWait: number;
  totalQueueWait: number;
  satisfactionSum: number;
  satisfactionCount: number;
  mistakes: number;
  stockouts: number;
  complaints: number;
  breakdowns: number;
  remakes: number;
  wasteItems: Record<string, number>;
}

export interface DayReport extends DayStats {
  day: number;
  operatingProfit: number;
  cashStart: number;
  cashEnd: number;
  reputation: number;
  reviews: number;
  avgSatisfaction: number;
  avgWait: number;
}

export interface Arrear {
  id: Id;
  amount: number;
  reason: string;
  sinceDay: number;
  dueDay: number;
}

export interface Loan {
  id: Id;
  principal: number;
  remaining: number;
  dailyRate: number;
  dailyPayment: number;
  takenDay: number;
}

// ───────────────────────── 評判 ─────────────────────────

export interface Review {
  id: Id;
  day: number;
  stars: number;
  text: string;
  parts: SatisfactionParts;
  regular: boolean;
  /** グルメ評論家（覆面調査員）の記事 */
  critic?: boolean;
}

export interface Regular {
  id: Id;
  name: string;
  traits: CustomerTraits;
  appearance: number;
  visits: number;
  favoriteMenu: string;
  favoriteCall: CallLevels;
  satisfactionSum: number;
  lastVisitDay: number;
  loyalty: number;
  rating: number;
}

// ───────────────────────── 通知・イベント ─────────────────────────

export type NoticeLevel = 'info' | 'warn' | 'danger' | 'good';

export interface Notice {
  id: Id;
  code: string;
  level: NoticeLevel;
  text: string;
  t: number;
  day: number;
}

export interface GameEvent {
  type: string;
  actorId?: Id;
  targetId?: Id;
  text?: string;
  value?: number;
  pos?: Vec2;
}

// ───────────────────────── 全体 ─────────────────────────

export interface CareerState {
  stage: number;
  goalsDone: string[];
  unlocked: string[];
  totalServed: number;
  bestDayServed: number;
  bestDayProfit: number;
  daysPlayed: number;
  /** 3日目の「従業員のチュートリアル」を案内したか（受けた・断ったのどちらでも true） */
  staffTutorialOffered?: boolean;
}

/**
 * チュートリアルの進み具合。basics = 営業0日目（練習の日）、staff = 3日目の従業員の回。
 * 手順の中身（文言・完了条件）は sim/tutorial.ts にあり、状態には番号と基準値だけを持つ。
 */
export interface TutorialState {
  kind: 'basics' | 'staff';
  step: number;
  /** 手順を始めたときの値（完了判定の基準。席・丼・汚れの ID など） */
  mark: Record<string, number | string>;
  /** その手順の開始処理を済ませたか */
  entered: boolean;
  /** 最後の手順まで終えた（basics は画面側で1日目を始める） */
  finished: boolean;
}

// ───────────────────────── 営業中のイベント ─────────────────────────

/** イベントの種類（安定した ID。設定値・記録・強制発生のキー） */
export type EventKind = 'sns_buzz' | 'critic' | 'rare_couple' | 'rare_lover' | 'complaint_unreasonable' | 'explosion';

export interface EventStat {
  /** 抽選した回数 */
  draws: number;
  /** 発生した回数（テスト用の強制発生を含む） */
  fired: number;
  /** そのうちテスト用に強制発生した回数（実測の頻度から除くため） */
  forced: number;
  /** 最後に発生した営業日（-1 = まだ） */
  lastDay: number;
}

export interface BuzzState {
  id: Id;
  /** 営業の経過秒（openT）での開始・終了 */
  startT: number;
  endT: number;
  mult: number;
  /** 拡散している投稿 */
  post: string;
}

export type CriticItem = 'taste' | 'speed' | 'service' | 'cleanliness' | 'accuracy';

/** 覆面調査員（グルメ評論家）の評価。来店した翌日の仕込みの開始時に公開する */
export interface CriticReport {
  id: Id;
  day: number;
  publishDay: number;
  stars: number;
  scores: Record<CriticItem, number>;
  /** 食べずに帰った（待ちきれなかった） */
  walkedOut: boolean;
  published: boolean;
  text: string;
  /** 改善すべき項目（点数の低い順） */
  improve: CriticItem[];
}

/** 来客の倍率（覆面調査員の記事の反響など）。untilDay の営業まで続く */
export interface DemandEffect {
  id: Id;
  source: EventKind;
  mult: number;
  untilDay: number;
}

/** 爆発事故。warning = 設備の異常（営業は続く）、destroyed = 店が壊滅（営業処理は止まる） */
export interface AccidentState {
  id: Id;
  day: number;
  stage: 'warning' | 'destroyed';
  /** その段階の経過秒 */
  t: number;
  /** 異常を起こした設備 */
  sourceId: Id | null;
  pos: Vec2;
}

export interface ShopEvents {
  /** イベント専用の乱数（既存の s.rng の並びを変えないため。リセットでも戻さない） */
  rng: number;
  /** イベントごとの抽選・発生の記録（実測の発生頻度。リセットでも戻さない） */
  stats: Record<string, EventStat>;
  /** その日の回数（理不尽なクレーム・珍しい客など。日が変わると消える） */
  daily: { day: number; counts: Record<string, number> };
  buzz: BuzzState | null;
  /** 次に SNS バズを抽選する営業の経過秒 */
  nextBuzzCheck: number;
  /** 覆面調査員が来る予定（開店時の抽選で当たった日） */
  criticPlan: { day: number; afterOpenT: number } | null;
  /** 覆面調査員の評価（公開前・公開済み。最近のものだけ） */
  critics: CriticReport[];
  effects: DemandEffect[];
  /** 理不尽なクレームを最後に言われた時刻（その日の t） */
  unreasonableAt: number;
  /** テスト用: 次の来店・提供で必ず起こすイベント */
  forced: EventKind[];
  /** 爆発事故を抽選した最後の営業日（同じ日に二度抽選しない。リセットでも戻さない） */
  accidentDrawDay: number;
  /** 抽選で当たった事故の予定 */
  accidentPlan: { id: Id; day: number; atOpenT: number } | null;
  accident: AccidentState | null;
  /** 仕込み開始時点に戻した回数 */
  resets: number;
}

/** 仕込み開始時点の状態の控え。日報・口コミ（営業中は変わらない）と、プレイヤー（接続で変わる）は入れない */
export type SnapshotState = Omit<GameState, 'prepSnapshot' | 'history' | 'reviews' | 'players'>;

export interface PrepSnapshot {
  day: number;
  state: SnapshotState;
}

export interface Bankruptcy {
  day: number;
  cash: number;
  debt: number;
  reason: string;
}

export interface GameState {
  schema: number;
  seed: number;
  rng: number;
  shopName: string;
  /** 0 から始まる連番ID */
  nextId: number;
  /** 状態バージョン（変更ごとに増加。ネットワーク同期の順序番号） */
  version: number;

  day: number;
  phase: DayPhase;
  /** その日の経過sim秒 */
  t: number;
  /** 営業開始からの経過秒 */
  openT: number;
  /** 拡張工事で休業中の残り日数 */
  closedForConstruction: number;

  money: number;
  arrears: Arrear[];
  loans: Loan[];
  transactions: Txn[];
  today: DayStats;
  history: DayReport[];
  cashAtDayStart: number;

  inventory: Lot[];
  deliveries: Delivery[];
  /** 当日の自動発注設定（itemId → 目標在庫） */
  autoOrder: Record<string, number>;

  equipment: Equipment[];
  seats: Seat[];
  bowls: Bowl[];
  dirt: DirtSpot[];
  /** 厨房全体の汚れ 0..1 */
  kitchenGrime: number;
  lostItems: LostItem[];
  layoutVersion: number;

  players: Player[];
  employees: Employee[];
  candidates: Candidate[];

  customers: Customer[];
  orders: Order[];
  /** 店外行列の顧客ID（先頭から） */
  queue: Id[];
  /** 店内の後ろ待ち（食券購入済み） */
  insideQueue: Id[];
  /** 来店の累積値（ポアソン到着の端数） */
  arrivalAcc: number;
  /** 当日の来店者を作る元になった常連IDの済みリスト */
  regularsVisitedToday: Id[];

  reputation: number;
  reviews: Review[];
  todayReviews: Review[];
  regulars: Regular[];

  career: CareerState;
  prices: Record<string, number>;
  /** 一時停止中のメニュー */
  pausedMenu: string[];

  notices: Notice[];
  bankruptcy: Bankruptcy | null;
  /** 共同経営でホストが切断し一時停止しているか */
  paused: boolean;
  /** チュートリアル中なら進み具合（ひとりプレイのみ） */
  tutorial?: TutorialState | null;
  /** 営業中のイベント（古いセーブにはない。sim/events.ts の ensureEvents で補う） */
  events?: ShopEvents;
  /** その日の仕込み開始時点の控え（爆発事故のリセット用。共同経営では配信しない） */
  prepSnapshot?: PrepSnapshot | null;
}
