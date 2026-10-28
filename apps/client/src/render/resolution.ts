// 描画の解像度を端末の速さに合わせて上げ下げする判定（WebGL を使わないので単体テストできる）。
// 2秒ごとの平均が 45fps を下回ったら 0.25 下げ、57fps 以上が 6 秒続いたら（最後に下げてから 20 秒たっていれば）0.25 上げる。

export class ResolutionGovernor {
  /** 今の倍率 */
  ratio: number;
  private acc = 0;
  private n = 0;
  private good = 0;
  private lastDrop = -1e9;

  constructor(
    /** 画質の設定による上限 */
    private cap: () => number,
    private min = 0.75,
  ) {
    this.ratio = cap();
  }

  /** 上限が変わった（画質の設定を変えた）: 上限から測り直す */
  reset(): void {
    this.ratio = this.cap();
    this.acc = 0;
    this.n = 0;
    this.good = 0;
  }

  /**
   * 描いたフレームごとに、前のフレームからの実際の間隔（秒）と今の時刻（秒）を渡す。
   * 倍率を変えたら true を返す。
   */
  sample(interval: number, now: number): boolean {
    // 裏に回っていた間などの長い間隔は数えない
    if (!(interval > 0) || interval > 0.25) return false;
    this.acc += interval;
    this.n++;
    if (this.acc < 2) return false;
    const avg = this.acc / this.n;
    this.acc = 0;
    this.n = 0;
    const cap = this.cap();
    if (this.ratio > cap) {
      this.ratio = cap;
      return true;
    }
    if (avg > 1 / 45 && this.ratio > this.min) {
      this.ratio = Math.max(this.min, this.ratio - 0.25);
      this.lastDrop = now;
      this.good = 0;
      return true;
    }
    if (avg < 1 / 57) {
      this.good++;
      if (this.good >= 3 && this.ratio < cap && now - this.lastDrop > 20) {
        this.ratio = Math.min(cap, this.ratio + 0.25);
        this.good = 0;
        return true;
      }
    } else this.good = 0;
    return false;
  }
}
