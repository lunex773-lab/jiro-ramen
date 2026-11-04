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

/** 担当。prep（仕込み担当）はオーナーの判断で追加（拡張して杯数が増えたときに仕込みを専門にする） */
export type EmployeeRole = 'cook' | 'server' | 'cleaner' | 'prep';

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
export type StaffLogKind = 'late' | 'absent' | 'slack' | 'private' | 'postpone' | 'argue' | 'rude' | 'abandon' | 'calm' | 'promoted' | 'calledIn' | 'offWish' | 'quit';

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
  /** 見た目の番号（制服の色・頭・メガネ・ひげなど。採用の候補のときから変わらない）。古いセーブにはない → id から */
  look?: number;
  /**
   * 希望シフト: 出られる曜日（月=0 … 日=6。アルバイト。オーナーの判断 13）。希望外の日に入れると満足度が下がる。
   * 古いセーブ・社員にはない → 毎日出られる
   */
  wishDays?: boolean[];
  /** 短期バイト（その日だけ来る。精算のあと辞める） */
  temp?: boolean;
}

/**
 * 出退勤の動き（オーナーの指示: 歩いて入店し、キッチンにあいさつして手洗いしてから働き始め、「お疲れ様でした」と言って帰る。社員も含めて全員）
 *   arrive: 出勤（店の外から歩いて入る →「おはようございます！」→ 手洗い → 仕事）
 *   return: 休憩から戻る（歩いて入る →「戻りました！」→ 手洗い → 仕事）
 *   back:   勝手に持ち場を離れていた人が戻る（歩いて入る → 手洗い → 仕事。あいさつはしない）
 *   leave:  退勤（「お疲れ様でした！」→ 歩いて店の外へ）
 *   break:  休憩（「休憩いただきます！」→ 歩いて店の外へ）
 *   away:   勝手に持ち場を離れる（何も言わずに店の外へ）
 */
export type CommuteKind = 'arrive' | 'return' | 'back' | 'leave' | 'break' | 'away';

export interface Commute {
  kind: CommuteKind;
  phase: 'walkIn' | 'greet' | 'toSink' | 'wash' | 'walkOut';
  /** あいさつ・手洗いの残り秒 */
  t: number;
  /** 出退勤を始めた時刻（s.t。詰まったときの打ち切り用） */
  since: number;
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
    /** 失敗した仕事を再び選ぶまでの時刻（仕事キー → その日の sim時刻）。毎朝消す。古い状態にはない */
    failed?: Record<string, number>;
  };
  /** 今、店で働いている（休憩中・退勤後・出勤前は false） */
  presentToday: boolean;
  tasksDone: number;
  /** 曜日（月=0 … 日=6）ごとのシフト。アルバイトだけが使う（ない曜日は休み）。古いセーブにはない → 毎日・全時間 */
  shifts?: (ShiftDay | null)[];
  /**
   * 日にちごとのシフト（アルバイト。キーは営業日の番号。null はその日は休み）。曜日ごとのシフト（くりかえし）より優先する。
   * 過ぎた日は消す。古い状態にはない
   */
  dateShifts?: Record<string, ShiftDay | null>;
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
  /** セリフ。kind: 'greet' は出退勤のあいさつ、'event' は火事などのイベント（ないものは口論・言い返しなど） */
  say?: { text: string; until: number; kind?: 'greet' | 'event' } | null;
  /** 出退勤の途中（店の外から歩いて入る・あいさつ・手洗い／あいさつ・歩いて出る）。この間は仕事をしない。古い状態にはない */
  commute?: Commute | null;
  /** 疲れ（0〜1）。働いた日にたまり、休みの日に回復する（オーナーの判断 12）。古い状態にはない → 0 */
  fatigue?: number;
  /** この日から出勤できる（通常の採用は採用の2日後から。オーナーの判断 14 の補足）。古い状態にはない → いつでも */
  availableFrom?: number;
  /** 満足度（0〜1）。希望外の日の勤務・疲れで下がり、ふだんは基準へ戻る。低いと遅刻・欠勤が増え、辞めることがある。古い状態にはない → 基準 */
  morale?: number;
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
  /** 食べ終わって席にいる（団体の連れを待つ・居座り）。席は空かない */
  | 'afterMeal'
  /** 退店後に店の前でタバコを吸っている */
  | 'smoking'
  /** テレビ取材のカメラマン・スタッフ（注文しない。撮影・待機） */
  | 'crew'
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
  // 以下は第2版 Phase 3（sim/manners.ts）。古いセーブにはないので任意の項目
  /** 団体（1〜4人。1人なら付けない）。leader の客が団体全体の状態を持つ */
  group?: CustomerGroup | null;
  /** 食べ方の汚い客 */
  messy?: MessyState | null;
  /** 店外の喫煙 */
  smoke?: SmokeState | null;
  /** 迷惑を受けた出来事（トラブルの ID。同じトラブルで二度不満を数えない） */
  botheredBy?: Id[];
  /** イベントの吹き出し（第2版 13: 団体の会話・クレーム・トラブル・珍しい客・取材など。少し長く、縁を変える） */
  sayEvent?: boolean;
}

/** 団体客 */
export interface CustomerGroup {
  id: Id;
  size: number;
  leader: boolean;
  /** 全員がそろって席を待ち始めた時刻（隣り合った席を待つ上限に使う） */
  readySince?: number;
  /** 居座り（leader だけが持つ）。until を過ぎると自分から帰る */
  linger?: { until: number; startT: number; tried: LingerResponse[]; asked: number } | null;
  /** 次に会話する時刻（leader だけ） */
  chatAt?: number;
  /** 会話の続き（同じ会話を順に話す） */
  chatLine?: number;
  chatId?: number;
}

export type LingerResponse = 'polite' | 'explain' | 'request';

/** 食べ方の汚い客の状態 */
export interface MessyState {
  /** 次に汚す時刻（食事の経過秒） */
  next: number;
  /** 汚した回数 */
  count: number;
  /** 注意されて食べ方を改めた */
  calmed: boolean;
  /** 注意された回数（同じ人に何度も注意しない） */
  warned: number;
  /** このトラブルの ID（迷惑を受けた客の記録に使う） */
  troubleId: Id;
  /** 初めて周りに迷惑をかけた時刻（対応までの時間） */
  firstBotherT: number | null;
  /** 迷惑を受けた客と、下がった満足度（よい対応で一部を戻す） */
  victims: { id: Id; comfort: number; cleanliness: number }[];
}

/** 店外の喫煙 */
export interface SmokeState {
  until: number;
  troubleId: Id;
  /** 嫌な思いをした客 */
  annoyed: { id: Id; comfort: number }[];
  warned: boolean;
  /** 無視された回数 */
  ignored: number;
  nextCheck: number;
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

export type SpecialKind = 'critic' | 'couple_her' | 'couple_him' | 'ramen_lover' | 'youtuber' | 'tv_performer' | 'tv_camera' | 'tv_staff';

export interface CustomerSpecial {
  kind: SpecialKind;
  /** 発生したイベントの ID */
  eventId: Id;
  /** YouTuber の撮影 */
  film?: FilmState;
  /** テレビ取材の出演者（芸能人の ID）・食べ終えた */
  celebId?: string;
  ate?: boolean;
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
  | 'relocation'
  /** 出店（物件の初期費用） */
  | 'store'
  /** 広告費（共通市場の仕様書 4.3。オーナーの判断 14） */
  | 'advertising';

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
  /** 広告費（古い日報にはない → 0） */
  ads?: number;
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
  /** 品切れの内訳（食材・メニューごとの回数。原因の説明に使う）。古い日報にはない */
  stockoutItems?: Record<string, number>;
  /** 仕入れる食材の使用量（その日に使った分。「売れ行きに合わせる」自動発注に使う）。古い日報にはない */
  usedItems?: Record<string, number>;
  /** 店内外のトラブル（食べ方・居座り・喫煙・店員の口論など）と、そのうち対応したもの（第2版 10。古いセーブにはない） */
  troubles?: number;
  troublesHandled?: number;
}

export interface DayReport extends DayStats {
  day: number;
  /** 営業利益（利息を含めない。この版より前の日報は利息を引いた値） */
  operatingProfit: number;
  /** 純売上（売上 − 返金）。古い日報にはない */
  netSales?: number;
  /** 最終利益（営業利益 − 利息）。古い日報にはない → operatingProfit が最終利益 */
  finalProfit?: number;
  cashStart: number;
  cashEnd: number;
  reputation: number;
  reviews: number;
  avgSatisfaction: number;
  avgWait: number;
  /** プレイヤーがいない店の日報: 'manager' = 店長の営業（1日単位の計算）、'closed' = 休業（Phase 2-4） */
  managed?: 'manager' | 'closed';
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
export type EventKind = 'sns_buzz' | 'critic' | 'rare_couple' | 'rare_lover' | 'complaint_unreasonable' | 'explosion' | 'youtuber' | 'tv';

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
  /** この日から効く（ない場合はすぐ。テレビ取材の翌日・翌々日など） */
  fromDay?: number;
}

/** YouTuber の撮影（許可の有無と撮影の状態は別に持つ。第2版 11） */
export interface FilmState {
  /** 許可: asking = 確認中、permitted = 許可した、denied = 許可しなかった（時間切れを含む）、unasked = 聞かれなかった */
  permission: 'asking' | 'permitted' | 'denied' | 'unasked';
  /** 撮影: none = まだ、filming = 撮影中、done = 撮り終えた、stopped = やめさせた */
  filming: 'none' | 'filming' | 'done' | 'stopped';
  /** 許可なく撮影する気がある（抽選の結果。撮影が始まるのは席に着いてから） */
  sneaky: boolean;
  /** やめるよう伝えた回数 */
  warned: number;
  /** 試した対応（同じ対応は続けて選べない） */
  tried: string[];
  requestId: Id | null;
  troubleId: Id;
  /** 次に撮影のセリフを言う時刻 */
  talkAt: number;
}

/** ホストに判断を求める確認（撮影の許可・テレビ取材） */
export interface HostRequest {
  id: Id;
  kind: 'filming' | 'tv';
  /** 対象（YouTuber の客の ID、テレビ取材の ID） */
  subjectId: Id;
  text: string;
  askedAt: number;
  /** この時刻までに答えがなければ断ったことにする */
  timeoutAt: number;
}

/** 許可した撮影が完了したことによる SNS バズの確率の上昇（重ねられる。オーナー回答） */
export interface BuzzBoost {
  id: Id;
  /** 撮影した日。untilDay まで効く */
  day: number;
  untilDay: number;
  add: number;
}

/** テレビ取材の来店 */
export interface TvVisit {
  id: Id;
  day: number;
  show: string;
  /** 出演する芸能人（架空）の ID */
  celebs: string[];
  status: 'asking' | 'accepted' | 'declined' | 'done' | 'failed';
  requestId: Id | null;
  memberIds: Id[];
  /** 通常の客への影響（1人1回だけ） */
  troubleId: Id;
}

/** 芸能人のサイン（店の壁に飾る。収益への効果はない） */
export interface CelebritySign {
  celebId: string;
  name: string;
  show: string;
  /** 初めてもらった日 */
  day: number;
  /** 取材に来た回数（同じ人のサインは1枚で、回数を数える） */
  visits: number;
  lastDay: number;
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
  /** 燃えている設備と、燃え始めた時刻（予兆の経過秒）。燃え移った順。古い状態にはない */
  burning?: { id: Id; at: number }[];
  /** 次に燃え移る予兆の経過秒 */
  nextSpread?: number;
  /** 騒いだ回数（人の ID ごと。同じ人が何度も同じことを言わない） */
  panicked?: Record<Id, number>;
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
  // 以下は第2版 Phase 4（sim/media.ts）。古いセーブにはないので任意の項目
  /** ホストに判断を求めている確認 */
  requests?: HostRequest[];
  /** YouTuber が来る予定（開店時の抽選） */
  youtuberPlan?: { day: number; afterOpenT: number; forced?: boolean } | null;
  /** 許可した撮影による SNS バズの確率の上昇 */
  buzzBoosts?: BuzzBoost[];
  /** テレビ取材が来る予定・来ている取材 */
  tvPlan?: { day: number; afterOpenT: number; forced?: boolean } | null;
  tv?: TvVisit | null;
  /** 芸能人のサイン（壁に飾る順） */
  signs?: CelebritySign[];
}

/** 仕込み開始時点の状態の控え。日報・口コミ（営業中は変わらない）と、プレイヤー（接続で変わる）は入れない */
export type SnapshotState = Omit<GameState, 'prepSnapshot' | 'history' | 'reviews' | 'players' | 'company'>;

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
  /** 閉店のあと、従業員が帰るのを待ち始めた時刻（s.t。待っている間だけ） */
  closeWaitSince?: number;
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
  /**
   * 自動発注のしかた。manual: 目安の量まで（今まで）。sales: 最近の使用量に合わせて自動で量を決める（統合進化設計書 v2.1。店長の発注方針にも使う）。
   * 古い状態にはない → manual
   */
  autoOrderMode?: 'manual' | 'sales';

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
  /**
   * 会社（統合進化設計書 v2.1 Phase 2）。お金・借入・キャリアは会社のもの（GameState の money などをそのまま使う）。
   * プレイヤーがいる店の中身は GameState の店の部分（設備・従業員・在庫・評判・日報など）にあり、ほかの店は stores[].snapshot にある
   */
  company: CompanyState;
  /**
   * 共通市場の客の取り合いの倍率（店の id → 倍率。1 = 競合なし）。サーバーが日の始めに渡す（その日の条件）。
   * ひとりプレイ・共同経営では null（倍率なし）
   */
  marketDemand?: Record<string, number> | null;
}

// ───────────────────────── 会社と店舗（Phase 2） ─────────────────────────

/** 店を切り替えるときに入れ替える、店ごとの項目（GameState のキー。一覧は sim/company.ts の STORE_KEYS） */
export type StoreKey =
  | 'inventory'
  | 'deliveries'
  | 'autoOrder'
  | 'autoOrderMode'
  | 'equipment'
  | 'seats'
  | 'bowls'
  | 'dirt'
  | 'kitchenGrime'
  | 'lostItems'
  | 'employees'
  | 'candidates'
  | 'customers'
  | 'orders'
  | 'queue'
  | 'insideQueue'
  | 'arrivalAcc'
  | 'regularsVisitedToday'
  | 'reputation'
  | 'reviews'
  | 'todayReviews'
  | 'regulars'
  | 'prices'
  | 'pausedMenu'
  | 'history'
  | 'closedForConstruction';


/** プレイヤーがいない店の中身（店の段階 = 席の数の段階も店ごと） */
export type StoreSnapshot = Pick<GameState, StoreKey> & { stage: number };

/** 店の方針（店長がこの方針で営業する。Phase 2-4） */
export interface StorePolicy {
  /** 定価に対する価格の倍率 */
  priceMult: number;
  /** 自動発注 */
  orderMode: 'manual' | 'sales';
  /** 1日の修理費の上限（円）。超える故障は翌日に回す */
  repairCap: number;
  /** 定期メンテを予約するか */
  maintenance: boolean;
  /** 1日の広告費（円。開店のときに払う。古いデータにはない → 0） */
  adBudget?: number;
}

export interface StoreEntry {
  id: Id;
  name: string;
  /** 物件（data/properties.ts）。1店舗目は 'home' */
  propertyId: string;
  /** 開店した日 */
  openedDay: number;
  /** 店長（社員の id）。プレイヤーがいる店では空でもよい */
  managerId: Id | null;
  policy: StorePolicy;
  /** プレイヤーがいない店の中身。プレイヤーがいる店（activeStoreId）は null（中身は GameState にある） */
  snapshot: StoreSnapshot | null;
}

/** 会社の日報の、店ごとの行 */
export interface CompanyStoreLine {
  storeId: Id;
  name: string;
  /** プレイヤーがいた店か（いない店は店長の営業の計算） */
  played: boolean;
  netSales: number;
  operatingProfit: number;
  served: number;
  customers: number;
  reputation: number;
}

/** 会社の日報（店舗の合計。利息・借入の返済は会社のもの） */
export interface CompanyDayReport {
  day: number;
  stores: CompanyStoreLine[];
  netSales: number;
  operatingProfit: number;
  interest: number;
  finalProfit: number;
  served: number;
  cashEnd: number;
}

export interface CompanyState {
  /**
   * 店長がいなくても店主（プレイヤー）が自分で回す店（オンライン市場の本店）。店長の営業の計算では店主が店長の代わりになる。
   * ひとりプレイでは使わない（プレイヤーがいる店は細かいシミュレーション）
   */
  ownerStoreId?: Id;
  activeStoreId: Id;
  stores: StoreEntry[];
  /** 会社の日報（直近60日） */
  history: CompanyDayReport[];
}
