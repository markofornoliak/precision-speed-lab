import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function waitForReady(page) {
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => window.__PSL_DIAGNOSTICS__?.getState())).toBe('READY');
  await expect(page.getByRole('button', { name: 'Начать тест' })).toBeEnabled();
}

async function chooseFastDeterministicMode(page) {
  const settings = page.locator('#settingsDetails');
  if (!(await settings.getAttribute('open'))) await settings.locator('summary').click();
  await page.getByRole('switch').uncheck();
  await page.getByText('1 MB', { exact: true }).click();
  await expect(page.getByRole('radio', { name: '1 MB', exact: true })).toBeChecked();
  await page.locator('#connections').selectOption('1');
}

async function expectNoSeriousA11yViolations(page) {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact));
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
}

test('ready instrument is nearly empty, keyboard operable and accessible @safari', async ({ page }) => {
  await waitForReady(page);
  await expect(page.locator('#downloadValue')).toHaveText('—');
  await expect(page.locator('#uploadValue')).toHaveText('—');
  await expect(page.locator('#pingValue')).toHaveText('—');
  await expect(page.locator('#qualitySection')).toBeHidden();
  await expect(page.locator('#expertDetails')).toBeHidden();
  await expect(page.locator('.live-readout')).toBeHidden();

  const start = page.getByRole('button', { name: 'Начать тест' });
  await start.focus();
  await expect(start).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#settingsDetails > summary')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#settingsDetails')).toHaveAttribute('open', '');
  await expect(page.getByRole('radio', { name: 'Auto', exact: true })).toBeChecked();
  await expect(page.getByRole('switch')).toBeChecked();
  await expectNoSeriousA11yViolations(page);
});

test('public lifecycle follows the deliberate phase sequence', async ({ page }) => {
  await waitForReady(page);
  await chooseFastDeterministicMode(page);
  const observed = [];
  await page.exposeFunction('capturePslState', (value) => observed.push(value));
  await page.evaluate(() => {
    let previous = window.__PSL_DIAGNOSTICS__.getState();
    window.capturePslState(previous);
    window.__PSL_STATE_WATCH__ = window.setTimeout(function watch() {
      const current = window.__PSL_DIAGNOSTICS__.getState();
      if (current !== previous) {
        previous = current;
        window.capturePslState(current);
      }
      if (!['COMPLETE', 'CANCELLED', 'ERROR'].includes(current)) window.__PSL_STATE_WATCH__ = window.setTimeout(watch, 15);
    }, 15);
  });
  await page.getByRole('button', { name: 'Начать тест' }).click();
  await expect.poll(() => page.evaluate(() => window.__PSL_DIAGNOSTICS__.getState()), { timeout: 40_000 }).toBe('COMPLETE');
  await page.waitForTimeout(50);
  expect(observed[0]).toBe('READY');
  for (const required of ['PREPARING', 'LATENCY', 'DOWNLOAD', 'UPLOAD', 'ANALYZING', 'COMPLETE']) {
    expect(observed, `missing ${required} in ${observed.join(' -> ')}`).toContain(required);
  }
  expect(observed.some((state) => /CALIBRAT|WARM|DOWNLOADING|UPLOADING|CANCELLING/.test(state))).toBe(false);
});

test('Stop discards partial data instead of promoting a result @safari', async ({ page }) => {
  await waitForReady(page);
  await page.getByRole('button', { name: 'Начать тест' }).click();
  await expect.poll(() => page.evaluate(() => window.__PSL_DIAGNOSTICS__.getState())).toBe('LATENCY');
  await expect(page.getByRole('button', { name: 'Остановить' })).toBeVisible();
  await page.getByRole('button', { name: 'Остановить' }).click();
  await expect.poll(() => page.evaluate(() => window.__PSL_DIAGNOSTICS__.getState())).toBe('CANCELLED');
  await expect(page.locator('#downloadValue')).toHaveText('—');
  await expect(page.locator('#uploadValue')).toHaveText('—');
  await expect(page.locator('#pingValue')).toHaveText('—');
  expect(await page.evaluate(() => window.__PSL_DIAGNOSTICS__.getFinalResult())).toBeNull();
  await expect(page.locator('#measurementNotice')).toContainText('Частичные метрики отброшены');
  await expect(page.getByRole('button', { name: 'Повторить тест' })).toBeFocused();
  const before = await page.evaluate(() => window.__PSL_DIAGNOSTICS__.getTelemetryRenderCount());
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => window.__PSL_DIAGNOSTICS__.getTelemetryRenderCount());
  expect(after).toBe(before);
  expect(await page.evaluate(() => window.__PSL_DIAGNOSTICS__.getPendingControllerCount())).toBe(0);
});

test('cancellation during download aborts the run and leaves no final metrics', async ({ page }) => {
  await page.route('**/api/download?**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 450));
    try { await route.continue(); } catch {}
  });
  await waitForReady(page);
  await chooseFastDeterministicMode(page);
  await page.getByRole('button', { name: 'Начать тест' }).click();
  await expect.poll(() => page.evaluate(() => window.__PSL_DIAGNOSTICS__.getState()), { timeout: 30_000 }).toBe('DOWNLOAD');
  await page.getByRole('button', { name: 'Остановить' }).click();
  await expect.poll(() => page.evaluate(() => window.__PSL_DIAGNOSTICS__.getState())).toBe('CANCELLED');
  expect(await page.evaluate(() => window.__PSL_DIAGNOSTICS__.getFinalResult())).toBeNull();
  await expect(page.locator('#downloadValue')).toHaveText('—');
});

test('cancellation during upload aborts the run and leaves no final metrics', async ({ page }) => {
  let releaseUpload;
  const uploadGate = new Promise((resolve) => { releaseUpload = resolve; });
  await page.route('**/api/upload**', async (route) => {
    await uploadGate;
    try { await route.continue(); } catch {}
  });
  await waitForReady(page);
  await chooseFastDeterministicMode(page);
  await page.getByRole('button', { name: 'Начать тест' }).click();
  await expect.poll(() => page.evaluate(() => window.__PSL_DIAGNOSTICS__.getState()), { timeout: 35_000 }).toBe('UPLOAD');
  await page.getByRole('button', { name: 'Остановить' }).click();
  releaseUpload();
  await expect.poll(() => page.evaluate(() => window.__PSL_DIAGNOSTICS__.getState())).toBe('CANCELLED');
  expect(await page.evaluate(() => window.__PSL_DIAGNOSTICS__.getFinalResult())).toBeNull();
  await expect(page.locator('#uploadValue')).toHaveText('—');
});

test('completed result promotes immutable evidence while diagnostics stay collapsed @safari', async ({ page }) => {
  await waitForReady(page);
  await chooseFastDeterministicMode(page);
  await page.getByRole('button', { name: 'Начать тест' }).click();
  await expect.poll(() => page.evaluate(() => window.__PSL_DIAGNOSTICS__.getState()), { timeout: 40_000 }).toBe('COMPLETE');
  await expect(page.locator('#downloadValue')).not.toHaveText('—');
  await expect(page.locator('#uploadValue')).not.toHaveText('—');
  await expect(page.locator('#pingValue')).not.toHaveText('—');
  await expect(page.locator('#qualitySection')).toBeVisible();
  await expect(page.locator('#qualitySection')).not.toHaveAttribute('open', '');
  await expect(page.locator('#expertDetails')).toBeVisible();
  await expect(page.locator('#expertDetails')).not.toHaveAttribute('open', '');

  const immutability = await page.evaluate(() => {
    const result = window.__PSL_DIAGNOSTICS__.getFinalResult();
    return {
      root: Object.isFrozen(result),
      download: Object.isFrozen(result.download),
      values: Object.isFrozen(result.download.values),
      raw: Object.isFrozen(result.download.summary.raw),
    };
  });
  expect(immutability).toEqual({ root: true, download: true, values: true, raw: true });
  await page.locator('#expertDetails > summary').click();
  await expect(page.locator('#downRunsValue')).toContainText('/');
  await expect(page.locator('#uploadTimingValue')).not.toHaveText('—');
  await expect(page.locator('#chartSummary')).toContainText('не сглаживает');
  await expectNoSeriousA11yViolations(page);
});

test('Canvas is absent from active measurement work and renders only on demand', async ({ page }) => {
  await waitForReady(page);
  await chooseFastDeterministicMode(page);
  expect(await page.evaluate(() => window.__PSL_DIAGNOSTICS__.getChartRenderCount())).toBe(0);
  await page.getByRole('button', { name: 'Начать тест' }).click();
  await expect.poll(() => page.evaluate(() => window.__PSL_DIAGNOSTICS__.getState())).toBe('LATENCY');
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.__PSL_DIAGNOSTICS__.getChartRenderCount())).toBe(0);
  await page.getByRole('button', { name: 'Остановить' }).click();
  await expect.poll(() => page.evaluate(() => window.__PSL_DIAGNOSTICS__.getState())).toBe('CANCELLED');
});

test('measurement is invalidated if lifecycle reports background suspension', async ({ page }) => {
  await waitForReady(page);
  await page.getByRole('button', { name: 'Начать тест' }).click();
  await expect.poll(() => page.evaluate(() => window.__PSL_DIAGNOSTICS__.getState())).toBe('LATENCY');
  await page.evaluate(() => document.dispatchEvent(new Event('freeze')));
  await expect.poll(() => page.evaluate(() => window.__PSL_DIAGNOSTICS__.getState())).toBe('ERROR');
  await expect(page.locator('#errorTitle')).toHaveText('Measurement interrupted');
  await expect(page.locator('#errorValidity')).toContainText('не считается финальным');
  expect(await page.evaluate(() => window.__PSL_DIAGNOSTICS__.getFinalResult())).toBeNull();
});

test('structured backend error gives a useful recovery path', async ({ page }) => {
  await page.route('**/api/capabilities', async (route) => {
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Server unavailable' }) });
  });
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => window.__PSL_DIAGNOSTICS__?.getState())).toBe('ERROR');
  await expect(page.locator('#errorTitle')).toHaveText('Measurement service unavailable');
  await expect(page.locator('#errorAction')).toContainText('retry', { ignoreCase: true });
  await expect(page.getByRole('button', { name: 'Повторить подключение' })).toBeEnabled();
});

test('320px and 390px layouts contain extreme instrument values and Gbps units', async ({ page }) => {
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await waitForReady(page);
    await page.evaluate(() => {
      document.body.dataset.appState = 'COMPLETE';
      document.querySelector('#downloadValue').textContent = '9876.4';
      document.querySelector('#uploadValue').textContent = '10.2';
      document.querySelector('#uploadUnit').textContent = 'Gbps';
      document.querySelector('#pingValue').textContent = '1247';
      document.querySelector('#qualitySection').hidden = false;
      document.querySelector('#expertDetails').hidden = false;
    });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `horizontal overflow at ${viewport.width}px`).toBeLessThanOrEqual(0);
    for (const selector of ['#downloadValue', '#uploadValue', '#pingValue']) {
      const box = await page.locator(selector).boundingBox();
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    }
  }
});

test('initialization produces no uncaught exceptions or excessive static requests', async ({ page }) => {
  const errors = [];
  const urls = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => urls.push(new URL(request.url()).pathname));
  await waitForReady(page);
  expect(errors).toEqual([]);
  const staticAssets = urls.filter((pathname) => ['/', '/styles.css', '/app.js', '/measurement-core.js', '/ui-core.js'].includes(pathname));
  expect(new Set(staticAssets).size).toBeLessThanOrEqual(5);
});
