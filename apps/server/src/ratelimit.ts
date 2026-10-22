// トークンバケット方式のレート制限。
//
// - WebSocket のメッセージ: Durable Object の中で接続ごとに TokenBucket を持つ（ルーム内で正確に効く）。
// - HTTP API: Worker の isolate 内のメモリで、IP やプレイヤーごとに KeyedLimiter を持つ。
//   isolate はデータセンターごと・負荷に応じて複数存在するため、全体での厳密な上限ではなく「乱用の抑止」が目的。
//   Durable Object を経由しないので追加の料金や遅延がない。より厳密にしたい場合は
//   Workers の Rate Limiting バインディングか、キーごとの Durable Object に置き換える（docs/CLOUDFLARE_SETUP.md）。

export class TokenBucket {
  tokens: number;
  private last: number;

  /**
   * @param capacity 一度に使える最大数（バースト）
   * @param refillPerSec 1秒あたりの回復量
   */
  constructor(
    readonly capacity: number,
    readonly refillPerSec: number,
    now = Date.now(),
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  private refill(now: number): void {
    const dt = Math.max(0, now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + dt * this.refillPerSec);
  }

  /** cost 分を消費できれば true */
  take(cost = 1, now = Date.now()): boolean {
    this.refill(now);
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  /** 次に cost 分が使えるまでの秒数 */
  retryAfter(cost = 1, now = Date.now()): number {
    this.refill(now);
    if (this.tokens >= cost) return 0;
    return Math.ceil((cost - this.tokens) / this.refillPerSec);
  }
}

/** キー（IP・プレイヤーID）ごとのトークンバケット。古いキーから捨てて上限を守る */
export class KeyedLimiter {
  private buckets = new Map<string, TokenBucket>();

  constructor(
    readonly capacity: number,
    readonly refillPerSec: number,
    readonly maxKeys = 10_000,
  ) {}

  /** 許可なら 0、拒否なら再試行までの秒数 */
  check(key: string, cost = 1, now = Date.now()): number {
    let b = this.buckets.get(key);
    if (b) {
      // 最近使ったキーを末尾へ（Map は挿入順なので LRU として使える）
      this.buckets.delete(key);
    } else {
      b = new TokenBucket(this.capacity, this.refillPerSec, now);
      if (this.buckets.size >= this.maxKeys) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
    }
    this.buckets.set(key, b);
    if (b.take(cost, now)) return 0;
    return Math.max(1, b.retryAfter(cost, now));
  }
}

/** HTTP API の制限値（isolate ごと） */
export const HTTP_LIMITS = {
  /** 匿名アカウント作成: IP ごとに 10 回まで、6秒に1回回復 */
  auth: new KeyedLimiter(10, 1 / 6),
  /** API 全般: IP ごとに 120 回まで、毎秒 2 回回復 */
  api: new KeyedLimiter(120, 2),
  /** クラウドセーブの書き込み: プレイヤーごとに 10 回まで、6秒に1回回復 */
  save: new KeyedLimiter(10, 1 / 6),
  /** ルーム作成・参加・退出: プレイヤーごとに 20 回まで、3秒に1回回復 */
  session: new KeyedLimiter(20, 1 / 3),
  /** WebSocket 接続: IP ごとに 30 回まで、2秒に1回回復 */
  ws: new KeyedLimiter(30, 1 / 2),
};

/** WebSocket メッセージの制限（接続ごと）: 毎秒 40、バースト 80。move も数える */
export const WS_MSG_RATE = { capacity: 80, refillPerSec: 40 };

/** メッセージ種別ごとの消費量（重い処理ほど多く消費する） */
export const WS_MSG_COST: Record<string, number> = {
  hostInit: 10,
  resync: 10,
  save: 10,
};
