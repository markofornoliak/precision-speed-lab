import { test, expect } from '@playwright/test';

const VIEWPORTS = [
  { name: '320x568', width: 320, height: 568 },
  { name: '360x800', width: 360, height: 800 },
  { name: '375x812', width: 375, height: 812 },
  { name: '390x844', width: 390, height: 844 },
  { name: '393x852', width: 393, height: 852 },
  { name: '430x932', width: 430, height: 932 },
  { name: 'tablet-portrait', width: 768, height: 1024 },
  { name: 'tablet-landscape', width: 1024, height: 768 },
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'ultrawide', width: 2560, height: 1080 },
];

async function waitForReady(page) {
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => window.__PSL_DIAGNOSTICS__?.getState())).toBe('READY');
}

async function injectUglyCompletedValues(page) {
  await page.evaluate(() => {
    document.body.dataset.appState = 'COMPLETE';
    document.querySelector('#downloadValue').textContent = '9876.4';
    document.querySelector('#uploadValue').textContent = '10.2';
    document.querySelector('#uploadUnit').textContent = 'Gbps';
    document.querySelector('#pingValue').textContent = '1247';
    document.querySelector('#jitterValue').textContent = '987.6';
    document.querySelector('#loadedDownValue').textContent = '1247';
    document.querySelector('#loadedUpValue').textContent = '1500';
    document.querySelector('#probeLossValue').textContent = '100.0%';
    document.querySelector('#stabilityDownValue').textContent = '123.4%';
    document.querySelector('#stabilityUpValue').textContent = '123.4%';
    document.querySelector('#bufferbloatValue').textContent = '+1487 ms';
    document.querySelector('#qualitySection').hidden = false;
    document.querySelector('#expertDetails').hidden = false;
  });
}

async function expectNoHorizontalOverflow(page, viewport) {
  const geometry = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(geometry.scrollWidth, `horizontal overflow at ${viewport.name}`).toBeLessThanOrEqual(geometry.clientWidth);

  for (const selector of ['#downloadValue', '#uploadValue', '#pingValue', '#startBtn']) {
    const box = await page.locator(selector).boundingBox();
    expect(box, `${selector} missing at ${viewport.name}`).not.toBeNull();
    expect(box.x, `${selector} left overflow at ${viewport.name}`).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width, `${selector} right overflow at ${viewport.name}`).toBeLessThanOrEqual(viewport.width + 1);
  }
}

test('all acceptance viewports remain stable with extreme instrument values', async ({ page }) => {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await waitForReady(page);
    await injectUglyCompletedValues(page);
    await expectNoHorizontalOverflow(page, viewport);
  }
});

test('mobile WebKit geometry and one-hand control target remain valid @safari', async ({ page }) => {
  const viewport = { name: '390x844-webkit', width: 390, height: 844 };
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await waitForReady(page);
  await injectUglyCompletedValues(page);
  await expectNoHorizontalOverflow(page, viewport);

  const startBox = await page.locator('#startBtn').boundingBox();
  const settingsBox = await page.locator('#settingsDetails > summary').boundingBox();
  const qualityBox = await page.locator('#qualitySection > summary').boundingBox();
  expect(startBox.height).toBeGreaterThanOrEqual(44);
  expect(settingsBox.height).toBeGreaterThanOrEqual(44);
  expect(qualityBox.height).toBeGreaterThanOrEqual(44);
});

test('landscape instrument keeps primary controls usable without desktop-card compression', async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await waitForReady(page);
  const startBox = await page.locator('#startBtn').boundingBox();
  expect(startBox.height).toBeGreaterThanOrEqual(44);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
