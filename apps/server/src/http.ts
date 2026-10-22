// HTTP の共通処理: JSON 応答、エラー、CORS、サイズ制限つきの本文読み込み。

import { safeJsonParse } from './util';

/** 応答に変換されるエラー（status と機械可読なコードを持つ） */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly extra?: Record<string, unknown>,
    readonly headers?: Record<string, string>,
  ) {
    super(message ?? code);
  }
}

const BASE_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...headers } });
}

/** すでに JSON 文字列になっている本文をそのまま返す（大きなセーブの再変換を避ける） */
export function rawJson(text: string, status = 200): Response {
  return new Response(text, { status, headers: BASE_HEADERS });
}

/**
 * エラー応答。クライアント（apps/client/src/net/api.ts）は body.error をそのまま画面に出すので、
 * error には日本語のメッセージを入れ、機械可読な種別は code に入れる。
 */
export function errorResponse(e: HttpError): Response {
  return json({ error: e.message, code: e.code, ...(e.extra ?? {}) }, e.status, e.headers ?? {});
}

// ───────────────────────── CORS ─────────────────────────

export function allowedOrigins(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean),
  );
}

export function corsHeaders(origin: string | null, allowed: Set<string>): Record<string, string> {
  if (!origin || !allowed.has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

/** 応答に CORS ヘッダーを付ける（WebSocket の 101 応答は作り直せないのでそのまま返す） */
export function withCors(res: Response, cors: Record<string, string>): Response {
  if (res.status === 101 || Object.keys(cors).length === 0) {
    if (res.status !== 101 && !res.headers.has('Vary')) {
      // 許可されないオリジンでもキャッシュが混ざらないように Vary を付ける
      const r = new Response(res.body, res);
      r.headers.set('Vary', 'Origin');
      return r;
    }
    return res;
  }
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(cors)) r.headers.set(k, v);
  return r;
}

// ───────────────────────── 本文 ─────────────────────────

/** 本文を最大 limit バイトまで読み、JSON として解釈する。超えたら 413 */
export async function readJson(req: Request, limit: number): Promise<unknown> {
  const ct = req.headers.get('Content-Type') ?? '';
  if (!/^application\/json\b/i.test(ct)) throw new HttpError(415, 'unsupported_media_type', 'Content-Type: application/json で送信してください');
  const cl = req.headers.get('Content-Length');
  if (cl !== null && Number(cl) > limit) throw new HttpError(413, 'payload_too_large', `本文が大きすぎます（上限 ${limit} バイト）`);
  if (!req.body) throw new HttpError(400, 'bad_request', '本文がありません');
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, 'payload_too_large', `本文が大きすぎます（上限 ${limit} バイト）`);
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf);
  } catch {
    throw new HttpError(400, 'bad_request', 'UTF-8 として読めません');
  }
  try {
    return safeJsonParse(text);
  } catch {
    throw new HttpError(400, 'bad_json', 'JSON として読めません');
  }
}
