import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UI_STATES,
  canTransition,
  createStateMachine,
  formatThroughput,
  formatThroughputDisplay,
  formatLatency,
  formatPercent,
  formatCv,
  formatBytes,
  decimateSeries,
  classifyMeasurementError,
  freezeFinalResult,
} from '../public/ui-core.js';

test('UI state machine exposes only the deliberate measurement states', () => {
  assert.deepEqual(Object.values(UI_STATES), [
    'CONNECTING', 'READY', 'PREPARING', 'LATENCY', 'DOWNLOAD', 'UPLOAD',
    'ANALYZING', 'COMPLETE', 'CANCELLED', 'ERROR',
  ]);
});

test('UI state machine permits the intended measurement sequence', () => {
  const changes = [];
  const machine = createStateMachine({ onChange: ({ current }) => changes.push(current) });
  const sequence = [
    UI_STATES.READY,
    UI_STATES.PREPARING,
    UI_STATES.LATENCY,
    UI_STATES.DOWNLOAD,
    UI_STATES.UPLOAD,
    UI_STATES.ANALYZING,
    UI_STATES.COMPLETE,
  ];
  for (const next of sequence) machine.transition(next);
  assert.equal(machine.current, UI_STATES.COMPLETE);
  assert.deepEqual(changes, sequence);
});

test('UI state machine rejects illegal jumps', () => {
  const machine = createStateMachine({ initial: UI_STATES.READY });
  assert.equal(canTransition(UI_STATES.READY, UI_STATES.UPLOAD), false);
  assert.throws(() => machine.transition(UI_STATES.UPLOAD), /Illegal UI transition/);
  assert.equal(machine.current, UI_STATES.READY);
});

test('cancellation has a direct terminal path and never promotes partial data', () => {
  const machine = createStateMachine({ initial: UI_STATES.DOWNLOAD });
  machine.transition(UI_STATES.CANCELLED);
  assert.equal(machine.current, UI_STATES.CANCELLED);
  assert.equal(canTransition(UI_STATES.CANCELLED, UI_STATES.COMPLETE), false);
});

test('instrument formatting is centralized and stable at extreme values', () => {
  assert.equal(formatThroughput(5), '5.00');
  assert.equal(formatThroughput(95), '95.0');
  assert.equal(formatThroughput(987), '987.0');
  assert.equal(formatThroughput(2487), '2487.0');
  assert.equal(formatThroughput(Number.NaN), '—');
  assert.equal(formatThroughput(-1), '—');
  assert.deepEqual(formatThroughputDisplay(2487), { value: '2487.0', unit: 'Mbps' });
  assert.deepEqual(formatThroughputDisplay(10_200), { value: '10.2', unit: 'Gbps' });
  assert.deepEqual(formatThroughputDisplay(125_000), { value: '125', unit: 'Gbps' });
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
  for (const point of result) assert.ok(points.includes(point), 'decimator must return measured points only');
});

test('structured errors distinguish lifecycle invalidation and transfer failures', () => {
  const lifecycle = classifyMeasurementError(new Error('stale-run'), { lifecycleInvalidated: true });
  assert.equal(lifecycle.code, 'lifecycle-invalidated');
  assert.equal(lifecycle.partialValid, false);
  assert.equal(classifyMeasurementError(new Error('Download failed (503)')).code, 'download-transfer-failure');
  assert.equal(classifyMeasurementError(new Error('Upload server byte count mismatch')).code, 'upload-transfer-failure');
  assert.equal(classifyMeasurementError(new Error('Insufficient successful latency probes')).code, 'insufficient-latency-samples');
});

test('final result promotion deeply freezes measurement evidence', () => {
  const result = freezeFinalResult({ download: { values: [100, 101] }, quality: { loaded: { p50: 12.4 } } });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.download), true);
  assert.equal(Object.isFrozen(result.download.values), true);
  assert.throws(() => result.download.values.push(102), TypeError);
});
