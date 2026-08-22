import { test, expect } from '@playwright/test';

async function preparePage(page) {
  await page.addInitScript(() => {
    window.__PSL_UNHANDLED_REJECTIONS__ = [];
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      window.__PSL_UNHANDLED_REJECTIONS__.push(String(reason?.message || reason || 'unknown rejection'));
      event.preventDefault();
    });
  });
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => window.__PSL_DIAGNOSTICS__?.getState())).toBe('READY');

  const settings = page.locator('#settingsDetails');
  if (!(await settings.getAttribute('open'))) await settings.locator('summary').click();
  await page.getByRole('switch').uncheck();
  await page.getByText('1 MB', { exact: true }).click();
  await page.locator('#connections').selectOption('1');
}

async function expectCleanCancellation(page, phase) {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.getByRole('button', { name: 'Начать тест' }).click();
  await expect.poll(
    () => page.evaluate(() => window.__PSL_DIAGNOSTICS__.getState()),
    { timeout: 40_000 },
  ).toBe(phase);
  await page.getByRole('button', { name: 'Остановить' }).click();
  await expect.poll(() => page.evaluate(() => window.__PSL_DIAGNOSTICS__.getState())).toBe('CANCELLED');
  await page.waitForTimeout(250);

  expect(pageErrors).toEqual([]);
  expect(await page.evaluate(() => window.__PSL_UNHANDLED_REJECTIONS__)).toEqual([]);
  expect(await page.evaluate(() => window.__PSL_DIAGNOSTICS__.getFinalResult())).toBeNull();
  expect(await page.evaluate(() => window.__PSL_DIAGNOSTICS__.getPendingControllerCount())).toBe(0);
}

test('download cancellation settles concurrent loaded-latency sampler without rejection', async ({ page }) => {
  await page.route('**/api/download?**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 450));
    try { await route.continue(); } catch {}
  });
  await preparePage(page);
  await expectCleanCancellation(page, 'DOWNLOAD');
});

test('upload cancellation settles concurrent loaded-latency sampler without rejection @safari', async ({ page }) => {
  await page.route('**/api/upload?**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try { await route.continue(); } catch {}
  });
  await preparePage(page);
  await expectCleanCancellation(page, 'UPLOAD');
});
