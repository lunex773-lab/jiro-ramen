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
  reliability: number;
}

export interface EmployeeProfile {
  name: string;
  role: EmployeeRole;
  skills: EmployeeSkills;
  wage: number;
  hireFee: number;
  experience: number;
}

export type EmployeeAiState = 'idle' | 'moving' | 'working' | 'waiting' | 'absent' | 'stuck';

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
  presentToday: boolean;
  tasksDone: number;
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
}

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
}
