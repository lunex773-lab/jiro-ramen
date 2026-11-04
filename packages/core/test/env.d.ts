// テストでのみ console を使う
declare const console: { log: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
// 経済の測定（test/econ）で使う最小限の Node の型（@types/node を足さない）
declare const process: { env: Record<string, string | undefined> };
declare module 'node:fs' {
  export function writeFileSync(path: string, data: string): void;
}
