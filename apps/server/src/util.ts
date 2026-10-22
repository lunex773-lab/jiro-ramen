// 小さな共通関数（エンコード、乱数、入力チェック）。

const te = new TextEncoder();

export function utf8(s: string): Uint8Array<ArrayBuffer> {
  return te.encode(s) as Uint8Array<ArrayBuffer>;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, '0');
  return s;
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', utf8(text)));
}

/** 紛らわしい文字（0/O, 1/I/L）を除いた参加コード用の文字 */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;

export function randomRoomCode(): string {
  // 剰余の偏りを避けるため、256 未満で文字数の倍数に収まる値だけを使う
  const n = ROOM_CODE_ALPHABET.length;
  const limit = 256 - (256 % n);
  let out = '';
  while (out.length < ROOM_CODE_LENGTH) {
    for (const x of randomBytes(16)) {
      if (x >= limit) continue;
      out += ROOM_CODE_ALPHABET[x % n];
      if (out.length === ROOM_CODE_LENGTH) break;
    }
  }
  return out;
}

/** 参加コードの入力を正規化する（小文字・空白・ハイフンを許容）。不正なら null */
export function normalizeRoomCode(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 32) return null;
  const c = v.toUpperCase().replace(/[\s-]/g, '');
  if (c.length !== ROOM_CODE_LENGTH) return null;
  for (const ch of c) if (!ROOM_CODE_ALPHABET.includes(ch)) return null;
  return c;
}

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** 表示名の検証。前後の空白を除き、1〜20文字、制御文字なし */
export function cleanName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.normalize('NFC').trim();
  const len = [...s].length;
  if (len < 1 || len > 20) return null;
  // 制御文字・書式文字（双方向制御など）を含む名前は受け付けない
  if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(s)) return null;
  return s;
}

/** JSON.parse の reviver: プロトタイプ汚染につながるキーを取り除く */
export function safeReviver(key: string, value: unknown): unknown {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
  return value;
}

export function safeJsonParse(text: string): unknown {
  return JSON.parse(text, safeReviver);
}

/** 構造化ログ（wrangler tail / Workers Logs で読む）。トークンなどの機密情報は渡さないこと */
export function log(level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, msg, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
