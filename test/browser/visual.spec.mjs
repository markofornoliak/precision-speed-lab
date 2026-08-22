import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const baselinePath = path.resolve(here, '..', 'visual-baselines.json');
const baselines = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));

async function waitForIdle(page) {
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => window.__PSL_DIAGNOSTICS__?.getState())).toBe('IDLE');
  await normalizeDynamic(page);
}

async function normalizeDynamic(page) {
  await page.evaluate(() => {
    const server = document.querySelector('#serverStatus');
    const footer = document.querySelector('#footerInfo');
    const node = document.querySelector('#nodeInfo');
    if (server) server.textContent = 'Frankfurt ready';
    if (footer) footer.textContent = 'h2 · IPv6';
    if (node) node.textContent = 'fra-01 · IPv6';
  });
}

async function setVisualState(page, state) {
  await page.evaluate((visualState) => {
    const phase = document.querySelector('#phaseLabel');
    const description = document.querySelector('#phaseDescription');
    const speed = document.querySelector('#speedValue');
    const start = document.querySelector('#startBtn');
    const stop = document.querySelector('#stopBtn');
    const quality = document.querySelector('#qualitySection');
    const expert = document.querySelector('#expertDetails');
    const error = document.querySelector('#errorPanel');

    document.body.dataset.appState = visualState;
    quality.hidden = true;
    expert.hidden = true;
    expert.open = false;
    error.hidden = true;
    start.hidden = false;
    stop.hidden = true;

    if (visualState === 'DOWNLOADING') {
      phase.textContent = 'Download';
      description.textContent = 'Download · основной прогон 2 из 3';
      speed.textContent = '934.2';
      start.hidden = true;
      stop.hidden = false;
    } else if (visualState === 'UPLOADING') {
      phase.textContent = 'Upload';
      description.textContent = 'Upload · основной прогон 2 из 3';
      speed.textContent = '487.6';
      start.hidden = true;
      stop.hidden = false;
    } else if (visualState === 'COMPLETE') {
      phase.textContent = 'Complete';
      description.textContent = 'Опубликован только валидированный финальный результат';
      document.querySelector('#downloadValue').textContent = '934.2';
      document.querySelector('#uploadValue').textContent = '487.6';
      document.querySelector('#pingValue').textContent = '12.4';
      document.querySelector('#jitterValue').textContent = '1.8';
      document.querySelector('#loadedDownValue').textContent = '26.7';
      document.querySelector('#loadedUpValue').textContent = '31.2';
      document.querySelector('#probeLossValue').textContent = '0.0%';
      document.querySelector('#stabilityDownValue').textContent = '3.7%';
      document.querySelector('#stabilityUpValue').textContent = '4.2%';
      document.querySelector('#bufferbloatValue').textContent = '+18.8 ms';
      quality.hidden = false;
      expert.hidden = false;
      start.textContent = 'Повторить тест';
    } else if (visualState === 'ERROR') {
      phase.textContent = 'Measurement unavailable';
      description.textContent = 'Неполный результат не публикуется как финальный';
      error.hidden = false;
      document.querySelector('#errorTitle').textContent = 'Measurement node is busy';
      document.querySelector('#errorMessage').textContent = 'The selected node cannot accept this measurement cleanly right now.';
      document.querySelector('#errorAction').textContent = 'Retry after a short pause.';
      document.querySelector('#errorValidity').textContent = 'Частичный результат не считается финальным.';
      start.textContent = 'Повторить тест';
    }
  }, state);
}

async function visualHash(page, name) {
  await page.evaluate(() => document.fonts?.ready);
  const image = await page.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide' });
  const hash = crypto.createHash('sha256').update(image).digest('hex');
  if (process.env.VISUAL_UPDATE === '1') {
    console.log(`VISUAL_BASELINE ${name} ${hash}`);
    return;
  }
  expect(baselines[name], `missing visual baseline for ${name}`).toBeTruthy();
  expect(hash, `visual regression: ${name}`).toBe(baselines[name]);
}

test('visual idle desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await waitForIdle(page);
  await visualHash(page, 'idle-desktop');
});

test('visual running download', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await waitForIdle(page);
  await setVisualState(page, 'DOWNLOADING');
  await visualHash(page, 'running-download');
});

test('visual running upload', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await waitForIdle(page);
  await setVisualState(page, 'UPLOADING');
  await visualHash(page, 'running-upload');
});

test('visual completed desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await waitForIdle(page);
  await setVisualState(page, 'COMPLETE');
  await visualHash(page, 'complete-desktop');
});

test('visual idle mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await waitForIdle(page);
  await visualHash(page, 'idle-mobile');
});

test('visual completed mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await waitForIdle(page);
  await setVisualState(page, 'COMPLETE');
  await visualHash(page, 'complete-mobile');
});

test('visual error state', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await waitForIdle(page);
  await setVisualState(page, 'ERROR');
  await visualHash(page, 'error-desktop');
});
