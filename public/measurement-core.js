const MIB = 1024 * 1024;

export function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function percentile(values, q) {
  if (!values.length) return null;
  if (!(q >= 0 && q <= 1)) throw new RangeError('q must be between 0 and 1');
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export function sampleStdDev(values) {
  if (values.length < 2) return null;
  const avg = mean(values);
  const sumSquares = values.reduce((sum, value) => sum + (value - avg) ** 2, 0);
  return Math.sqrt(sumSquares / (values.length - 1));
}

export function coefficientOfVariation(values) {
  const filtered = values.filter((value) => Number.isFinite(value) && value > 0);
  if (filtered.length < 2) return null;
  const avg = mean(filtered);
  const sd = sampleStdDev(filtered);
  return avg > 0 && sd != null ? sd / avg : null;
}

export function meanAbsoluteConsecutiveDifference(values) {
  if (values.length < 2) return null;
  let total = 0;
  for (let index = 1; index < values.length; index += 1) {
    total += Math.abs(values[index] - values[index - 1]);
  }
  return total / (values.length - 1);
}

export function latencySummary(values) {
  const filtered = values.filter((value) => Number.isFinite(value) && value >= 0);
  if (!filtered.length) return null;
  return {
    count: filtered.length,
    min: Math.min(...filtered),
    p50: percentile(filtered, 0.50),
    p90: percentile(filtered, 0.90),
    p95: percentile(filtered, 0.95),
    p99: percentile(filtered, 0.99),
    max: Math.max(...filtered),
    jitter: meanAbsoluteConsecutiveDifference(filtered),
  };
}

export function medianAbsoluteDeviation(values) {
  if (!values.length) return null;
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center)));
}

export function filterRunOutliers(values) {
  const filtered = values.filter((value) => Number.isFinite(value) && value >= 0);
  if (filtered.length < 5) return { values: filtered, removed: 0, method: 'none' };

  const center = median(filtered);
  const mad = medianAbsoluteDeviation(filtered);
  if (!mad || mad < Number.EPSILON) return { values: filtered, removed: 0, method: 'mad' };

  const kept = filtered.filter((value) => {
    const modifiedZ = 0.6744897501960817 * Math.abs(value - center) / mad;
    return modifiedZ <= 3.5;
  });

  if (kept.length < 3) return { values: filtered, removed: 0, method: 'mad-fallback' };
  return { values: kept, removed: filtered.length - kept.length, method: 'mad' };
}

function mulberry32(seed) {
  return function random() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function bootstrapMedianConfidenceInterval(values, confidence = 0.95, iterations = 2000) {
  const filtered = values.filter((value) => Number.isFinite(value) && value >= 0);
  if (filtered.length < 3) return null;
  if (!(confidence > 0 && confidence < 1)) throw new RangeError('confidence must be between 0 and 1');
  const count = Math.max(400, Math.min(10000, Math.floor(iterations)));
  const seed = filtered.reduce((acc, value, index) => {
    const scaled = Math.round(value * 1000);
    return (Math.imul(acc ^ scaled, 16777619) + index) >>> 0;
  }, 2166136261);
  const random = mulberry32(seed || 1);
  const bootstrapped = new Array(count);
  for (let iteration = 0; iteration < count; iteration += 1) {
    const sample = new Array(filtered.length);
    for (let index = 0; index < filtered.length; index += 1) {
      sample[index] = filtered[Math.floor(random() * filtered.length)];
    }
    bootstrapped[iteration] = median(sample);
  }
  const alpha = (1 - confidence) / 2;
  return {
    confidence,
    lower: percentile(bootstrapped, alpha),
    upper: percentile(bootstrapped, 1 - alpha),
    iterations: count,
    method: 'percentile-bootstrap-median',
  };
}

export function summarizeThroughputRuns(values) {
  const raw = values.filter((value) => Number.isFinite(value) && value >= 0);
  if (!raw.length) return null;
  const outlierResult = filterRunOutliers(raw);
  const used = outlierResult.values;
  return {
    raw,
    used,
    removed: outlierResult.removed,
    outlierMethod: outlierResult.method,
    medianMbps: median(used),
    p10Mbps: percentile(used, 0.10),
    p90Mbps: percentile(used, 0.90),
    cv: coefficientOfVariation(used),
    confidence95: bootstrapMedianConfidenceInterval(used),
  };
}

export function chooseAdaptiveBytes(mbps, options = {}) {
  const minBytes = options.minBytes ?? MIB;
  const maxBytes = options.maxBytes ?? 500 * MIB;
  const targetSeconds = options.targetSeconds ?? 6;
  if (!Number.isFinite(mbps) || mbps <= 0) return Math.min(maxBytes, Math.max(minBytes, 5 * MIB));
  const raw = (mbps * 1_000_000 / 8) * targetSeconds;
  const rounded = Math.ceil(raw / MIB) * MIB;
  return Math.max(minBytes, Math.min(maxBytes, rounded));
}

export function chooseRunCount({ precise, totalBytes }) {
  if (!precise) return totalBytes >= 250 * MIB ? 2 : 3;
  if (totalBytes <= 10 * MIB) return 5;
  if (totalBytes <= 100 * MIB) return 4;
  return 3;
}

export function shouldIncreaseStreams(previousMbps, candidateMbps, currentStreams) {
  if (currentStreams >= 8) return false;
  if (!Number.isFinite(previousMbps) || previousMbps <= 0) return true;
  if (!Number.isFinite(candidateMbps) || candidateMbps <= 0) return false;
  const relativeGain = (candidateMbps - previousMbps) / previousMbps;
  const absoluteGain = candidateMbps - previousMbps;
  return relativeGain >= 0.08 && absoluteGain >= Math.min(10, previousMbps * 0.04);
}

export function bufferbloatAnalysis(idleMedianMs, downloadMedianMs, uploadMedianMs) {
  if (![idleMedianMs, downloadMedianMs, uploadMedianMs].some(Number.isFinite)) return null;
  if (!Number.isFinite(idleMedianMs)) return null;
  const downIncreaseMs = Number.isFinite(downloadMedianMs) ? Math.max(0, downloadMedianMs - idleMedianMs) : null;
  const upIncreaseMs = Number.isFinite(uploadMedianMs) ? Math.max(0, uploadMedianMs - idleMedianMs) : null;
  const worstIncreaseMs = Math.max(...[downIncreaseMs, upIncreaseMs].filter(Number.isFinite));
  let grade = 'F';
  if (worstIncreaseMs <= 5) grade = 'A+';
  else if (worstIncreaseMs <= 15) grade = 'A';
  else if (worstIncreaseMs <= 30) grade = 'B';
  else if (worstIncreaseMs <= 60) grade = 'C';
  else if (worstIncreaseMs <= 100) grade = 'D';
  return { downIncreaseMs, upIncreaseMs, worstIncreaseMs, grade };
}

export function probeLoss(sent, failed) {
  if (!Number.isFinite(sent) || sent <= 0 || !Number.isFinite(failed) || failed < 0) return null;
  return Math.max(0, Math.min(100, failed / sent * 100));
}

export function splitBytes(totalBytes, streams) {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) throw new RangeError('totalBytes must be a non-negative safe integer');
  if (!Number.isInteger(streams) || streams < 1) throw new RangeError('streams must be a positive integer');
  const base = Math.floor(totalBytes / streams);
  const remainder = totalBytes - base * streams;
  return Array.from({ length: streams }, (_, index) => base + (index < remainder ? 1 : 0));
}

export function serverPressureRisk(health) {
  if (!health || typeof health !== 'object') return { level: 'unknown', reasons: [] };
  const reasons = [];
  const active = health.transfers?.activeGlobal;
  const max = health.limits?.maxActiveTransfers;
  if (Number.isFinite(active) && Number.isFinite(max) && max > 0 && active / max >= 0.8) {
    reasons.push('high transfer concurrency');
  }
  const eventLoopP95 = health.runtime?.eventLoopDelayP95Ms;
  if (Number.isFinite(eventLoopP95) && eventLoopP95 >= 50) reasons.push('high event-loop delay');
  const elu = health.runtime?.eventLoopUtilization;
  if (Number.isFinite(elu) && elu >= 0.9) reasons.push('high event-loop utilization');
  return { level: reasons.length ? 'elevated' : 'low', reasons };
}
