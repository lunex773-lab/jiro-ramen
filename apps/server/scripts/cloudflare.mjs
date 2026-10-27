// GitHub Actions から Cloudflare を操作する補助スクリプト（Cloudflare API を直接呼ぶ）。
//
//   node apps/server/scripts/cloudflare.mjs prepare   # デプロイの前処理（.github/workflows/deploy-server.yml）
//   node apps/server/scripts/cloudflare.mjs url       # 共同経営サーバーの URL を決める（.github/workflows/pages.yml）
//
// prepare:
//   1. wrangler.jsonc の D1（database_name）をアカウントから探し、なければ作る
//   2. この実行環境の wrangler.jsonc の database_id を実際の ID に書き換える（リポジトリには書き戻さない）
//   3. Worker に SESSION_SECRET がなければランダムな値を作り、`wrangler deploy --secrets-file` 用のファイルに書く
//      （登録済みなら変えない）
// url:
//   VITE_SERVER_URL があればそれを、なければ https://<Worker 名>.<workers.dev のサブドメイン>.workers.dev を出す。
//   鍵が未登録のときは空（共同経営なし＝オフラインのみのビルド）
//
// 必要な環境変数: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID（リポジトリの Secrets。docs/CLOUDFLARE_SETUP.md）
// 結果は GITHUB_OUTPUT に key=value で書く（GitHub Actions の外では標準出力）。
// 公開リポジトリの実行ログは誰でも読めるので、D1 の ID・秘密鍵・メールアドレスはログで伏せる。

import { randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG_PATH = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url));
const PLACEHOLDER_DB_ID = '00000000-0000-0000-0000-000000000000';
// wrangler と同じ環境変数で API の向き先を変えられる（スクリプトの確認用）
const API = (process.env.CLOUDFLARE_API_BASE_URL || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');
const TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? '';
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
// Worker がまだない（一度もデプロイしていない）ときのエラーコード（wrangler の isWorkerNotFoundError と同じ）
const WORKER_NOT_FOUND = [10007, 10090];

/** JSONC（// と /* *\/ のコメント、末尾のカンマ）を読む。文字列の中の // はそのまま */
function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new Error('wrangler.jsonc のコメントが閉じていません');
      i = end + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function output(key, value) {
  const line = `${key}=${value}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
  else process.stdout.write(line);
}

/** GitHub Actions のログに出さない */
function mask(value) {
  if (value && process.env.GITHUB_ACTIONS) console.log(`::add-mask::${value}`);
}

async function cf(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) {
    const errors = body?.errors ?? [];
    const detail = errors.map((e) => `[${e.code}] ${e.message}`).join(' ');
    const shown = ACCOUNT ? path.replace(ACCOUNT, '<account>') : path;
    const err = new Error(`Cloudflare API ${init.method ?? 'GET'} ${shown} → ${res.status} ${detail}`);
    err.codes = errors.map((e) => e.code);
    throw err;
  }
  return body.result;
}

function requireKeys() {
  if (!TOKEN || !ACCOUNT) throw new Error('CLOUDFLARE_API_TOKEN と CLOUDFLARE_ACCOUNT_ID が必要です（リポジトリの Secrets に登録）');
}

async function prepare() {
  requireKeys();
  // トークンに「ユーザーの詳細」の読み取り権限があると、wrangler がエラー時にメールアドレスを表示することがある
  await cf('/user')
    .then((u) => mask(u?.email))
    .catch(() => {});

  const text = readFileSync(CONFIG_PATH, 'utf8');
  const config = parseJsonc(text);
  const workerName = config.name;
  const d1 = (config.d1_databases ?? []).find((d) => d.binding === 'DB');
  if (!workerName || !d1?.database_name) throw new Error('wrangler.jsonc に name と D1（binding: DB）の database_name が必要です');

  // 1. D1
  const listed = await cf(`/accounts/${ACCOUNT}/d1/database?name=${encodeURIComponent(d1.database_name)}&per_page=100`);
  let id = listed.find((d) => d.name === d1.database_name)?.uuid;
  if (id) {
    console.log(`D1「${d1.database_name}」を使います`);
  } else {
    id = (await cf(`/accounts/${ACCOUNT}/d1/database`, { method: 'POST', body: JSON.stringify({ name: d1.database_name }) })).uuid;
    console.log(`D1「${d1.database_name}」がなかったので作りました（テーブルは Worker が最初の要求で作ります）`);
  }
  mask(id);

  // 2. database_id
  if (d1.database_id === PLACEHOLDER_DB_ID) {
    const next = text.replace(`"database_id": "${PLACEHOLDER_DB_ID}"`, `"database_id": "${id}"`);
    const written = (parseJsonc(next).d1_databases ?? []).find((d) => d.binding === 'DB');
    if (written?.database_id !== id) throw new Error('wrangler.jsonc の database_id を書き換えられませんでした');
    writeFileSync(CONFIG_PATH, next);
    console.log('この実行環境の wrangler.jsonc に D1 の ID を入れました（リポジトリには書き戻しません）');
  } else if (d1.database_id !== id) {
    throw new Error(`wrangler.jsonc の database_id が、アカウントの D1「${d1.database_name}」の ID と違います`);
  }

  // 3. SESSION_SECRET
  let hasSecret = false;
  try {
    const secrets = await cf(`/accounts/${ACCOUNT}/workers/scripts/${encodeURIComponent(workerName)}/secrets`);
    hasSecret = secrets.some((s) => s.name === 'SESSION_SECRET');
  } catch (e) {
    if (!e.codes?.some((c) => WORKER_NOT_FOUND.includes(c))) throw e;
    console.log(`Worker「${workerName}」はまだありません（このデプロイで作られます）`);
  }
  if (hasSecret) {
    console.log('SESSION_SECRET は登録済みなので変えません');
    output('secrets_file', '');
  } else {
    const value = randomBytes(32).toString('base64url');
    mask(value);
    const file = join(process.env.RUNNER_TEMP || tmpdir(), 'jiro-server-secrets.json');
    writeFileSync(file, JSON.stringify({ SESSION_SECRET: value }), { mode: 0o600 });
    console.log('SESSION_SECRET がないので、ランダムな値を作ってデプロイと一緒に登録します（値は表示しません）');
    output('secrets_file', file);
  }
}

async function serverUrl() {
  const fixed = (process.env.VITE_SERVER_URL ?? '').trim();
  if (fixed) {
    console.log('リポジトリの Variables の VITE_SERVER_URL を使います');
    return output('url', fixed);
  }
  if (!TOKEN || !ACCOUNT) {
    console.log('Cloudflare の鍵が未登録なので、共同経営サーバーなし（オフラインのみ）でビルドします');
    return output('url', '');
  }
  const { name } = parseJsonc(readFileSync(CONFIG_PATH, 'utf8'));
  try {
    const { subdomain } = await cf(`/accounts/${ACCOUNT}/workers/subdomain`);
    const url = `https://${name}.${subdomain}.workers.dev`;
    console.log(`共同経営サーバー: ${url}`);
    output('url', url);
  } catch (e) {
    // workers.dev のサブドメインが未登録（初回のサーバーのデプロイで登録される）
    if (!e.codes?.some((c) => WORKER_NOT_FOUND.includes(c))) throw e;
    console.log('::notice title=workers.dev のサブドメインが未登録です::サーバーのデプロイ後にもう一度実行すると、共同経営サーバーの URL が入ります');
    output('url', '');
  }
}

const command = process.argv[2];
try {
  if (command === 'prepare') await prepare();
  else if (command === 'url') await serverUrl();
  else throw new Error('使い方: node apps/server/scripts/cloudflare.mjs prepare|url');
} catch (e) {
  console.log(process.env.GITHUB_ACTIONS ? `::error::${e.message}` : e.message);
  process.exit(1);
}
