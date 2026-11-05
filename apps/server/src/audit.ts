// 監査記録（D1 の audit_log）。不正操作・重要イベントを残す（設計書 2.2 / 18.3）。
// 失敗してもゲームの処理は止めない。トークンなどの機密情報は detail に入れないこと。

import { ensureSchema } from './schema';
import { log } from './util';

export type AuditKind =
  | 'player_create'
  | 'room_create'
  | 'room_join'
  | 'room_leave'
  | 'room_end'
  | 'room_expire'
  | 'save_upload'
  | 'save_conflict'
  | 'save_delete'
  | 'room_save'
  | 'host_init'
  | 'host_init_rejected'
  | 'ws_rate_limited'
  | 'ws_bad_message'
  | 'ws_room_full'
  | 'action_rejected'
  | 'action_exception'
  | 'checkpoint_corrupt'
  | 'market_create'
  | 'market_join'
  /** 会社の引退（終わった市場・破産した会社） */
  | 'market_retire'
  /** 市場を消した（作った人。ほかの人の会社も消える） */
  | 'market_delete'
  /** 端末から届いた1日を受け取らなかった（前日の状態から説明できない）。detail に理由 */
  | 'market_day_rejected'
  /** 受け取ったが上限を超えた・食い違いがあった（順位から外す）。detail に理由 */
  | 'market_day_flagged'
  /** 0時から30分を過ぎて届いた日（無効） */
  | 'market_day_expired'
  /** 受け取ったが気になる点（不自然な値段など。人が見分けるための記録） */
  | 'market_day_watch';

export interface AuditEntry {
  kind: AuditKind;
  playerId?: string | null;
  roomId?: string | null;
  detail?: unknown;
}

export async function audit(db: D1Database, e: AuditEntry): Promise<void> {
  let detail: string | null = null;
  if (e.detail !== undefined) {
    detail = typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail);
    if (detail.length > 1000) detail = `${detail.slice(0, 1000)}…`;
  }
  try {
    await ensureSchema(db);
    await db
      .prepare('INSERT INTO audit_log (ts, player_id, room_id, kind, detail) VALUES (?, ?, ?, ?, ?)')
      .bind(Date.now(), e.playerId ?? null, e.roomId ?? null, e.kind, detail)
      .run();
  } catch (err) {
    log('warn', 'audit_failed', { kind: e.kind, error: String(err) });
  }
}
