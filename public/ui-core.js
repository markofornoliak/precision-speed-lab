export const UI_STATES = Object.freeze({
  BOOTING: 'BOOTING',
  SERVER_READY: 'SERVER_READY',
  IDLE: 'IDLE',
  PREPARING: 'PREPARING',
  LATENCY: 'LATENCY',
  CALIBRATING_DOWNLOAD: 'CALIBRATING_DOWNLOAD',
  WARMING_DOWNLOAD: 'WARMING_DOWNLOAD',
  DOWNLOADING: 'DOWNLOADING',
  CALIBRATING_UPLOAD: 'CALIBRATING_UPLOAD',
  WARMING_UPLOAD: 'WARMING_UPLOAD',
  UPLOADING: 'UPLOADING',
  ANALYZING: 'ANALYZING',
  COMPLETE: 'COMPLETE',
  CANCELLING: 'CANCELLING',
  CANCELLED: 'CANCELLED',
  ERROR: 'ERROR',
});

export const STATE_META = Object.freeze({
  BOOTING: { label: 'Connecting', announcement: 'Connecting to the measurement service', emphasis: 'setup' },
  SERVER_READY: { label: 'Measurement node ready', announcement: 'Measurement node ready', emphasis: 'setup' },
  IDLE: { label: 'Ready', announcement: 'Ready to start a measurement', emphasis: 'idle' },
  PREPARING: { label: 'Preparing', announcement: 'Test started', emphasis: 'active' },
  LATENCY: { label: 'Measuring latency', announcement: 'Measuring latency', emphasis: 'latency' },
  CALIBRATING_DOWNLOAD: { label: 'Calibrating download', announcement: 'Calibrating download', emphasis: 'download' },
  WARMING_DOWNLOAD: { label: 'Warming download path', announcement: 'Preparing download measurement', emphasis: 'download' },
  DOWNLOADING: { label: 'Download', announcement: 'Measuring download', emphasis: 'download' },
  CALIBRATING_UPLOAD: { label: 'Calibrating upload', announcement: 'Calibrating upload', emphasis: 'upload' },
  WARMING_UPLOAD: { label: 'Warming upload path', announcement: 'Preparing upload measurement', emphasis: 'upload' },
  UPLOADING: { label: 'Upload', announcement: 'Measuring upload', emphasis: 'upload' },
  ANALYZING: { label: 'Analyzing', announcement: 'Analyzing measurement', emphasis: 'analysis' },
  COMPLETE: { label: 'Complete', announcement: 'Measurement complete', emphasis: 'complete' },
  CANCELLING: { label: 'Stopping', announcement: 'Stopping measurement', emphasis: 'active' },
  CANCELLED: { label: 'Cancelled', announcement: 'Measurement cancelled', emphasis: 'idle' },
  ERROR: { label: 'Measurement unavailable', announcement: 'Measurement failed', emphasis: 'error' },
});

const TRANSITIONS = Object.freeze({
  BOOTING: ['SERVER_READY', 'ERROR'],
  SERVER_READY: ['IDLE', 'ERROR', 'BOOTING'],
  IDLE: ['PREPARING', 'BOOTING', 'ERROR'],
  PREPARING: ['LATENCY', 'CANCELLING', 'ERROR'],
  LATENCY: ['CALIBRATING_DOWNLOAD', 'CANCELLING', 'ERROR'],
  CALIBRATING_DOWNLOAD: ['WARMING_DOWNLOAD', 'DOWNLOADING', 'CANCELLING', 'ERROR'],
  WARMING_DOWNLOAD: ['CALIBRATING_DOWNLOAD', 'DOWNLOADING', 'CANCELLING', 'ERROR'],
  DOWNLOADING: ['WARMING_DOWNLOAD', 'CALIBRATING_UPLOAD', 'CANCELLING', 'ERROR'],
  CALIBRATING_UPLOAD: ['WARMING_UPLOAD', 'UPLOADING', 'CANCELLING', 'ERROR'],
  WARMING_UPLOAD: ['CALIBRATING_UPLOAD', 'UPLOADING', 'CANCELLING', 'ERROR'],
  UPLOADING: ['WARMING_UPLOAD', 'ANALYZING', 'CANCELLING', 'ERROR'],
  ANALYZING: ['COMPLETE', 'CANCELLING', 'ERROR'],
  COMPLETE: ['PREPARING', 'IDLE', 'BOOTING'],
  CANCELLING: ['CANCELLED', 'ERROR'],
  CANCELLED: ['PREPARING', 'IDLE', 'BOOTING'],
  ERROR: ['PREPARING', 'IDLE', 'BOOTING'],
});

export function canTransition(from, to) {
  if (from === to) return true;
  return Boolean(TRANSITIONS[from]?.includes(to));
}

export function createStateMachine({ initial = UI_STATES.BOOTING, onChange = () => {} } = {}) {
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
  if (value >= 1000) return value.toFixed(1);
  if (value >= 100) return value.toFixed(1);
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
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
