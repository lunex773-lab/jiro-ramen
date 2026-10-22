// クライアントのバージョン確認（設計書 2.2「ゲームバージョンの確認」）。

/** "1.2.3"（末尾の -beta などは無視）を数値の配列にする。不正なら null */
export function parseVersion(v: unknown): number[] | null {
  if (typeof v !== 'string' || v.length > 32) return null;
  const m = /^v?(\d{1,6})(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?(?:[-+].*)?$/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/** a < b なら負、a = b なら 0、a > b なら正 */
export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** クライアントが最低バージョン以上か */
export function isClientSupported(clientVersion: unknown, minVersion: string): boolean {
  const c = parseVersion(clientVersion);
  const min = parseVersion(minVersion);
  if (!c) return false;
  if (!min) return true;
  return compareVersions(c, min) >= 0;
}
