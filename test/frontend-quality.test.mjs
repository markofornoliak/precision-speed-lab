import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const size = (relative) => fs.statSync(path.join(root, relative)).size;

test('production frontend remains dependency-free at runtime', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(pkg.dependencies || {}, {});
  assert.ok(pkg.devDependencies?.['@playwright/test']);
  assert.ok(pkg.devDependencies?.['@axe-core/playwright']);
});

test('frontend asset budget stays intentionally small', () => {
  const jsBytes = size('public/app.js') + size('public/measurement-core.js') + size('public/ui-core.js');
  const cssBytes = size('public/styles.css');
  const htmlBytes = size('public/index.html');
  assert.ok(jsBytes <= 90 * 1024, `production JS budget exceeded: ${jsBytes} bytes`);
  assert.ok(cssBytes <= 24 * 1024, `CSS budget exceeded: ${cssBytes} bytes`);
  assert.ok(htmlBytes <= 22 * 1024, `HTML budget exceeded: ${htmlBytes} bytes`);
});

test('active-measurement code contains no decorative animation loop or interval timer', () => {
  const app = read('public/app.js');
  assert.equal(/requestAnimationFrame\s*\(/.test(app), false, 'requestAnimationFrame loop is not allowed in the measurement UI');
  assert.equal(/setInterval\s*\(/.test(app), false, 'interval timers are not allowed in the measurement UI');
  assert.equal(/drawChart\s*\(/.test(app), false, 'legacy direct chart rendering must not return');
  assert.match(app, /class TelemetryPresenter/);
  assert.match(app, /class ChartRenderer/);
  assert.match(app, /ResizeObserver/);
});

test('measurement semantics remain explicitly honest in user-facing copy', () => {
  const html = read('public/index.html');
  assert.match(html, /HTTP probe loss/);
  assert.match(html, /не L3 loss/);
  assert.match(html, /Variation · download/);
  assert.match(html, /<span>CV<\/span>/);
  assert.match(html, /95% CI/);
  assert.doesNotMatch(html, /accuracy percentage/i);
});

test('accessible controls use native radio, select and switch semantics', () => {
  const html = read('public/index.html');
  assert.match(html, /type="radio" name="payload"/);
  assert.match(html, /<select id="connections">/);
  assert.match(html, /type="checkbox" role="switch"/);
  assert.doesNotMatch(html, /role="radiogroup"[^>]*>[\s\S]{0,500}<button/);
});

test('measurement core remains isolated from presentation code', () => {
  const core = read('public/measurement-core.js');
  assert.equal(/document\.|window\.|querySelector|canvas|getContext/.test(core), false);
  assert.match(core, /receiveWindowSummary/);
  assert.match(core, /bootstrapMedianConfidenceInterval/);
  assert.match(core, /serverPressureRisk/);
});
