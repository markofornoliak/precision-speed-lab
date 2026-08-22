import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mean,
  median,
  percentile,
  latencySummary,
  qualifyLatencySamples,
  filterRunOutliers,
  bootstrapMedianConfidenceInterval,
  summarizeThroughputRuns,
  chooseAdaptiveBytes,
  chooseRunCount,
  shouldIncreaseStreams,
  bufferbloatAnalysis,
  receiveWindowSummary,
  probeLoss,
  splitBytes,
  coefficientOfVariation,
  serverPressureRisk,
} from '../public/measurement-core.js';

const MIB = 1024 * 1024;

test('basic statistics use deterministic interpolation and sample semantics', () => {
  assert.equal(mean([1, 2, 3]), 2);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(percentile([0, 10], 0.95), 9.5);
});

test('latency summary exposes requested P50/P90/P95/P99 and RTT jitter', () => {
  const summary = latencySummary([10, 12, 11, 14, 13]);
  assert.equal(summary.count, 5);
  assert.equal(summary.p50, 12);
  assert.ok(summary.p90 >= summary.p50);
  assert.ok(summary.p95 >= summary.p90);
  assert.ok(summary.p99 >= summary.p95);
  assert.equal(summary.jitter, 1.75);
});

test('loaded latency is promoted only with enough successful probes and bounded failure ratio', () => {
  const good = qualifyLatencySamples([10, 11, 12, 13, 14, 15, 16, 17], { sent: 9, failed: 1 });
  assert.equal(good.valid, true);
  assert.equal(good.summary.count, 8);

  const sparse = qualifyLatencySamples([10, 11, 12], { sent: 3, failed: 0 });
  assert.equal(sparse.valid, false);
  assert.equal(sparse.reason, 'insufficient-successful-probes');

  const lossy = qualifyLatencySamples([10, 11, 12, 13, 14, 15, 16, 17], { sent: 12, failed: 4 });
  assert.equal(lossy.valid, false);
  assert.equal(lossy.reason, 'excessive-probe-failures');
});

test('run-level MAD filtering only activates with enough samples', () => {
  assert.equal(filterRunOutliers([100, 101, 99, 1000]).removed, 0);
  const filtered = filterRunOutliers([99, 100, 101, 100, 102, 1000]);
  assert.equal(filtered.removed, 1);
  assert.equal(filtered.values.includes(1000), false);
});

test('bootstrap interval is deterministic and contains the central estimate', () => {
  const values = [90, 95, 100, 105, 110];
  const first = bootstrapMedianConfidenceInterval(values, 0.95, 1200);
  const second = bootstrapMedianConfidenceInterval(values, 0.95, 1200);
  assert.deepEqual(first, second);
  assert.ok(first.lower <= median(values));
  assert.ok(first.upper >= median(values));
});

test('throughput summary reports median, dispersion and defensible confidence interval', () => {
  const summary = summarizeThroughputRuns([99, 100, 101, 100, 102]);
  assert.equal(summary.medianMbps, 100);
  assert.ok(summary.cv >= 0);
  assert.ok(summary.confidence95.lower <= 100);
  assert.ok(summary.confidence95.upper >= 100);
});

test('adaptive payload targets duration while respecting byte bounds', () => {
  assert.equal(chooseAdaptiveBytes(8, { minBytes: MIB, maxBytes: 100 * MIB, targetSeconds: 1 }), MIB);
  assert.equal(chooseAdaptiveBytes(800, { minBytes: MIB, maxBytes: 100 * MIB, targetSeconds: 1 }), 96 * MIB);
  assert.equal(chooseAdaptiveBytes(100_000, { minBytes: MIB, maxBytes: 100 * MIB, targetSeconds: 10 }), 100 * MIB);
});

test('run count scales down for very large manual payloads', () => {
  assert.equal(chooseRunCount({ precise: true, totalBytes: 5 * MIB }), 5);
  assert.equal(chooseRunCount({ precise: true, totalBytes: 50 * MIB }), 4);
  assert.equal(chooseRunCount({ precise: true, totalBytes: 300 * MIB }), 3);
  assert.equal(chooseRunCount({ precise: false, totalBytes: 300 * MIB }), 2);
});

test('dynamic stream escalation requires meaningful relative and absolute gain', () => {
  assert.equal(shouldIncreaseStreams(100, 120, 1), true);
  assert.equal(shouldIncreaseStreams(100, 105, 1), false);
  assert.equal(shouldIncreaseStreams(1000, 1060, 4), false);
  assert.equal(shouldIncreaseStreams(1000, 1100, 4), true);
  assert.equal(shouldIncreaseStreams(1000, 1300, 8), false);
});

test('bufferbloat analysis reports loaded latency increase without an arbitrary grade', () => {
  const result = bufferbloatAnalysis(10, 18, 45);
  assert.equal(result.downIncreaseMs, 8);
  assert.equal(result.upIncreaseMs, 35);
  assert.equal(result.worstIncreaseMs, 35);
  assert.equal(result.method, 'loaded-p50-minus-idle-p50');
  assert.equal(bufferbloatAnalysis(10, null, null), null);
});

test('upload receive windows aggregate exact bytes over the server monotonic interval', () => {
  const summary = receiveWindowSummary([
    { received: 500_000, receiveStartedNs: '1000000000', receiveEndedNs: '2000000000' },
    { received: 500_000, receiveStartedNs: '1100000000', receiveEndedNs: '2100000000' },
  ]);
  assert.equal(summary.bytes, 1_000_000);
  assert.equal(summary.elapsedMs, 1100);
  assert.ok(Math.abs(summary.mbps - (8 / 1.1)) < 1e-12);
  assert.equal(receiveWindowSummary([{ received: 1, receiveStartedNs: '5', receiveEndedNs: '5' }]), null);
});

test('probe loss is explicitly a ratio of failed HTTP probes', () => {
  assert.equal(probeLoss(20, 1), 5);
  assert.equal(probeLoss(0, 0), null);
});

test('byte splitting is exact and preserves the requested total', () => {
  const parts = splitBytes(10, 4);
  assert.deepEqual(parts, [3, 3, 2, 2]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 10);
});

test('coefficient of variation separates variability from an arbitrary stability score', () => {
  assert.equal(coefficientOfVariation([100, 100, 100]), 0);
  assert.ok(coefficientOfVariation([50, 100, 150]) > 0);
});

test('server pressure risk reacts only to observable server runtime pressure', () => {
  assert.equal(serverPressureRisk({
    transfers: { activeGlobal: 2 }, limits: { maxActiveTransfers: 100 }, runtime: { eventLoopDelayP95Ms: 2, eventLoopUtilization: 0.2 },
  }).level, 'low');
  const elevated = serverPressureRisk({
    transfers: { activeGlobal: 90 }, limits: { maxActiveTransfers: 100 }, runtime: { eventLoopDelayP95Ms: 80, eventLoopUtilization: 0.95 },
  });
  assert.equal(elevated.level, 'elevated');
  assert.equal(elevated.reasons.length, 3);
});
