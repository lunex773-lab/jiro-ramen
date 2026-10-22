// 監査記録（D1 の audit_log）。不正操作・重要イベントを残す（設計書 2.2 / 18.3）。
// 失敗してもゲームの処理は止めない。トークンなどの機密情報は detail に入れないこと。

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
  | 'checkpoint_corrupt';

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
    await db
      .prepare('INSERT INTO audit_log (ts, player_id, room_id, kind, detail) VALUES (?, ?, ?, ?, ?)')
      .bind(Date.now(), e.playerId ?? null, e.roomId ?? null, e.kind, detail)
      .run();
  } catch (err) {
    log('warn', 'audit_failed', { kind: e.kind, error: String(err) });
  }
}
