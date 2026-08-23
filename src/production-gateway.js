import crypto from 'node:crypto';
import os from 'node:os';
import { performance } from 'node:perf_hooks';

const MIB = 1024 * 1024;

function envInt(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function envFloat(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

function normalizeAddress(address = '') {
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

function clientAddress(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded) return normalizeAddress(forwarded.split(',')[0].trim());
  }
  return normalizeAddress(req.socket.remoteAddress || 'unknown');
}

function clientKey(req, trustProxy, secret) {
  return crypto.createHmac('sha256', secret).update(clientAddress(req, trustProxy)).digest('hex').slice(0, 20);
}

function createTokenBuckets({ capacity, refillPerSecond, trustProxy }) {
  const secret = crypto.randomBytes(32);
  const buckets = new Map();
  let lastSweep = 0;

  function entry(req) {
    const now = Date.now();
    const key = clientKey(req, trustProxy, secret);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, updatedAt: now, lastSeen: now };
      buckets.set(key, bucket);
    }
    const elapsed = Math.max(0, now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerSecond);
    bucket.updatedAt = now;
    bucket.lastSeen = now;

    if (now - lastSweep > 60_000) {
      lastSweep = now;
      for (const [candidate, value] of buckets) {
        if (now - value.lastSeen > 5 * 60_000) buckets.delete(candidate);
      }
    }
    return bucket;
  }

  return {
    take(req, weight) {
      const bucket = entry(req);
      if (bucket.tokens < weight) {
        const deficit = weight - bucket.tokens;
        const retryAfter = Math.max(1, Math.ceil(deficit / Math.max(0.001, refillPerSecond)));
        return { ok: false, retryAfter };
      }
      bucket.tokens -= weight;
      return { ok: true };
    },
    size() { return buckets.size; },
  };
}

function parseRegionalServers() {
  const raw = process.env.MEASUREMENT_SERVERS_JSON || '';
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((server) => {
      if (!server || typeof server !== 'object') return [];
      const id = String(server.id || '').trim();
      const region = String(server.region || '').trim();
      const url = String(server.url || '').trim().replace(/\/$/, '');
      const priority = Number.isFinite(Number(server.priority)) ? Number(server.priority) : 100;
      const capacity = Number.isFinite(Number(server.capacity)) ? Number(server.capacity) : null;
      if (!id || !/^https?:\/\//i.test(url)) return [];
      return [{ id, region: region || null, url, priority, capacity }];
    }).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id)).slice(0, 32);
  } catch {
    return [];
  }
}

function parseOriginList() {
  return String(process.env.CORS_ORIGINS || process.env.CORS_ORIGIN || '').split(',').map((value) => value.trim()).filter(Boolean);
}

function applyCors(req, res, allowedOrigins) {
  const origin = req.headers.origin;
  if (!origin || !allowedOrigins.length) return;
  const allowed = allowedOrigins.includes('*') ? '*' : allowedOrigins.includes(origin) ? origin : '';
  if (!allowed) return;
  res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Timing-Allow-Origin', allowed);
  res.setHeader('Access-Control-Expose-Headers', 'Retry-After, X-Measurement-Node');
  if (allowed !== '*') res.setHeader('Vary', 'Origin');
}

function writeJson(res, statusCode, body, extraHeaders = {}) {
  if (res.writableEnded) return;
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  for (const [name, value] of Object.entries(extraHeaders)) res.setHeader(name, value);
  res.end(JSON.stringify(body));
}

function routeWeight(pathname, method) {
  if (pathname === '/api/download' || pathname === '/api/upload') return 12;
  if (pathname === '/api/progress') return 1;
  if (pathname === '/api/ping') return 0.5;
  if (pathname.startsWith('/api/')) return method === 'POST' ? 4 : 2;
  return 0;
}

function isHeavyMeasurement(pathname) {
  return pathname === '/api/download' || pathname === '/api/upload';
}

function isApi(pathname) {
  return pathname.startsWith('/api/');
}

export function attachProductionGateway(server, options = {}) {
  const delegate = server.listeners('request');
  if (!delegate.length) throw new Error('Production gateway requires an existing request handler');
  server.removeAllListeners('request');

  const trustProxy = options.trustProxy ?? envBool('TRUST_PROXY', false);
  const nodeId = options.nodeId || process.env.MEASUREMENT_NODE_ID || os.hostname();
  const region = options.region || process.env.MEASUREMENT_REGION || process.env.RENDER_REGION || 'local';
  const publicBaseUrl = (options.publicBaseUrl || process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const maxConnections = options.maxConnections ?? envInt('MAX_CONNECTIONS', 2048, 32, 50_000);
  const maxRssBytes = (options.maxRssMiB ?? envInt('MAX_RSS_MIB', 430, 64, 32_768)) * MIB;
  const shedRssRatio = options.shedRssRatio ?? envFloat('SHED_RSS_RATIO', 0.92, 0.5, 1);
  const shedElu = options.shedElu ?? envFloat('SHED_EVENT_LOOP_UTILIZATION', 0.97, 0.5, 1);
  const bucketCapacity = options.bucketCapacity ?? envInt('ADMISSION_BURST_TOKENS', 180, 20, 100_000);
  const refillPerSecond = options.refillPerSecond ?? envFloat('ADMISSION_REFILL_PER_SECOND', 6, 0.1, 10_000);
  const buckets = createTokenBuckets({ capacity: bucketCapacity, refillPerSecond, trustProxy });
  const regionalServers = options.regionalServers ?? parseRegionalServers();
  const allowedOrigins = options.allowedOrigins ?? parseOriginList();
  const sockets = new Set();
  let draining = false;
  let lastElu = performance.eventLoopUtilization();
  let currentElu = 0;

  const loadSampler = setInterval(() => {
    const sample = performance.eventLoopUtilization(lastElu);
    lastElu = performance.eventLoopUtilization();
    currentElu = sample.utilization;
  }, 1000);
  loadSampler.unref();

  server.maxConnections = maxConnections;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 60_000);
    socket.once('close', () => sockets.delete(socket));
  });
  server.once('close', () => clearInterval(loadSampler));

  function pressure() {
    const memory = process.memoryUsage();
    const rssRatio = memory.rss / maxRssBytes;
    const socketRatio = sockets.size / maxConnections;
    const score = Math.max(rssRatio, socketRatio, currentElu);
    const overloaded = rssRatio >= shedRssRatio || currentElu >= shedElu || socketRatio >= 0.98;
    return {
      overloaded,
      score: Number(Math.min(1.5, score).toFixed(4)),
      rssBytes: memory.rss,
      rssLimitBytes: maxRssBytes,
      eventLoopUtilization: Number(currentElu.toFixed(4)),
      openSockets: sockets.size,
      maxConnections,
    };
  }

  function readiness() {
    const runtime = pressure();
    return {
      ok: !draining && !runtime.overloaded,
      draining,
      service: 'precision-speed-lab',
      node: { id: nodeId, region, url: publicBaseUrl || null },
      runtime,
      admissionClients: buckets.size(),
    };
  }

  function writeApiJson(req, res, statusCode, body, headers = {}) {
    applyCors(req, res, allowedOrigins);
    res.setHeader('X-Measurement-Node', nodeId);
    return writeJson(res, statusCode, body, headers);
  }

  server.on('request', (req, res) => {
    let url;
    try { url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`); }
    catch { return writeJson(res, 400, { error: 'Invalid URL' }); }
    const pathname = url.pathname;

    if (isApi(pathname) && req.method === 'OPTIONS') {
      applyCors(req, res, allowedOrigins);
      res.statusCode = 204;
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Content-Length, Cache-Control, Authorization');
      res.setHeader('Access-Control-Max-Age', '600');
      return res.end();
    }

    if (pathname === '/healthz') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return writeJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' });
      const body = { ok: true, service: 'precision-speed-lab', node: { id: nodeId, region }, draining };
      if (req.method === 'HEAD') { res.statusCode = 204; res.setHeader('Cache-Control', 'no-store'); return res.end(); }
      return writeJson(res, 200, body);
    }

    if (pathname === '/readyz') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return writeJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' });
      const ready = readiness();
      if (req.method === 'HEAD') { res.statusCode = ready.ok ? 204 : 503; res.setHeader('Cache-Control', 'no-store'); return res.end(); }
      return writeJson(res, ready.ok ? 200 : 503, ready, ready.ok ? {} : { 'Retry-After': '2' });
    }

    if (pathname === '/api/servers') {
      if (req.method !== 'GET') return writeApiJson(req, res, 405, { error: 'Method not allowed' }, { Allow: 'GET' });
      const local = readiness();
      return writeApiJson(req, res, 200, {
        strategy: 'client-rtt-with-capacity-hints',
        self: { id: nodeId, region, url: publicBaseUrl || null, current: true, loadScore: local.runtime.score, ready: local.ok },
        servers: regionalServers,
      });
    }

    if (pathname === '/api/node-selection') {
      if (req.method !== 'GET') return writeApiJson(req, res, 405, { error: 'Method not allowed' }, { Allow: 'GET' });
      const local = readiness();
      return writeApiJson(req, res, 200, {
        strategy: 'client-rtt-with-capacity-hints',
        probe: { samples: 3, statistic: 'median', maxCandidates: 8 },
        self: { id: nodeId, region, url: publicBaseUrl || null, loadScore: local.runtime.score, ready: local.ok },
        servers: regionalServers,
      });
    }

    if (draining && isHeavyMeasurement(pathname)) {
      return writeApiJson(req, res, 503, { error: 'Measurement node is draining', retryable: true }, { 'Retry-After': '2', Connection: 'close' });
    }

    if (req.headers['content-length'] && req.headers['transfer-encoding']) {
      return writeApiJson(req, res, 400, { error: 'Ambiguous request framing' }, { Connection: 'close' });
    }

    if (isApi(pathname)) {
      const admission = buckets.take(req, routeWeight(pathname, req.method || 'GET'));
      if (!admission.ok) {
        return writeApiJson(req, res, 429, { error: 'Admission rate limit exceeded', retryable: true }, { 'Retry-After': String(admission.retryAfter) });
      }
    }

    if (isHeavyMeasurement(pathname)) {
      const runtime = pressure();
      if (runtime.overloaded) {
        return writeApiJson(req, res, 503, {
          error: 'Measurement node is temporarily saturated',
          retryable: true,
          node: { id: nodeId, region },
          loadScore: runtime.score,
        }, { 'Retry-After': '2' });
      }
    }

    for (const handler of delegate) handler.call(server, req, res);
  });

  return {
    beginDrain() {
      draining = true;
      server.closeIdleConnections?.();
    },
    readiness,
    snapshot() { return readiness(); },
  };
}
