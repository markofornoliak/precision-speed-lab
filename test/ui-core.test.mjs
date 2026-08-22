import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UI_STATES,
  canTransition,
  createStateMachine,
  formatThroughput,
  formatLatency,
  formatPercent,
  formatCv,
  formatBytes,
  decimateSeries,
  classifyMeasurementError,
  freezeFinalResult,
} from '../public/ui-core.js';

test('UI state machine permits the intended measurement sequence', () => {
  const changes = [];
  const machine = createStateMachine({ onChange: ({ current }) => changes.push(current) });
  const sequence = [
    UI_STATES.SERVER_READY,
    UI_STATES.IDLE,
    UI_STATES.PREPARING,
    UI_STATES.LATENCY,
    UI_STATES.CALIBRATING_DOWNLOAD,
    UI_STATES.WARMING_DOWNLOAD,
    UI_STATES.CALIBRATING_DOWNLOAD,
    UI_STATES.DOWNLOADING,
    UI_STATES.WARMING_DOWNLOAD,
    UI_STATES.DOWNLOADING,
    UI_STATES.CALIBRATING_UPLOAD,
    UI_STATES.WARMING_UPLOAD,
    UI_STATES.CALIBRATING_UPLOAD,
    UI_STATES.UPLOADING,
    UI_STATES.WARMING_UPLOAD,
    UI_STATES.UPLOADING,
    UI_STATES.ANALYZING,
    UI_STATES.COMPLETE,
  ];
  for (const next of sequence) machine.transition(next);
  assert.equal(machine.current, UI_STATES.COMPLETE);
  assert.deepEqual(changes, sequence);
});

test('UI state machine rejects illegal transitions', () => {
  const machine = createStateMachine({ initial: UI_STATES.IDLE });
  assert.equal(canTransition(UI_STATES.IDLE, UI_STATES.UPLOADING), false);
  assert.throws(() => machine.transition(UI_STATES.UPLOADING), /Illegal UI transition/);
  assert.equal(machine.current, UI_STATES.IDLE);
});

test('cancellation has an explicit transition path and never jumps to complete', () => {
  const machine = createStateMachine({ initial: UI_STATES.DOWNLOADING });
  machine.transition(UI_STATES.CANCELLING);
  machine.transition(UI_STATES.CANCELLED);
  assert.equal(machine.current, UI_STATES.CANCELLED);
  assert.equal(canTransition(UI_STATES.CANCELLED, UI_STATES.COMPLETE), false);
});

test('instrument formatting is centralized and honest at extreme values', () => {
  assert.equal(formatThroughput(5), '5.00');
  assert.equal(formatThroughput(95), '95.0');
  assert.equal(formatThroughput(950), '950.0');
  assert.equal(formatThroughput(2500), '2500.0');
  assert.equal(formatThroughput(10_000), '10000.0');
  assert.equal(formatThroughput(Number.NaN), '—');
  assert.equal(formatThroughput(-1), '—');
  assert.equal(formatLatency(5.234), '5.2');
  assert.equal(formatLatency(1247.4), '1247');
  assert.equal(formatLatency(null), '—');
  assert.equal(formatPercent(0), '0.0%');
  assert.equal(formatCv(0.0874), '8.7%');
  assert.equal(formatBytes(500_000_000), '500 MB');
  assert.equal(formatBytes(2_500_000_000), '2.50 GB');
});

test('chart decimation preserves endpoints and extrema without inventing samples', () => {
  const points = Array.from({ length: 1000 }, (_, index) => ({ t: index / 10, v: 100 + Math.sin(index / 10) * 4 }));
  points[333] = { t: 33.3, v: 900 };
  points[777] = { t: 77.7, v: 1 };
  const result = decimateSeries(points, 80);
  assert.ok(result.length <= 82, `unexpected decimated length ${result.length}`);
  assert.deepEqual(result[0], points[0]);
  assert.deepEqual(result.at(-1), points.at(-1));
  assert.ok(result.some((point) => point === points[333]), 'high spike must survive decimation');
  assert.ok(result.some((point) => point === points[777]), 'low spike must survive decimation');
  for (const point of result) assert.ok(points.includes(point), 'decimator must return original measured points only');
});

test('structured errors distinguish lifecycle invalidation and transfer failures', () => {
  const lifecycle = classifyMeasurementError(new Error('stale-run'), { lifecycleInvalidated: true });
  assert.equal(lifecycle.code, 'lifecycle-invalidated');
  assert.equal(lifecycle.partialValid, false);
  const down = classifyMeasurementError(new Error('Download failed (503)'));
  assert.equal(down.code, 'download-transfer-failure');
  const upload = classifyMeasurementError(new Error('Upload server byte count mismatch'));
  assert.equal(upload.code, 'upload-transfer-failure');
  const latency = classifyMeasurementError(new Error('Insufficient successful latency probes'));
  assert.equal(latency.code, 'insufficient-latency-samples');
});

test('final result promotion deeply freezes measurement evidence', () => {
  const result = freezeFinalResult({
    download: { values: [100, 101] },
    quality: { loaded: { p50: 12.4 } },
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.download), true);
  assert.equal(Object.isFrozen(result.download.values), true);
  assert.throws(() => result.download.values.push(102), TypeError);
});
