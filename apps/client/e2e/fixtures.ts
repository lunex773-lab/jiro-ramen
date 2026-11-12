// E2E の共通の準備: 偶然の爆発事故（初回は1日1.0%）を止める印をページに付ける（何日も営業するテストが偶然で失敗しないように）。
// 爆発のテストは開発用の欄から強制で起こすので影響しない。localStorage を消して読み直しても、ページを開くたびに付け直す
import { test as base, expect } from '@playwright/test';

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('jiro.test.noRandomAccident', '1');
      } catch {
        // 使えないときは何もしない
      }
    });
    await use(page);
  },
});

export { expect };
export type { Locator, Page } from '@playwright/test';
