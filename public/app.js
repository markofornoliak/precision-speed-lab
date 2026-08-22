import {
  median,
  latencySummary,
  qualifyLatencySamples,
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
} from './measurement-core.js';
import {
  UI_STATES,
  STATE_META,
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
} from './ui-core.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const MB = 1_000_000;
const MIB = 1024 * 1024;
const ZERO_64K = new Uint8Array(64 * 1024);
const FALLBACK_UPLOAD_CHUNK = new Blob([new Uint8Array(8 * MIB)], { type: 'application/octet-stream' });
const ACTIVE_STATES = new Set([
  UI_STATES.PREPARING,
  UI_STATES.LATENCY,
  UI_STATES.CALIBRATING_DOWNLOAD,
  UI_STATES.WARMING_DOWNLOAD,
  UI_STATES.DOWNLOADING,
  UI_STATES.CALIBRATING_UPLOAD,
  UI_STATES.WARMING_UPLOAD,
  UI_STATES.UPLOADING,
  UI_STATES.ANALYZING,
  UI_STATES.CANCELLING,
]);
const ANNOUNCED_STATES = new Set([
  UI_STATES.IDLE,
  UI_STATES.PREPARING,
  UI_STATES.LATENCY,
  UI_STATES.DOWNLOADING,
  UI_STATES.UPLOADING,
  UI_STATES.ANALYZING,
  UI_STATES.COMPLETE,
  UI_STATES.CANCELLED,
  UI_STATES.ERROR,
]);

const state = {
  initialized: false,
  running: false,
  runToken: 0,
  aborters: new Set(),
  cancelReason: null,
  lifecycleInvalidated: false,
  lifecycleReason: '',
  apiBase: '',
  precise: true,
  sizeMode: 'auto',
  sizeMB: 100,
  connections: 'auto',
  capabilities: null,
  serverInfo: null,
  nextHopProtocol: '',
  totalBytes: 0,
  testStartedAt: 0,
  downloadSeries: [],
  uploadSeries: [],
  finalResult: null,
};

const els = {
  start: $('#startBtn'),
  stop: $('#stopBtn'),
  phase: $('#phaseLabel'),
  phaseDescription: $('#phaseDescription'),
  speed: $('#speedValue'),
  liveUnit: $('.live-unit'),
  ping: $('#pingValue'),
  jitter: $('#jitterValue'),
  down: $('#downloadValue'),
  up: $('#uploadValue'),
  loadedDown: $('#loadedDownValue'),
  loadedUp: $('#loadedUpValue'),
  probeLoss: $('#probeLossValue'),
  bufferbloat: $('#bufferbloatValue'),
  stabilityDown: $('#stabilityDownValue'),
  stabilityUp: $('#stabilityUpValue'),
  p50: $('#p50Value'), p90: $('#p90Value'), p95: $('#p95Value'), p99: $('#p99Value'),
  downCi: $('#downCiValue'), upCi: $('#upCiValue'), confidenceText: $('#confidenceText'),
  data: $('#dataValue'), downRuns: $('#downRunsValue'), upRuns: $('#upRunsValue'), outliers: $('#outlierValue'),
  streams: $('#streamsValue'), payload: $('#payloadValue'), protocol: $('#protocolValue'), family: $('#familyValue'),
  measurementNode: $('#measurementNodeValue'), downloadTiming: $('#downloadTimingValue'), uploadTiming: $('#uploadTimingValue'), pressure: $('#pressureValue'),
  serverState: $('#serverState'), serverStatus: $('#serverStatus'), footerInfo: $('#footerInfo'), nodeInfo: $('#nodeInfo'),
  sizeSelector: $('#sizeSelector'), sizeHint: $('#sizeHint'), connections: $('#connections'), precision: $('#precisionToggle'),
  settingsDetails: $('#settingsDetails'), qualitySection: $('#qualitySection'), expertDetails: $('#expertDetails'),
  chart: $('#speedChart'), chartFrame: $('#chartFrame'), chartSummary: $('#chartSummary'),
  notice: $('#measurementNotice'), announcer: $('#announcer'),
  errorPanel: $('#errorPanel'), errorTitle: $('#errorTitle'), errorMessage: $('#errorMessage'), errorAction: $('#errorAction'), errorValidity: $('#errorValidity'), errorDiagnostic: $('#errorDiagnostic'),
};

function phaseDescriptionFor(uiState) {
  switch (uiState) {
    case UI_STATES.BOOTING: return 'Подготавливаем измерительный узел';
    case UI_STATES.SERVER_READY: return 'Измерительный узел отвечает';
    case UI_STATES.IDLE: return 'Один запуск — автоматический выбор payload и потоков';
    case UI_STATES.PREPARING: return 'Проверяем узел до начала измерения';
    case UI_STATES.LATENCY: return 'HTTP RTT baseline до нагрузочного трафика';
    case UI_STATES.CALIBRATING_DOWNLOAD: return 'Подбираем число потоков и измерительный объём';
    case UI_STATES.WARMING_DOWNLOAD: return 'Warm-up не включается в основной результат';
    case UI_STATES.DOWNLOADING: return 'Считаем реально полученные байты по browser wall-clock';
    case UI_STATES.CALIBRATING_UPLOAD: return 'Подбираем число потоков и измерительный объём';
    case UI_STATES.WARMING_UPLOAD: return 'Warm-up не включается в основной результат';
    case UI_STATES.UPLOADING: return 'Скорость определяется по server receive-window';
    case UI_STATES.ANALYZING: return 'Проверяем probes, агрегируем прогоны и confidence interval';
    case UI_STATES.COMPLETE: return 'Опубликован только валидированный финальный результат';
    case UI_STATES.CANCELLING: return 'Завершаем активные запросы';
    case UI_STATES.CANCELLED: return 'Частичные значения отброшены';
    case UI_STATES.ERROR: return 'Неполный результат не публикуется как финальный';
    default: return '';
  }
}

function announce(text) {
  if (!text) return;
  els.announcer.textContent = '';
  window.setTimeout(() => { els.announcer.textContent = text; }, 20);
}

function setAdvancedControlsDisabled(disabled) {
  $$('#sizeSelector input, #connections, #precisionToggle').forEach((control) => { control.disabled = disabled; });
  if (!disabled) applyPayloadCapabilityLimits();
}

function syncControlsForState(uiState) {
  const active = ACTIVE_STATES.has(uiState);
  els.stop.hidden = !active || uiState === UI_STATES.CANCELLING;
  els.start.hidden = active;
  setAdvancedControlsDisabled(active);

  if (!active) {
    els.start.disabled = uiState === UI_STATES.BOOTING || uiState === UI_STATES.SERVER_READY;
    if (!state.initialized && uiState === UI_STATES.ERROR) els.start.textContent = 'Повторить подключение';
    else if ([UI_STATES.COMPLETE, UI_STATES.CANCELLED, UI_STATES.ERROR].includes(uiState)) els.start.textContent = 'Повторить тест';
    else els.start.textContent = 'Начать тест';
  }
}

const machine = createStateMachine({
  initial: UI_STATES.BOOTING,
  onChange({ current, meta, detail }) {
    document.body.dataset.appState = current;
    els.phase.textContent = meta.label;
    els.phaseDescription.textContent = detail.description || phaseDescriptionFor(current);
    syncControlsForState(current);
    if ([UI_STATES.LATENCY, UI_STATES.CALIBRATING_DOWNLOAD, UI_STATES.CALIBRATING_UPLOAD, UI_STATES.ANALYZING].includes(current)) {
      setLiveSpeed(null);
    }
    if (ANNOUNCED_STATES.has(current)) announce(meta.announcement);
  },
});

function transition(next, detail = {}) {
  return machine.transition(next, detail);
}

function setPhaseDetail(text) {
  if (text) els.phaseDescription.textContent = text;
}

function api(path, base = state.apiBase) {
  return `${base || ''}${path}`;
}

function setLiveSpeed(value) {
  els.speed.textContent = Number.isFinite(value) ? formatThroughput(value) : '—';
  els.liveUnit.textContent = 'Mbps';
}

function setLivePing(value) {
  els.ping.textContent = Number.isFinite(value) ? formatLatency(value) : '—';
}

function setNotice(text = '', tone = 'neutral') {
  els.notice.textContent = text;
  els.notice.dataset.tone = tone;
  els.notice.hidden = !text;
}

function setServerStatus(text, status = 'connecting') {
  els.serverStatus.textContent = text;
  els.serverState.dataset.status = status;
}

class TelemetryPresenter {
  constructor() {
    this.latestSpeed = null;
    this.latestPing = null;
    this.numericTimer = null;
  }

  publishSpeed(value) {
    if (!Number.isFinite(value) || value < 0) return;
    this.latestSpeed = value;
    this.scheduleNumeric();
  }

  publishPing(value) {
    if (!Number.isFinite(value) || value < 0) return;
    this.latestPing = value;
    this.scheduleNumeric();
  }

  scheduleNumeric() {
    if (this.numericTimer != null) return;
    this.numericTimer = window.setTimeout(() => {
      this.numericTimer = null;
      if (this.latestSpeed != null) setLiveSpeed(this.latestSpeed);
      if (this.latestPing != null) setLivePing(this.latestPing);
    }, 120);
  }

  clearLiveSpeed() {
    this.latestSpeed = null;
    setLiveSpeed(null);
  }

  reset() {
    if (this.numericTimer != null) window.clearTimeout(this.numericTimer);
    this.numericTimer = null;
    this.latestSpeed = null;
    this.latestPing = null;
    setLiveSpeed(null);
  }
}

function niceCeiling(value) {
  if (!Number.isFinite(value) || value <= 0) return 10;
  const power = 10 ** Math.floor(Math.log10(value));
  const normalized = value / power;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * power;
}

class ChartRenderer {
  constructor(canvas, frame) {
    this.canvas = canvas;
    this.frame = frame;
    this.ctx = canvas.getContext('2d');
    this.cssWidth = 0;
    this.cssHeight = 220;
    this.dpr = 1;
    this.renderTimer = null;
    this.renderCount = 0;
    this.colors = null;

    if ('ResizeObserver' in window) {
      this.resizeObserver = new ResizeObserver(() => this.requestRender());
      this.resizeObserver.observe(frame);
    } else {
      window.addEventListener('resize', () => this.requestRender(), { passive: true });
    }
    window.addEventListener('orientationchange', () => this.requestRender(), { passive: true });
  }

  requestRender() {
    if (!els.expertDetails.open || els.expertDetails.hidden) return;
    if (this.renderTimer != null) return;
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      this.render(state.downloadSeries, state.uploadSeries);
    }, 80);
  }

  readColors() {
    if (this.colors) return this.colors;
    const styles = getComputedStyle(document.documentElement);
    this.colors = {
      down: styles.getPropertyValue('--accent-download').trim() || '#1557b0',
      up: styles.getPropertyValue('--accent-upload').trim() || '#2f6f5e',
      rule: styles.getPropertyValue('--rule').trim() || '#dedfda',
      muted: styles.getPropertyValue('--muted').trim() || '#72767b',
    };
    return this.colors;
  }

  ensureSize() {
    const rect = this.frame.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = 220;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (width === this.cssWidth && height === this.cssHeight && dpr === this.dpr) return false;
    this.cssWidth = width;
    this.cssHeight = height;
    this.dpr = dpr;
    const backingWidth = Math.max(1, Math.round(width * dpr));
    const backingHeight = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width !== backingWidth) this.canvas.width = backingWidth;
    if (this.canvas.height !== backingHeight) this.canvas.height = backingHeight;
    return true;
  }

  clear() {
    if (!els.expertDetails.open || els.expertDetails.hidden) return;
    this.ensureSize();
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
  }

  render(download, upload) {
    if (!els.expertDetails.open || els.expertDetails.hidden) return;
    this.ensureSize();
    const ctx = this.ctx;
    const width = this.cssWidth;
    const height = this.cssHeight;
    const colors = this.readColors();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const down = decimateSeries(download, 240);
    const up = decimateSeries(upload, 240);
    const all = down.concat(up);
    const pad = { left: 38, right: 10, top: 18, bottom: 24 };
    const plotWidth = Math.max(1, width - pad.left - pad.right);
    const plotHeight = Math.max(1, height - pad.top - pad.bottom);
    const maxValue = niceCeiling(Math.max(10, ...all.map((point) => point.v)) * 1.02);
    const maxTime = Math.max(1, ...all.map((point) => point.t));

    ctx.lineWidth = 1;
    ctx.strokeStyle = colors.rule;
    ctx.fillStyle = colors.muted;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textBaseline = 'middle';

    for (let index = 0; index <= 4; index += 1) {
      const ratio = index / 4;
      const y = pad.top + plotHeight * ratio;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(width - pad.right, y);
      ctx.stroke();
      const labelValue = maxValue * (1 - ratio);
      ctx.fillText(labelValue >= 1000 ? labelValue.toFixed(0) : labelValue.toFixed(labelValue < 10 ? 1 : 0), 2, y);
    }

    ctx.textBaseline = 'alphabetic';
    ctx.fillText('0 s', pad.left, height - 5);
    const timeLabel = `${maxTime < 10 ? maxTime.toFixed(1) : maxTime.toFixed(0)} s`;
    const timeWidth = ctx.measureText(timeLabel).width;
    ctx.fillText(timeLabel, width - pad.right - timeWidth, height - 5);
    ctx.fillText('Mbps', 2, 10);

    function plot(series, stroke) {
      if (!series.length) return;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let previous = null;
      for (const point of series) {
        const x = pad.left + plotWidth * point.t / maxTime;
        const y = pad.top + plotHeight * (1 - point.v / maxValue);
        if (!previous || point.t - previous.t > 1.0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        previous = point;
      }
      ctx.stroke();
    }

    plot(down, colors.down);
    plot(up, colors.up);
    this.renderCount += 1;
  }
}

const presenter = new TelemetryPresenter();
const chartRenderer = new ChartRenderer(els.chart, els.chartFrame);

function applyPayloadCapabilityLimits() {
  if (!state.capabilities) return;
  const maxMiB = state.capabilities.maxTransferMiB || 500;
  $$('#sizeSelector input[name="payload"]').forEach((input) => {
    if (input.value === 'auto') return;
    input.disabled = Number(input.value) > maxMiB || ACTIVE_STATES.has(machine.current);
  });
}

function resetResultText() {
  [
    'ping', 'jitter', 'down', 'up', 'loadedDown', 'loadedUp', 'probeLoss', 'bufferbloat',
    'stabilityDown', 'stabilityUp', 'p50', 'p90', 'p95', 'p99', 'downCi', 'upCi', 'data',
    'downRuns', 'upRuns', 'outliers', 'streams', 'payload', 'protocol', 'family', 'measurementNode',
    'downloadTiming', 'uploadTiming', 'pressure',
  ].forEach((key) => { els[key].textContent = '—'; });
}

function resetResults() {
  state.totalBytes = 0;
  state.downloadSeries = [];
  state.uploadSeries = [];
  state.finalResult = null;
  presenter.reset();
  resetResultText();
  els.qualitySection.hidden = true;
  els.expertDetails.hidden = true;
  els.expertDetails.open = false;
  els.errorPanel.hidden = true;
  els.chartSummary.textContent = 'График появится после измерения.';
  els.confidenceText.textContent = '95% CI публикуется только для достаточного числа повторных прогонов; это не «процент точности».';
  setNotice('');
}

function clearPartialResults() {
  state.finalResult = null;
  resetResultText();
  presenter.reset();
  els.qualitySection.hidden = true;
  els.expertDetails.hidden = true;
  els.expertDetails.open = false;
}

function addMeasuredBytes(bytes) {
  state.totalBytes += bytes;
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isAbort(error) {
  return error?.name === 'AbortError' || error?.message === 'stopped' || error?.message === 'stale-run';
}

function assertRunActive(runToken) {
  if (!state.running || runToken !== state.runToken) throw new DOMException('stale-run', 'AbortError');
}

function createTrackedController() {
  const controller = new AbortController();
  state.aborters.add(controller);
  return controller;
}

function releaseController(controller) {
  state.aborters.delete(controller);
}

function abortActiveRequests() {
  for (const controller of state.aborters) {
    try { controller.abort(); } catch {}
  }
  state.aborters.clear();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
  const controller = createTrackedController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { cache: 'no-store', ...options, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
    releaseController(controller);
  }
}

async function fetchJson(path, options = {}, timeoutMs = 4000, base = state.apiBase) {
  const response = await fetchWithTimeout(api(path, base), options, timeoutMs);
  if (!response.ok) {
    const retryAfter = Number(response.headers.get('retry-after'));
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.retryAfter = Number.isFinite(retryAfter) ? retryAfter : null;
    throw error;
  }
  return response.json();
}

async function probeOnce(base = state.apiBase, timeoutMs = 2500, label = '') {
  const started = performance.now();
  try {
    const response = await fetchWithTimeout(api(`/api/ping?n=${crypto.randomUUID()}&label=${encodeURIComponent(label)}`, base), {}, timeoutMs);
    if (response.status !== 204) return { ok: false, latencyMs: null };
    return { ok: true, latencyMs: performance.now() - started };
  } catch (error) {
    if (isAbort(error) && !state.running && label !== 'server-selection') throw error;
    return { ok: false, latencyMs: null };
  }
}

async function idleLatencyTest(runToken) {
  transition(UI_STATES.LATENCY);
  const samples = [];
  let sent = 0;
  let failed = 0;
  const warmupCount = 4;
  const attempts = state.precise ? 40 : 24;
  for (let index = 0; index < attempts; index += 1) {
    assertRunActive(runToken);
    const result = await probeOnce(state.apiBase, 2500, 'idle');
    sent += 1;
    if (result.ok) {
      if (index >= warmupCount) samples.push(result.latencyMs);
      const current = latencySummary(samples);
      if (current) presenter.publishPing(current.p50);
    } else if (index >= warmupCount) {
      failed += 1;
    }
    await sleep(55);
  }
  assertRunActive(runToken);
  const summary = latencySummary(samples);
  if (!summary || summary.count < 12) throw new Error('Insufficient successful latency probes');
  const measuredSent = Math.max(1, sent - warmupCount);
  const loss = probeLoss(measuredSent, failed);
  presenter.publishPing(summary.p50);
  return { samples, summary, sent: measuredSent, failed, probeLossPct: loss };
}

function supportsStreamingUpload() {
  const negotiatedProtocol = String(state.nextHopProtocol || '').toLowerCase();
  const transportSupportsStreaming = negotiatedProtocol === 'h2' || negotiatedProtocol.startsWith('h3');
  if (!transportSupportsStreaming) return false;
  try {
    if (typeof ReadableStream === 'undefined' || typeof Request === 'undefined') return false;
    let duplexAccessed = false;
    const body = new ReadableStream({ start(controller) { controller.close(); } });
    const request = new Request(location.href, {
      method: 'POST',
      body,
      get duplex() { duplexAccessed = true; return 'half'; },
    });
    return duplexAccessed && request.body instanceof ReadableStream;
  } catch {
    return false;
  }
}

function recordSeries(kind, value) {
  if (!Number.isFinite(value) || value < 0) return;
  const point = { t: (performance.now() - state.testStartedAt) / 1000, v: value };
  (kind === 'down' ? state.downloadSeries : state.uploadSeries).push(point);
  presenter.publishSpeed(value);
}

async function downloadRun(totalBytes, streams, runToken, { record = true, account = false } = {}) {
  const started = performance.now();
  let received = 0;
  let lastReceived = 0;
  let lastTime = started;
  let intervalIndex = 0;
  const stabilitySamples = [];
  const allocations = splitBytes(totalBytes, streams);
  const jobs = allocations.map(async (bytes) => {
    const controller = createTrackedController();
    try {
      const response = await fetch(api(`/api/download?bytes=${bytes}&n=${crypto.randomUUID()}`), { cache: 'no-store', signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(`Download failed (${response.status})`);
      const expected = Number(response.headers.get('x-test-bytes'));
      if (Number.isFinite(expected) && expected !== bytes) throw new Error('Download server byte count mismatch');
      const reader = response.body.getReader();
      while (true) {
        assertRunActive(runToken);
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        const now = performance.now();
        if (record && now - lastTime >= 220) {
          const deltaBytes = received - lastReceived;
          const deltaSeconds = (now - lastTime) / 1000;
          const sampleMbps = deltaBytes * 8 / deltaSeconds / 1_000_000;
          recordSeries('down', sampleMbps);
          if (intervalIndex > 0 && Number.isFinite(sampleMbps) && sampleMbps > 0) stabilitySamples.push(sampleMbps);
          intervalIndex += 1;
          lastReceived = received;
          lastTime = now;
        }
      }
    } finally {
      releaseController(controller);
    }
  });
  await Promise.all(jobs);
  assertRunActive(runToken);
  const elapsedSeconds = (performance.now() - started) / 1000;
  if (received !== totalBytes) throw new Error(`Download received ${received} of ${totalBytes} bytes`);
  const mbps = received * 8 / elapsedSeconds / 1_000_000;
  if (record) recordSeries('down', mbps);
  if (account) addMeasuredBytes(received);
  return { mbps, bytes: received, elapsedSeconds, stabilitySamples, timing: 'client-receive-wall-clock' };
}

function createUploadStream(bytes, runToken) {
  let remaining = bytes;
  return new ReadableStream({
    pull(controller) {
      try { assertRunActive(runToken); } catch (error) { controller.error(error); return; }
      if (remaining <= 0) {
        controller.close();
        return;
      }
      const size = Math.min(remaining, ZERO_64K.byteLength);
      controller.enqueue(size === ZERO_64K.byteLength ? ZERO_64K : ZERO_64K.subarray(0, size));
      remaining -= size;
      if (remaining === 0) controller.close();
    },
  });
}

async function pollUploadProgress(ids, flag, record, stabilitySamples, runToken) {
  let previousBytes = 0;
  let previousTime = performance.now();
  let intervalIndex = 0;
  while (flag.active && state.running && runToken === state.runToken) {
    try {
      const data = await fetchJson(`/api/progress?ids=${ids.join(',')}`, {}, 1800);
      const currentBytes = (data.transfers || []).reduce((sum, item) => sum + item.received, 0);
      const now = performance.now();
      if (record && currentBytes > previousBytes && now - previousTime >= 180) {
        const mbps = (currentBytes - previousBytes) * 8 / ((now - previousTime) / 1000) / 1_000_000;
        recordSeries('up', mbps);
        if (intervalIndex > 0 && Number.isFinite(mbps) && mbps > 0) stabilitySamples.push(mbps);
        intervalIndex += 1;
        previousBytes = currentBytes;
        previousTime = now;
      }
    } catch (error) {
      if (isAbort(error) && !state.running) throw error;
    }
    await sleep(220);
  }
}

async function streamingUploadRun(totalBytes, streams, runToken, { record = true, account = false } = {}) {
  const allocations = splitBytes(totalBytes, streams);
  const ids = allocations.map(() => crypto.randomUUID());
  const clientStarted = performance.now();
  const flag = { active: true };
  const stabilitySamples = [];
  const polling = pollUploadProgress(ids, flag, record, stabilitySamples, runToken);
  let serverReceived = 0;
  const serverWindows = [];

  try {
    await Promise.all(allocations.map(async (bytes, index) => {
      const controller = createTrackedController();
      try {
        const response = await fetch(api(`/api/upload?id=${ids[index]}`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: createUploadStream(bytes, runToken),
          duplex: 'half',
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Upload failed (${response.status})`);
        const result = await response.json();
        if (result.received !== bytes) throw new Error('Upload server byte count mismatch');
        serverReceived += result.received;
        serverWindows.push(result);
      } finally {
        releaseController(controller);
      }
    }));
  } finally {
    flag.active = false;
    await polling.catch(() => {});
  }

  assertRunActive(runToken);
  if (serverReceived !== totalBytes) throw new Error(`Upload received ${serverReceived} of ${totalBytes} bytes`);
  const receiveWindow = receiveWindowSummary(serverWindows);
  const clientElapsedSeconds = (performance.now() - clientStarted) / 1000;
  const elapsedSeconds = receiveWindow ? receiveWindow.elapsedMs / 1000 : clientElapsedSeconds;
  const mbps = receiveWindow?.mbps ?? (serverReceived * 8 / clientElapsedSeconds / 1_000_000);
  if (record) recordSeries('up', mbps);
  if (account) addMeasuredBytes(serverReceived);
  return {
    mbps,
    bytes: serverReceived,
    elapsedSeconds,
    stabilitySamples,
    mode: 'streaming',
    timing: receiveWindow ? 'server-receive-window' : 'client-end-to-end-fallback',
  };
}

async function fallbackUploadRun(totalBytes, streams, runToken, { record = true, account = false } = {}) {
  let remaining = totalBytes;
  let completedBytes = 0;
  let lastBytes = 0;
  let lastTime = performance.now();
  const clientStarted = lastTime;
  const serverWindows = [];
  const stabilitySamples = [];

  async function worker() {
    while (state.running && runToken === state.runToken) {
      const size = Math.min(FALLBACK_UPLOAD_CHUNK.size, remaining);
      if (size <= 0) return;
      remaining -= size;
      const body = size === FALLBACK_UPLOAD_CHUNK.size ? FALLBACK_UPLOAD_CHUNK : FALLBACK_UPLOAD_CHUNK.slice(0, size);
      const controller = createTrackedController();
      try {
        const response = await fetch(api(`/api/upload?id=${crypto.randomUUID()}`), {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body, cache: 'no-store', signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Upload failed (${response.status})`);
        const result = await response.json();
        if (result.received !== size) throw new Error('Upload server byte count mismatch');
        completedBytes += result.received;
        serverWindows.push(result);
        if (Number.isFinite(result.serverMeasuredMbps) && result.serverMeasuredMbps > 0) stabilitySamples.push(result.serverMeasuredMbps);
        const now = performance.now();
        if (record && now - lastTime >= 180) {
          recordSeries('up', (completedBytes - lastBytes) * 8 / ((now - lastTime) / 1000) / 1_000_000);
          lastBytes = completedBytes;
          lastTime = now;
        }
      } finally {
        releaseController(controller);
      }
    }
  }

  await Promise.all(Array.from({ length: streams }, () => worker()));
  assertRunActive(runToken);
  if (completedBytes !== totalBytes) throw new Error(`Upload received ${completedBytes} of ${totalBytes} bytes`);
  const receiveWindow = receiveWindowSummary(serverWindows);
  const clientElapsedSeconds = (performance.now() - clientStarted) / 1000;
  const elapsedSeconds = receiveWindow ? receiveWindow.elapsedMs / 1000 : clientElapsedSeconds;
  const mbps = receiveWindow?.mbps ?? (completedBytes * 8 / clientElapsedSeconds / 1_000_000);
  if (record) recordSeries('up', mbps);
  if (account) addMeasuredBytes(completedBytes);
  return {
    mbps,
    bytes: completedBytes,
    elapsedSeconds,
    stabilitySamples,
    mode: 'chunked-fallback',
    timing: receiveWindow ? 'server-receive-window' : 'client-end-to-end-fallback',
  };
}

async function uploadRun(totalBytes, streams, runToken, options = {}) {
  return supportsStreamingUpload()
    ? streamingUploadRun(totalBytes, streams, runToken, options)
    : fallbackUploadRun(totalBytes, streams, runToken, options);
}

async function warmUp(kind, streams, runToken, resumeState) {
  const warmState = kind === 'down' ? UI_STATES.WARMING_DOWNLOAD : UI_STATES.WARMING_UPLOAD;
  transition(warmState);
  const bytes = Math.min(512 * 1024 * streams, 4 * MIB);
  if (kind === 'down') await downloadRun(bytes, streams, runToken, { record: false, account: false });
  else await uploadRun(bytes, streams, runToken, { record: false, account: false });
  await sleep(120);
  assertRunActive(runToken);
  transition(resumeState);
}

function autoStreamCandidates() {
  const protocol = String(state.nextHopProtocol || '').toLowerCase();
  return protocol === 'h2' || protocol === 'h3' || protocol.startsWith('h3-') ? [2, 4, 8] : [2, 4];
}

async function calibrate(kind, runToken) {
  const calibrationState = kind === 'down' ? UI_STATES.CALIBRATING_DOWNLOAD : UI_STATES.CALIBRATING_UPLOAD;
  const requested = state.connections;
  if (requested !== 'auto') {
    const streams = Number(requested);
    await warmUp(kind, streams, runToken, calibrationState);
    const calibrationBytes = Math.min(4 * MIB * streams, 16 * MIB, state.capabilities.maxTransferBytes);
    const result = kind === 'down'
      ? await downloadRun(calibrationBytes, streams, runToken, { record: false })
      : await uploadRun(calibrationBytes, streams, runToken, { record: false });
    return { streams, mbps: result.mbps, scaling: [{ streams, mbps: result.mbps }] };
  }

  let streams = 1;
  await warmUp(kind, streams, runToken, calibrationState);
  let calibrationBytes = Math.min(4 * MIB, state.capabilities.maxTransferBytes);
  let result = kind === 'down'
    ? await downloadRun(calibrationBytes, streams, runToken, { record: false })
    : await uploadRun(calibrationBytes, streams, runToken, { record: false });
  let bestMbps = result.mbps;
  const scaling = [{ streams, mbps: bestMbps }];

  for (const candidate of autoStreamCandidates()) {
    assertRunActive(runToken);
    await warmUp(kind, candidate, runToken, calibrationState);
    calibrationBytes = chooseAdaptiveBytes(bestMbps, {
      minBytes: 4 * MIB,
      maxBytes: Math.min(24 * MIB, state.capabilities.maxTransferBytes),
      targetSeconds: 0.75,
    });
    result = kind === 'down'
      ? await downloadRun(calibrationBytes, candidate, runToken, { record: false })
      : await uploadRun(calibrationBytes, candidate, runToken, { record: false });
    scaling.push({ streams: candidate, mbps: result.mbps });
    if (!shouldIncreaseStreams(bestMbps, result.mbps, streams)) break;
    streams = candidate;
    bestMbps = result.mbps;
  }
  return { streams, mbps: bestMbps, scaling };
}

async function collectLoadedLatency(flag, label, runToken) {
  const samples = [];
  let sent = 0;
  let failed = 0;
  await sleep(80);
  while (flag.active && state.running && runToken === state.runToken) {
    const result = await probeOnce(state.apiBase, 3000, label);
    sent += 1;
    if (result.ok) samples.push(result.latencyMs);
    else failed += 1;
    await sleep(110);
  }
  return { samples, sent, failed, summary: latencySummary(samples) };
}

async function runMainThroughput(kind, calibration, runToken) {
  const phaseState = kind === 'down' ? UI_STATES.DOWNLOADING : UI_STATES.UPLOADING;
  transition(phaseState);
  const targetSeconds = state.precise ? 6.5 : 5;
  const manualBytes = state.sizeMode === 'manual' ? state.sizeMB * MB : null;
  const totalBytes = manualBytes ?? chooseAdaptiveBytes(calibration.mbps, {
    minBytes: 2 * MIB,
    maxBytes: state.capabilities.maxTransferBytes,
    targetSeconds,
  });
  const runs = chooseRunCount({ precise: state.precise, totalBytes });
  const values = [];
  const stabilitySamples = [];
  const loadedSamples = [];
  let loadedFailed = 0;
  let loadedSent = 0;
  const timingMethods = new Set();

  for (let run = 0; run < runs; run += 1) {
    assertRunActive(runToken);
    setPhaseDetail(`${kind === 'down' ? 'Download' : 'Upload'} · основной прогон ${run + 1} из ${runs}`);
    await warmUp(kind, calibration.streams, runToken, phaseState);
    setPhaseDetail(`${kind === 'down' ? 'Download' : 'Upload'} · основной прогон ${run + 1} из ${runs}`);
    const flag = { active: true };
    const sampler = collectLoadedLatency(flag, kind, runToken);
    let result;
    try {
      result = kind === 'down'
        ? await downloadRun(totalBytes, calibration.streams, runToken, { record: true, account: true })
        : await uploadRun(totalBytes, calibration.streams, runToken, { record: true, account: true });
    } finally {
      flag.active = false;
    }
    const loaded = await sampler;
    loadedSamples.push(...loaded.samples);
    loadedFailed += loaded.failed;
    loadedSent += loaded.sent;
    stabilitySamples.push(...(result.stabilitySamples || []));
    if (result.timing) timingMethods.add(result.timing);
    values.push(result.mbps);
    if (run < runs - 1) await sleep(250);
  }

  return {
    totalBytes,
    runs,
    streams: calibration.streams,
    values,
    stabilitySamples,
    timingMethods: [...timingMethods],
    summary: summarizeThroughputRuns(values),
    loaded: {
      samples: loadedSamples,
      sent: loadedSent,
      failed: loadedFailed,
      qualification: qualifyLatencySamples(loadedSamples, { sent: loadedSent, failed: loadedFailed }),
    },
  };
}

function stabilityCv(samples) {
  const filtered = samples.filter((value) => Number.isFinite(value) && value > 0);
  return filtered.length >= 5 ? coefficientOfVariation(filtered) : null;
}

async function healthCheck() {
  try {
    return await fetchJson('/api/health', {}, 2500);
  } catch {
    return null;
  }
}

function analyzeServerRisk(before, after, calibrations) {
  const beforeRisk = serverPressureRisk(before);
  const afterRisk = serverPressureRisk(after);
  const elevated = [beforeRisk, afterRisk].filter((risk) => risk.level === 'elevated');
  const noScale = calibrations.some((calibration) => calibration.scaling.length > 1 && calibration.streams === 1);
  const reasons = [...new Set(elevated.flatMap((risk) => risk.reasons))];
  if (elevated.length && noScale) {
    return { level: 'elevated', reasons, message: `Server-side contention risk detected (${reasons.join(', ')}). Result may be server-limited.` };
  }
  if (elevated.length) {
    return { level: 'elevated', reasons, message: 'Measurement node was under elevated runtime pressure; interpret the result cautiously.' };
  }
  if (beforeRisk.level === 'unknown' && afterRisk.level === 'unknown') return { level: 'unknown', reasons: [], message: '' };
  return { level: 'low', reasons: [], message: '' };
}

function confidenceText(down, up) {
  const removed = (down?.removed || 0) + (up?.removed || 0);
  const ciNote = down?.confidence95 && up?.confidence95
    ? '95% bootstrap CI of the run-level median.'
    : 'Недостаточно повторных прогонов для 95% interval.';
  const outlierNote = removed ? `${removed} MAD outlier run(s) excluded.` : 'Run-level outliers не исключались.';
  return `${ciNote} ${outlierNote}`;
}

function ciText(summary) {
  if (!summary?.confidence95) return '—';
  return `${formatThroughput(summary.confidence95.lower)}–${formatThroughput(summary.confidence95.upper)} Mbps`;
}

function timingLabel(methods) {
  if (!methods?.length) return '—';
  return methods.map((method) => {
    if (method === 'client-receive-wall-clock') return 'Browser receive wall-clock';
    if (method === 'server-receive-window') return 'Server monotonic receive-window';
    if (method === 'client-end-to-end-fallback') return 'Client end-to-end fallback';
    return method;
  }).join(' · ');
}

function seriesDescription(label, series) {
  if (!series.length) return `${label}: нет отображаемых telemetry samples.`;
  const values = series.map((point) => point.v).filter(Number.isFinite);
  if (!values.length) return `${label}: нет валидных telemetry samples.`;
  return `${label}: ${values.length} samples, диапазон ${formatThroughput(Math.min(...values))}–${formatThroughput(Math.max(...values))} Mbps.`;
}

function renderFinalResult(result) {
  const { idle, download, upload, quality, evidence, pressure } = result;
  els.down.textContent = formatThroughput(download.summary?.medianMbps);
  els.up.textContent = formatThroughput(upload.summary?.medianMbps);
  els.ping.textContent = formatLatency(idle.summary.p50);
  els.jitter.textContent = formatLatency(idle.summary.jitter);
  els.probeLoss.textContent = formatPercent(idle.probeLossPct);
  els.p50.textContent = formatLatency(idle.summary.p50);
  els.p90.textContent = formatLatency(idle.summary.p90);
  els.p95.textContent = formatLatency(idle.summary.p95);
  els.p99.textContent = formatLatency(idle.summary.p99);
  els.loadedDown.textContent = formatLatency(quality.loadedDownMs);
  els.loadedUp.textContent = formatLatency(quality.loadedUpMs);
  els.stabilityDown.textContent = formatCv(quality.downloadCv);
  els.stabilityUp.textContent = formatCv(quality.uploadCv);
  els.bufferbloat.textContent = quality.bufferbloat ? `+${formatLatency(quality.bufferbloat.worstIncreaseMs)} ms` : '—';
  els.downCi.textContent = ciText(download.summary);
  els.upCi.textContent = ciText(upload.summary);
  els.data.textContent = formatBytes(evidence.measuredBytes);
  els.downRuns.textContent = `${download.summary?.raw.length || 0} / ${download.summary?.used.length || 0}`;
  els.upRuns.textContent = `${upload.summary?.raw.length || 0} / ${upload.summary?.used.length || 0}`;
  els.outliers.textContent = String((download.summary?.removed || 0) + (upload.summary?.removed || 0));
  els.streams.textContent = `${download.streams} down · ${upload.streams} up`;
  els.payload.textContent = `${formatBytes(download.totalBytes)} down · ${formatBytes(upload.totalBytes)} up / run`;
  els.protocol.textContent = evidence.protocol || '—';
  els.family.textContent = evidence.addressFamily || '—';
  els.measurementNode.textContent = evidence.node || '—';
  els.downloadTiming.textContent = timingLabel(download.timingMethods);
  els.uploadTiming.textContent = timingLabel(upload.timingMethods);
  els.pressure.textContent = pressure.level === 'elevated'
    ? `Elevated${pressure.reasons.length ? ` · ${pressure.reasons.join(', ')}` : ''}`
    : pressure.level === 'low' ? 'Low' : 'Unknown';
  els.confidenceText.textContent = confidenceText(download.summary, upload.summary);
  els.nodeInfo.textContent = `${evidence.node || 'measurement node'} · ${evidence.addressFamily || 'network'}`;
  els.chartSummary.textContent = `${seriesDescription('Download', state.downloadSeries)} ${seriesDescription('Upload', state.uploadSeries)} График не сглаживает значения и разрывает линию между временно удалёнными samples.`;

  els.errorPanel.hidden = true;
  els.qualitySection.hidden = false;
  els.expertDetails.hidden = false;

  const invalidLoaded = [download.loaded.qualification, upload.loaded.qualification].filter((item) => !item.valid);
  const loadedFailures = download.loaded.failed + upload.loaded.failed;
  if (pressure.message) setNotice(pressure.message, 'warning');
  else if (invalidLoaded.length) setNotice('Loaded latency не прошла минимальный quality threshold, поэтому bufferbloat не опубликован как финальная метрика.', 'warning');
  else if (loadedFailures > 0) setNotice(`${loadedFailures} HTTP probe(s) под нагрузкой завершились timeout; опубликованные loaded-latency метрики всё равно прошли qualification threshold.`, 'warning');
  else setNotice('');
}

function renderError(info) {
  clearPartialResults();
  els.errorTitle.textContent = info.title;
  els.errorMessage.textContent = info.message;
  els.errorAction.textContent = info.action;
  els.errorValidity.textContent = info.partialValid ? 'Доступные частичные данные отмечены отдельно.' : 'Частичный результат не считается финальным.';
  els.errorDiagnostic.textContent = info.diagnostic;
  els.errorPanel.hidden = false;
  setNotice('');
}

async function startTest() {
  if (state.running || !state.initialized) return;
  const runToken = ++state.runToken;
  state.running = true;
  state.aborters.clear();
  state.cancelReason = null;
  state.lifecycleInvalidated = false;
  state.lifecycleReason = '';
  state.testStartedAt = performance.now();
  state.connections = els.connections.value;
  state.precise = els.precision.checked;
  resetResults();
  els.settingsDetails.open = false;
  transition(UI_STATES.PREPARING);

  try {
    const beforeHealth = await healthCheck();
    assertRunActive(runToken);
    const idle = await idleLatencyTest(runToken);

    transition(UI_STATES.CALIBRATING_DOWNLOAD);
    const downCalibration = await calibrate('down', runToken);
    const downResult = await runMainThroughput('down', downCalibration, runToken);

    await sleep(250);
    assertRunActive(runToken);
    presenter.clearLiveSpeed();
    transition(UI_STATES.CALIBRATING_UPLOAD);
    const upCalibration = await calibrate('up', runToken);
    const upResult = await runMainThroughput('up', upCalibration, runToken);

    transition(UI_STATES.ANALYZING);
    const afterHealth = await healthCheck();
    assertRunActive(runToken);

    const downLoaded = downResult.loaded.qualification;
    const upLoaded = upResult.loaded.qualification;
    const loadedDownMs = downLoaded.valid ? downLoaded.summary.p50 : null;
    const loadedUpMs = upLoaded.valid ? upLoaded.summary.p50 : null;
    const bloat = downLoaded.valid && upLoaded.valid ? bufferbloatAnalysis(idle.summary.p50, loadedDownMs, loadedUpMs) : null;
    const pressure = analyzeServerRisk(beforeHealth, afterHealth, [downCalibration, upCalibration]);
    const node = state.serverInfo?.node || state.capabilities?.node || {};

    const finalResult = freezeFinalResult({
      completedAt: Date.now(),
      idle,
      download: downResult,
      upload: upResult,
      quality: {
        loadedDownMs,
        loadedUpMs,
        downloadCv: stabilityCv(downResult.stabilitySamples),
        uploadCv: stabilityCv(upResult.stabilitySamples),
        bufferbloat: bloat,
      },
      evidence: {
        measuredBytes: state.totalBytes,
        protocol: state.nextHopProtocol || state.serverInfo?.protocol || '',
        addressFamily: state.serverInfo?.clientFamily || '',
        node: node.id || node.region || 'measurement node',
      },
      pressure,
    });

    assertRunActive(runToken);
    state.finalResult = finalResult;
    renderFinalResult(finalResult);
    transition(UI_STATES.COMPLETE);
  } catch (error) {
    const cancelled = isAbort(error) || !state.running || runToken !== state.runToken;
    if (cancelled) {
      const lifecycle = state.cancelReason === 'lifecycle' || state.lifecycleInvalidated;
      if (lifecycle) {
        const info = classifyMeasurementError(error, { lifecycleInvalidated: true });
        if (machine.current !== UI_STATES.CANCELLING && canTransition(machine.current, UI_STATES.CANCELLING)) transition(UI_STATES.CANCELLING);
        if (canTransition(machine.current, UI_STATES.ERROR)) transition(UI_STATES.ERROR);
        renderError(info);
      } else {
        clearPartialResults();
        if (machine.current !== UI_STATES.CANCELLING && canTransition(machine.current, UI_STATES.CANCELLING)) transition(UI_STATES.CANCELLING);
        if (canTransition(machine.current, UI_STATES.CANCELLED)) transition(UI_STATES.CANCELLED);
        setNotice('Тест отменён. Частичные метрики отброшены и не считаются финальным результатом.', 'neutral');
      }
    } else {
      console.error(error);
      const info = classifyMeasurementError(error);
      clearPartialResults();
      if (canTransition(machine.current, UI_STATES.ERROR)) transition(UI_STATES.ERROR);
      renderError(info);
    }
  } finally {
    state.running = false;
    abortActiveRequests();
    setAdvancedControlsDisabled(false);
    syncControlsForState(machine.current);
  }
}

function stopTest(reason = 'user') {
  if (!state.running) return;
  state.cancelReason = reason;
  if (reason === 'lifecycle') state.lifecycleInvalidated = true;
  if (canTransition(machine.current, UI_STATES.CANCELLING)) transition(UI_STATES.CANCELLING);
  state.running = false;
  state.runToken += 1;
  abortActiveRequests();
}

async function probeCandidate(base) {
  const values = [];
  for (let index = 0; index < 3; index += 1) {
    const result = await probeOnce(base, 1800, 'server-selection');
    if (result.ok) values.push(result.latencyMs);
    await sleep(45);
  }
  return values.length >= 2 ? median(values) : null;
}

async function selectMeasurementServer() {
  setServerStatus('Selecting node…', 'connecting');
  let discovery;
  try {
    discovery = await fetchJson('/api/servers', {}, 2500, '');
  } catch {
    return '';
  }
  const candidates = [{ id: discovery.self?.id || 'current', region: discovery.self?.region || 'local', url: '' }];
  for (const server of discovery.servers || []) {
    if (server?.url && !candidates.some((candidate) => candidate.url === server.url)) candidates.push(server);
  }
  if (candidates.length === 1) return '';
  const scored = [];
  for (const candidate of candidates.slice(0, 8)) {
    try {
      const latency = await probeCandidate(candidate.url || '');
      if (latency != null) scored.push({ ...candidate, latency });
    } catch {}
  }
  scored.sort((a, b) => a.latency - b.latency);
  return scored[0]?.url || '';
}

function detectNextHopProtocol(path) {
  try {
    const url = new URL(api(path), location.href).href;
    const entries = performance.getEntriesByName(url);
    return entries.at(-1)?.nextHopProtocol || '';
  } catch {
    return '';
  }
}

async function initialize() {
  if (state.running) return;
  state.initialized = false;
  if (machine.current !== UI_STATES.BOOTING && canTransition(machine.current, UI_STATES.BOOTING)) transition(UI_STATES.BOOTING);
  syncControlsForState(UI_STATES.BOOTING);
  setServerStatus('Connecting…', 'connecting');
  els.errorPanel.hidden = true;
  const wakingTimer = window.setTimeout(() => {
    if (!state.initialized && machine.current === UI_STATES.BOOTING) setServerStatus('Measurement node waking…', 'connecting');
  }, 900);

  try {
    state.apiBase = await selectMeasurementServer();
    state.capabilities = await fetchJson('/api/capabilities', {}, 3000);
    state.serverInfo = await fetchJson('/api/info', {}, 3000);
    state.nextHopProtocol = detectNextHopProtocol('/api/info');
    const node = state.serverInfo.node || state.capabilities.node || {};
    state.initialized = true;
    setServerStatus(`${node.region || 'Local'} ready`, 'ready');
    els.nodeInfo.textContent = `${node.id || 'measurement node'} · ${state.serverInfo.clientFamily || 'network'}`;
    els.footerInfo.textContent = `${state.nextHopProtocol || state.serverInfo.protocol || 'HTTP'} · ${state.serverInfo.clientFamily || 'network'}`;
    applyPayloadCapabilityLimits();
    transition(UI_STATES.SERVER_READY);
    transition(UI_STATES.IDLE);
  } catch (error) {
    console.error(error);
    state.initialized = false;
    setServerStatus('Measurement service unavailable', 'error');
    if (canTransition(machine.current, UI_STATES.ERROR)) transition(UI_STATES.ERROR);
    renderError(classifyMeasurementError(error, { boot: true }));
    els.start.hidden = false;
    els.start.disabled = false;
    els.start.textContent = 'Повторить подключение';
  } finally {
    window.clearTimeout(wakingTimer);
  }
}

function handlePayloadChange(event) {
  const input = event.target.closest('input[name="payload"]');
  if (!input || state.running || input.disabled) return;
  if (input.value === 'auto') {
    state.sizeMode = 'auto';
    els.sizeHint.textContent = 'Adaptive duration';
  } else {
    state.sizeMode = 'manual';
    state.sizeMB = Number(input.value);
    els.sizeHint.textContent = `${state.sizeMB} MB / run`;
  }
}

function invalidateForLifecycle(reason) {
  if (!state.running) return;
  state.lifecycleReason = reason;
  state.lifecycleInvalidated = true;
  stopTest('lifecycle');
}

els.sizeSelector.addEventListener('change', handlePayloadChange);
els.precision.addEventListener('change', () => { if (!state.running) state.precise = els.precision.checked; });
els.connections.addEventListener('change', () => { if (!state.running) state.connections = els.connections.value; });
els.start.addEventListener('click', () => { if (state.initialized) startTest(); else initialize(); });
els.stop.addEventListener('click', () => stopTest('user'));
els.expertDetails.addEventListener('toggle', () => { if (els.expertDetails.open) chartRenderer.requestRender(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) invalidateForLifecycle('visibility-hidden'); });
window.addEventListener('pagehide', () => invalidateForLifecycle('pagehide'));
document.addEventListener('freeze', () => invalidateForLifecycle('freeze'));
window.addEventListener('pageshow', (event) => {
  if (event.persisted && !state.running) {
    state.initialized = false;
    initialize();
  }
});

window.__PSL_DIAGNOSTICS__ = Object.freeze({
  getState: () => machine.current,
  getFinalResult: () => state.finalResult,
  getChartRenderCount: () => chartRenderer.renderCount,
  supportsStreamingUpload,
});

syncControlsForState(UI_STATES.BOOTING);
initialize();
