export const UI_STATES = Object.freeze({
  CONNECTING: 'CONNECTING',
  READY: 'READY',
  PREPARING: 'PREPARING',
  LATENCY: 'LATENCY',
  DOWNLOAD: 'DOWNLOAD',
  UPLOAD: 'UPLOAD',
  ANALYZING: 'ANALYZING',
  COMPLETE: 'COMPLETE',
  CANCELLED: 'CANCELLED',
  ERROR: 'ERROR',
});

export const STATE_META = Object.freeze({
  CONNECTING: { label: 'Connecting', announcement: 'Connecting to the measurement service', emphasis: 'setup' },
  READY: { label: 'Ready', announcement: 'Ready to start a measurement', emphasis: 'idle' },
  PREPARING: { label: 'Preparing', announcement: 'Test started', emphasis: 'active' },
  LATENCY: { label: 'Latency', announcement: 'Measuring latency', emphasis: 'latency' },
  DOWNLOAD: { label: 'Download', announcement: 'Measuring download', emphasis: 'download' },
  UPLOAD: { label: 'Upload', announcement: 'Measuring upload', emphasis: 'upload' },
  ANALYZING: { label: 'Analyzing', announcement: 'Analyzing measurement', emphasis: 'analysis' },
  COMPLETE: { label: 'Complete', announcement: 'Measurement complete', emphasis: 'complete' },
  CANCELLED: { label: 'Cancelled', announcement: 'Measurement cancelled', emphasis: 'idle' },
  ERROR: { label: 'Unavailable', announcement: 'Measurement failed', emphasis: 'error' },
});

const TRANSITIONS = Object.freeze({
  CONNECTING: ['READY', 'ERROR'],
  READY: ['PREPARING', 'CONNECTING', 'ERROR'],
  PREPARING: ['LATENCY', 'CANCELLED', 'ERROR'],
  LATENCY: ['DOWNLOAD', 'CANCELLED', 'ERROR'],
  DOWNLOAD: ['UPLOAD', 'CANCELLED', 'ERROR'],
  UPLOAD: ['ANALYZING', 'CANCELLED', 'ERROR'],
  ANALYZING: ['COMPLETE', 'CANCELLED', 'ERROR'],
  COMPLETE: ['PREPARING', 'READY', 'CONNECTING'],
  CANCELLED: ['PREPARING', 'READY', 'CONNECTING'],
  ERROR: ['PREPARING', 'READY', 'CONNECTING'],
});

export function canTransition(from, to) {
  if (from === to) return true;
  return Boolean(TRANSITIONS[from]?.includes(to));
}

export function createStateMachine({ initial = UI_STATES.CONNECTING, onChange = () => {} } = {}) {
  if (!STATE_META[initial]) throw new RangeError(`Unknown initial UI state: ${initial}`);
  let current = initial;
  return Object.freeze({
    get current() { return current; },
    transition(next, detail = {}) {
      if (!STATE_META[next]) throw new RangeError(`Unknown UI state: ${next}`);
      if (!canTransition(current, next)) throw new Error(`Illegal UI transition: ${current} -> ${next}`);
      if (current === next) return current;
      const previous = current;
      current = next;
      onChange({ previous, current, meta: STATE_META[current], detail });
      return current;
    },
  });
}

export function formatThroughput(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value >= 100) return value.toFixed(1);
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

export function formatThroughputDisplay(value) {
  if (!Number.isFinite(value) || value < 0) return Object.freeze({ value: '—', unit: 'Mbps' });
  if (value >= 10_000) {
    const gbps = value / 1000;
    return Object.freeze({
      value: gbps >= 100 ? gbps.toFixed(0) : gbps.toFixed(1),
      unit: 'Gbps',
    });
  }
  return Object.freeze({ value: formatThroughput(value), unit: 'Mbps' });
}

export function formatLatency(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value >= 100) return value.toFixed(0);
  return value.toFixed(1);
}

export function formatPercent(value, digits = 1) {
  if (!Number.isFinite(value) || value < 0) return '—';
  return `${value.toFixed(digits)}%`;
}

export function formatCv(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const mb = bytes / 1_000_000;
  if (mb < 10) return `${mb.toFixed(1)} MB`;
  if (mb < 1000) return `${mb.toFixed(0)} MB`;
  return `${(mb / 1000).toFixed(2)} GB`;
}

export function decimateSeries(points, maxPoints = 280) {
  if (!Array.isArray(points)) return [];
  if (points.length <= maxPoints || maxPoints < 6) return points.slice();

  const buckets = Math.max(1, Math.floor((maxPoints - 2) / 2));
  const span = (points.length - 2) / buckets;
  const output = [points[0]];

  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const start = 1 + Math.floor(bucket * span);
    const end = Math.min(points.length - 1, 1 + Math.floor((bucket + 1) * span));
    if (end <= start) continue;
    let minPoint = points[start];
    let maxPoint = points[start];
    for (let index = start + 1; index < end; index += 1) {
      const point = points[index];
      if (point.v < minPoint.v) minPoint = point;
      if (point.v > maxPoint.v) maxPoint = point;
    }
    if (minPoint === maxPoint) output.push(minPoint);
    else if (minPoint.t <= maxPoint.t) output.push(minPoint, maxPoint);
    else output.push(maxPoint, minPoint);
  }

  output.push(points.at(-1));
  return output;
}

export function classifyMeasurementError(error, context = {}) {
  const diagnostic = String(error?.message || error || 'Unknown measurement error');
  const message = diagnostic.toLowerCase();
  const status = Number(error?.status);

  if (context.lifecycleInvalidated) {
    return {
      code: 'lifecycle-invalidated',
      title: 'Measurement interrupted',
      message: 'The page was backgrounded or suspended, so this result was discarded.',
      action: 'Keep this page active and run the test again.',
      partialValid: false,
      diagnostic,
    };
  }
  if (status === 429 || message.includes('server is busy') || message.includes('rate limit')) {
    return {
      code: 'measurement-node-busy',
      title: 'Measurement node is busy',
      message: 'The selected node cannot accept this measurement cleanly right now.',
      action: 'Retry after a short pause.',
      partialValid: false,
      diagnostic,
    };
  }
  if (message.includes('insufficient successful latency')) {
    return {
      code: 'insufficient-latency-samples',
      title: 'Latency could not be qualified',
      message: 'Too few HTTP probes completed successfully to publish a defensible latency result.',
      action: 'Check the connection and retry.',
      partialValid: false,
      diagnostic,
    };
  }
  if (message.includes('download')) {
    return {
      code: 'download-transfer-failure',
      title: 'Download measurement failed',
      message: 'The download transfer did not complete cleanly, so no final download result was published.',
      action: 'Retry the test.',
      partialValid: false,
      diagnostic,
    };
  }
  if (message.includes('upload')) {
    return {
      code: 'upload-transfer-failure',
      title: 'Upload measurement failed',
      message: 'The upload transfer did not complete cleanly, so no final upload result was published.',
      action: 'Retry the test.',
      partialValid: false,
      diagnostic,
    };
  }
  if (message.includes('unsupported') || message.includes('readablestream')) {
    return {
      code: 'unsupported-browser-feature',
      title: 'Browser capability unavailable',
      message: 'This browser cannot provide a required measurement primitive reliably.',
      action: 'Use a current browser or another device.',
      partialValid: false,
      diagnostic,
    };
  }
  if (context.boot || message.includes('failed to fetch') || message.includes('networkerror') || message.includes('server unavailable')) {
    return {
      code: 'backend-unavailable',
      title: 'Measurement service unavailable',
      message: 'A measurement node could not be reached.',
      action: 'Check the connection and retry.',
      partialValid: false,
      diagnostic,
    };
  }
  return {
    code: 'measurement-failed',
    title: 'Measurement did not complete',
    message: 'The test stopped before a complete result could be validated.',
    action: 'Retry the measurement.',
    partialValid: false,
    diagnostic,
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

export function freezeFinalResult(result) {
  return deepFreeze(result);
}
