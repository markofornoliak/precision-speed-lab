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

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const MB = 1_000_000;
const MIB = 1024 * 1024;
const ZERO_64K = new Uint8Array(64 * 1024);
const FALLBACK_UPLOAD_CHUNK = new Blob([new Uint8Array(8 * MIB)], { type: 'application/octet-stream' });

const state = {
  running: false,
  aborters: new Set(),
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
};

const els = {
  start: $('#startBtn'), stop: $('#stopBtn'), phase: $('#phaseLabel'), speed: $('#speedValue'), gauge: $('#gaugeProgress'),
  ping: $('#pingValue'), jitter: $('#jitterValue'), down: $('#downloadValue'), up: $('#uploadValue'),
  loadedDown: $('#loadedDownValue'), loadedUp: $('#loadedUpValue'), probeLoss: $('#probeLossValue'), bufferbloat: $('#bufferbloatValue'),
  stabilityDown: $('#stabilityDownValue'), stabilityUp: $('#stabilityUpValue'),
  p50: $('#p50Value'), p90: $('#p90Value'), p95: $('#p95Value'), p99: $('#p99Value'),
  downCi: $('#downCiValue'), upCi: $('#upCiValue'), confidenceText: $('#confidenceText'),
  data: $('#dataValue'), serverStatus: $('#serverStatus'), footerInfo: $('#footerInfo'), nodeInfo: $('#nodeInfo'),
  sizeHint: $('#sizeHint'), connections: $('#connections'), precision: $('#precisionToggle'), chart: $('#speedChart'),
  notice: $('#measurementNotice'),
};

function api(path, base = state.apiBase) {
  return `${base || ''}${path}`;
}

function formatSpeed(value) {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1000) return value.toFixed(1);
  if (value >= 100) return value.toFixed(1);
  if (value >= 10) return value.toFixed(2);
  return value.toFixed(3);
}

function formatMs(value) {
  return Number.isFinite(value) ? value.toFixed(value >= 100 ? 0 : 1) : '—';
}

function formatCv(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '—';
}

function setGauge(value) {
  const max = value < 100 ? 100 : value < 500 ? 500 : value < 1000 ? 1000 : value < 2500 ? 2500 : 10000;
  const ratio = Math.max(0, Math.min(1, value / max));
  els.gauge.style.strokeDashoffset = String(415 * (1 - ratio));
}

function updateLive(value) {
  els.speed.textContent = formatSpeed(value);
  setGauge(value);
}

function setPhase(text) {
  els.phase.textContent = text;
}

function setNotice(text = '', tone = 'neutral') {
  els.notice.textContent = text;
  els.notice.dataset.tone = tone;
  els.notice.hidden = !text;
}

function addMeasuredBytes(bytes) {
  state.totalBytes += bytes;
  const mb = state.totalBytes / MB;
  els.data.textContent = `${mb < 100 ? mb.toFixed(1) : mb.toFixed(0)} MB`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbort(error) {
  return error?.name === 'AbortError' || error?.message === 'stopped';
}

function createTrackedController() {
  const controller = new AbortController();
  state.aborters.add(controller);
  return controller;
}

function releaseController(controller) {
  state.aborters.delete(controller);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
  const controller = createTrackedController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { cache: 'no-store', ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
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

function resetResults() {
  state.totalBytes = 0;
  state.downloadSeries = [];
  state.uploadSeries = [];
  ['ping', 'jitter', 'down', 'up', 'loadedDown', 'loadedUp', 'probeLoss', 'bufferbloat', 'stabilityDown', 'stabilityUp', 'p50', 'p90', 'p95', 'p99', 'downCi', 'upCi']
    .forEach((key) => { els[key].textContent = '—'; });
  els.data.textContent = '0 MB';
  els.confidenceText.textContent = '95% CI показывается только для повторных прогонов; это не «процент точности».';
  updateLive(0);
  setNotice('');
  drawChart();
}

async function probeOnce(base = state.apiBase, timeoutMs = 2500, label = '') {
  const started = performance.now();
  try {
    const response = await fetchWithTimeout(api(`/api/ping?n=${crypto.randomUUID()}&label=${encodeURIComponent(label)}`, base), {}, timeoutMs);
    if (response.status !== 204) return { ok: false, latencyMs: null };
    return { ok: true, latencyMs: performance.now() - started };
  } catch (error) {
    if (isAbort(error) && !state.running) throw error;
    return { ok: false, latencyMs: null };
  }
}

async function idleLatencyTest() {
  setPhase('LATENCY');
  const samples = [];
  let sent = 0;
  let failed = 0;
  const warmupCount = 4;
  const attempts = state.precise ? 40 : 24;
  for (let index = 0; index < attempts; index += 1) {
    if (!state.running) throw new Error('stopped');
    const result = await probeOnce(state.apiBase, 2500, 'idle');
    sent += 1;
    if (result.ok) {
      if (index >= warmupCount) samples.push(result.latencyMs);
      const current = latencySummary(samples);
      if (current) els.ping.textContent = formatMs(current.p50);
    } else if (index >= warmupCount) {
      failed += 1;
    }
    await sleep(55);
  }
  const summary = latencySummary(samples);
  if (!summary || summary.count < 12) throw new Error('Insufficient successful latency probes');
  const measuredSent = Math.max(1, sent - warmupCount);
  const loss = probeLoss(measuredSent, failed);
  els.ping.textContent = formatMs(summary.p50);
  els.jitter.textContent = formatMs(summary.jitter);
  els.probeLoss.textContent = loss == null ? '—' : `${loss.toFixed(1)}%`;
  els.p50.textContent = formatMs(summary.p50);
  els.p90.textContent = formatMs(summary.p90);
  els.p95.textContent = formatMs(summary.p95);
  els.p99.textContent = formatMs(summary.p99);
  return { samples, summary, sent: measuredSent, failed, probeLossPct: loss };
}

function supportsStreamingUpload() {
  try {
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
  updateLive(value);
  drawChart();
}

async function downloadRun(totalBytes, streams, { record = true, account = false } = {}) {
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
      if (Number.isFinite(expected) && expected !== bytes) throw new Error('Server byte count mismatch');
      const reader = response.body.getReader();
      while (true) {
        if (!state.running) throw new DOMException('stopped', 'AbortError');
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
  const elapsedSeconds = (performance.now() - started) / 1000;
  if (received !== totalBytes) throw new Error(`Download received ${received} of ${totalBytes} bytes`);
  const mbps = received * 8 / elapsedSeconds / 1_000_000;
  if (record) recordSeries('down', mbps);
  if (account) addMeasuredBytes(received);
  return { mbps, bytes: received, elapsedSeconds, stabilitySamples, timing: 'client-receive-wall-clock' };
}

function createUploadStream(bytes) {
  let remaining = bytes;
  return new ReadableStream({
    pull(controller) {
      if (!state.running) {
        controller.error(new DOMException('stopped', 'AbortError'));
        return;
      }
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

async function pollUploadProgress(ids, flag, record, stabilitySamples) {
  let previousBytes = 0;
  let previousTime = performance.now();
  let intervalIndex = 0;
  while (flag.active && state.running) {
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

async function streamingUploadRun(totalBytes, streams, { record = true, account = false } = {}) {
  const allocations = splitBytes(totalBytes, streams);
  const ids = allocations.map(() => crypto.randomUUID());
  const clientStarted = performance.now();
  const flag = { active: true };
  const stabilitySamples = [];
  const polling = pollUploadProgress(ids, flag, record, stabilitySamples);
  let serverReceived = 0;
  const serverWindows = [];

  try {
    await Promise.all(allocations.map(async (bytes, index) => {
      const controller = createTrackedController();
      try {
        const response = await fetch(api(`/api/upload?id=${ids[index]}`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: createUploadStream(bytes),
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

async function fallbackUploadRun(totalBytes, streams, { record = true, account = false } = {}) {
  let remaining = totalBytes;
  let completedBytes = 0;
  let lastBytes = 0;
  let lastTime = performance.now();
  const clientStarted = lastTime;
  const serverWindows = [];
  const stabilitySamples = [];

  async function worker() {
    while (state.running) {
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

async function uploadRun(totalBytes, streams, options = {}) {
  return supportsStreamingUpload()
    ? streamingUploadRun(totalBytes, streams, options)
    : fallbackUploadRun(totalBytes, streams, options);
}

async function warmUp(kind, streams) {
  setPhase(`WARM-UP · ${kind === 'down' ? 'DOWNLOAD' : 'UPLOAD'}`);
  const bytes = Math.min(512 * 1024 * streams, 4 * MIB);
  if (kind === 'down') await downloadRun(bytes, streams, { record: false, account: false });
  else await uploadRun(bytes, streams, { record: false, account: false });
  await sleep(120);
}

function autoStreamCandidates() {
  const protocol = String(state.nextHopProtocol || '').toLowerCase();
  return protocol === 'h2' || protocol === 'h3' || protocol.startsWith('h3-') ? [2, 4, 8] : [2, 4];
}

async function calibrate(kind) {
  const requested = state.connections;
  if (requested !== 'auto') {
    const streams = Number(requested);
    await warmUp(kind, streams);
    const calibrationBytes = Math.min(4 * MIB * streams, 16 * MIB, state.capabilities.maxTransferBytes);
    const result = kind === 'down'
      ? await downloadRun(calibrationBytes, streams, { record: false })
      : await uploadRun(calibrationBytes, streams, { record: false });
    return { streams, mbps: result.mbps, scaling: [{ streams, mbps: result.mbps }] };
  }

  let streams = 1;
  await warmUp(kind, streams);
  let calibrationBytes = Math.min(4 * MIB, state.capabilities.maxTransferBytes);
  let result = kind === 'down'
    ? await downloadRun(calibrationBytes, streams, { record: false })
    : await uploadRun(calibrationBytes, streams, { record: false });
  let bestMbps = result.mbps;
  const scaling = [{ streams, mbps: bestMbps }];

  for (const candidate of autoStreamCandidates()) {
    if (!state.running) throw new Error('stopped');
    await warmUp(kind, candidate);
    calibrationBytes = chooseAdaptiveBytes(bestMbps, {
      minBytes: 4 * MIB,
      maxBytes: Math.min(24 * MIB, state.capabilities.maxTransferBytes),
      targetSeconds: 0.75,
    });
    result = kind === 'down'
      ? await downloadRun(calibrationBytes, candidate, { record: false })
      : await uploadRun(calibrationBytes, candidate, { record: false });
    scaling.push({ streams: candidate, mbps: result.mbps });
    if (!shouldIncreaseStreams(bestMbps, result.mbps, streams)) break;
    streams = candidate;
    bestMbps = result.mbps;
  }
  return { streams, mbps: bestMbps, scaling };
}

async function collectLoadedLatency(flag, label) {
  const samples = [];
  let sent = 0;
  let failed = 0;
  await sleep(80);
  while (flag.active && state.running) {
    const result = await probeOnce(state.apiBase, 3000, label);
    sent += 1;
    if (result.ok) samples.push(result.latencyMs);
    else failed += 1;
    await sleep(110);
  }
  return { samples, sent, failed, summary: latencySummary(samples) };
}

async function runMainThroughput(kind, calibration) {
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
    if (!state.running) throw new Error('stopped');
    setPhase(`${kind === 'down' ? 'DOWNLOAD' : 'UPLOAD'} · ${run + 1}/${runs}`);
    await warmUp(kind, calibration.streams);
    const flag = { active: true };
    const sampler = collectLoadedLatency(flag, kind);
    let result;
    try {
      result = kind === 'down'
        ? await downloadRun(totalBytes, calibration.streams, { record: true, account: true })
        : await uploadRun(totalBytes, calibration.streams, { record: true, account: true });
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
    const summary = summarizeThroughputRuns(values);
    const loadedQualified = qualifyLatencySamples(loadedSamples, { sent: loadedSent, failed: loadedFailed });
    (kind === 'down' ? els.down : els.up).textContent = summary ? formatSpeed(summary.medianMbps) : '—';
    (kind === 'down' ? els.loadedDown : els.loadedUp).textContent = loadedQualified.valid ? formatMs(loadedQualified.summary.p50) : '—';
    updateLive(result.mbps);
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

function showConfidence(kind, summary) {
  const target = kind === 'down' ? els.downCi : els.upCi;
  if (!summary?.confidence95) {
    target.textContent = '—';
    return;
  }
  target.textContent = `${formatSpeed(summary.confidence95.lower)}–${formatSpeed(summary.confidence95.upper)}`;
}

async function healthCheck() {
  try {
    return await fetchJson('/api/health', {}, 2500);
  } catch {
    return null;
  }
}

function analyzeServerRisk(before, after, calibrations) {
  const risks = [serverPressureRisk(before), serverPressureRisk(after)].filter((risk) => risk.level === 'elevated');
  const noScale = calibrations.some((calibration) => calibration.scaling.length > 1 && calibration.streams === 1);
  if (risks.length && noScale) {
    const reasons = [...new Set(risks.flatMap((risk) => risk.reasons))].join(', ');
    return `Server-side contention risk detected (${reasons}). Result may be server-limited.`;
  }
  if (risks.length) return 'Measurement node was under elevated runtime pressure; interpret the result cautiously.';
  return '';
}

async function startTest() {
  if (state.running) return;
  state.running = true;
  state.aborters = new Set();
  state.testStartedAt = performance.now();
  state.connections = els.connections.value;
  resetResults();
  els.start.disabled = true;
  els.stop.hidden = false;
  $$('#sizeSelector button').forEach((button) => { button.disabled = true; });
  els.connections.disabled = true;

  try {
    const beforeHealth = await healthCheck();
    const idle = await idleLatencyTest();

    setPhase('CALIBRATE · DOWNLOAD');
    const downCalibration = await calibrate('down');
    const downResult = await runMainThroughput('down', downCalibration);

    await sleep(250);
    setPhase('CALIBRATE · UPLOAD');
    const upCalibration = await calibrate('up');
    const upResult = await runMainThroughput('up', upCalibration);

    const down = downResult.summary;
    const up = upResult.summary;
    els.down.textContent = down ? formatSpeed(down.medianMbps) : '—';
    els.up.textContent = up ? formatSpeed(up.medianMbps) : '—';
    showConfidence('down', down);
    showConfidence('up', up);

    const downCv = stabilityCv(downResult.stabilitySamples);
    const upCv = stabilityCv(upResult.stabilitySamples);
    els.stabilityDown.textContent = formatCv(downCv);
    els.stabilityUp.textContent = formatCv(upCv);

    const downLoaded = downResult.loaded.qualification;
    const upLoaded = upResult.loaded.qualification;
    const loadedDown = downLoaded.valid ? downLoaded.summary.p50 : null;
    const loadedUp = upLoaded.valid ? upLoaded.summary.p50 : null;
    els.loadedDown.textContent = formatMs(loadedDown);
    els.loadedUp.textContent = formatMs(loadedUp);

    const bloat = downLoaded.valid && upLoaded.valid ? bufferbloatAnalysis(idle.summary.p50, loadedDown, loadedUp) : null;
    els.bufferbloat.textContent = bloat ? `+${formatMs(bloat.worstIncreaseMs)} ms` : '—';

    const removed = (down?.removed || 0) + (up?.removed || 0);
    const ciNote = down?.confidence95 && up?.confidence95
      ? '95% bootstrap CI of the run-level median. '
      : 'Insufficient repeat runs for a 95% interval. ';
    els.confidenceText.textContent = `${ciNote}${removed ? `${removed} MAD outlier run(s) excluded.` : 'No run-level outliers excluded.'}`;

    const afterHealth = await healthCheck();
    const risk = analyzeServerRisk(beforeHealth, afterHealth, [downCalibration, upCalibration]);
    const loadedInvalid = [downLoaded, upLoaded].filter((item) => !item.valid);
    const loadedProbeFailures = downResult.loaded.failed + upResult.loaded.failed;
    if (risk) setNotice(risk, 'warning');
    else if (loadedInvalid.length) setNotice('Loaded-latency did not meet the minimum probe-quality threshold, so bufferbloat was not promoted as a final metric.', 'warning');
    else if (loadedProbeFailures > 0) setNotice(`${loadedProbeFailures} loaded-latency HTTP probe(s) timed out; accepted metrics still passed the probe-quality threshold.`, 'warning');
    else setNotice(`Auto streams: ${downCalibration.streams} down / ${upCalibration.streams} up. Main payload: ${(downResult.totalBytes / MB).toFixed(0)} MB down, ${(upResult.totalBytes / MB).toFixed(0)} MB up per run.`, 'neutral');

    setPhase('DONE');
    updateLive(down?.medianMbps ?? 0);
  } catch (error) {
    if (isAbort(error) || !state.running) {
      setPhase('STOPPED');
      setNotice('Test cancelled. Partial metrics are not promoted as final results.', 'neutral');
    } else {
      console.error(error);
      setPhase('ERROR');
      setNotice(error.message || 'Measurement failed. The test can be run again.', 'error');
    }
  } finally {
    state.running = false;
    for (const controller of state.aborters) {
      try { controller.abort(); } catch {}
    }
    state.aborters.clear();
    els.start.disabled = false;
    els.stop.hidden = true;
    $$('#sizeSelector button').forEach((button) => { button.disabled = false; });
    els.connections.disabled = false;
  }
}

function stopTest() {
  if (!state.running) return;
  state.running = false;
  for (const controller of state.aborters) {
    try { controller.abort(); } catch {}
  }
  state.aborters.clear();
}

function drawChart() {
  const canvas = els.chart;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, rect.width);
  const height = 190;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const pad = 24;
  ctx.strokeStyle = 'rgba(17, 24, 39, 0.08)';
  ctx.lineWidth = 1;
  for (let index = 0; index < 4; index += 1) {
    const y = pad + (height - pad * 2) * index / 3;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
  }

  const all = [...state.downloadSeries, ...state.uploadSeries];
  const maxV = Math.max(10, ...all.map((point) => point.v)) * 1.08;
  const maxT = Math.max(1, ...all.map((point) => point.t));
  function plot(series, stroke) {
    if (!series.length) return;
    ctx.beginPath();
    series.forEach((point, index) => {
      const x = pad + (width - pad * 2) * point.t / maxT;
      const y = height - pad - (height - pad * 2) * point.v / maxV;
      if (index) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.75;
    ctx.stroke();
  }
  plot(state.downloadSeries, '#1557b0');
  plot(state.uploadSeries, '#2f7d67');
  ctx.fillStyle = '#6b7280';
  ctx.font = '11px system-ui';
  ctx.fillText('0', 4, height - 6);
  ctx.fillText(`${Math.round(maxV)} Mbps`, 4, 13);
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
  try {
    state.apiBase = await selectMeasurementServer();
    state.capabilities = await fetchJson('/api/capabilities', {}, 3000);
    state.serverInfo = await fetchJson('/api/info', {}, 3000);
    state.nextHopProtocol = detectNextHopProtocol('/api/info');
    const node = state.serverInfo.node || state.capabilities.node || {};
    els.serverStatus.textContent = `Ready · ${node.region || 'local'}`;
    els.nodeInfo.textContent = `${node.id || 'measurement node'} · ${state.serverInfo.clientFamily || 'network'}`;
    els.footerInfo.textContent = `${state.nextHopProtocol || state.serverInfo.protocol || 'HTTP'} · ${state.serverInfo.clientFamily || 'network'}`;
    const maxMiB = state.capabilities.maxTransferMiB || 500;
    $$('#sizeSelector button[data-size]').forEach((button) => {
      button.disabled = Number(button.dataset.size) > maxMiB;
    });
  } catch (error) {
    els.serverStatus.textContent = 'Server unavailable';
    setNotice('Measurement backend is unavailable. Check deployment and /api/health.', 'error');
    els.start.disabled = true;
  }
  drawChart();
}

$$('#sizeSelector button').forEach((button) => button.addEventListener('click', () => {
  if (state.running || button.disabled) return;
  $$('#sizeSelector button').forEach((item) => item.classList.remove('active'));
  button.classList.add('active');
  if (button.dataset.mode === 'auto') {
    state.sizeMode = 'auto';
    els.sizeHint.textContent = 'Adaptive duration';
  } else {
    state.sizeMode = 'manual';
    state.sizeMB = Number(button.dataset.size);
    els.sizeHint.textContent = `${state.sizeMB} MB / run`;
  }
}));

els.precision.addEventListener('click', () => {
  if (state.running) return;
  state.precise = !state.precise;
  els.precision.classList.toggle('on', state.precise);
  els.precision.setAttribute('aria-pressed', String(state.precise));
});
els.start.addEventListener('click', startTest);
els.stop.addEventListener('click', stopTest);
window.addEventListener('resize', drawChart);
initialize();
