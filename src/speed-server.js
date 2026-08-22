import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultPublicDir = path.join(projectRoot, 'public');
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const DEFAULT_MAX_BYTES = 500 * MIB;
const DEFAULT_DOWNLOAD_CHUNK = 256 * 1024;
const DEFAULT_RANDOM_POOL_BYTES = 4 * MIB;
const RECOMMENDED_SIZES_MIB = Object.freeze([1, 2, 5, 10, 100, 250, 500]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function envInt(name, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

function envList(name, fallbackName) {
  const raw = process.env[name] ?? (fallbackName ? process.env[fallbackName] : '') ?? '';
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

function parseServerList(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      const region = typeof item.region === 'string' ? item.region.trim() : '';
      const url = typeof item.url === 'string' ? item.url.trim().replace(/\/$/, '') : '';
      if (!id || !url || !/^https?:\/\//i.test(url)) return [];
      return [{ id, region: region || null, url }];
    }).slice(0, 32);
  } catch {
    return [];
  }
}

function createLogger(level = 'info') {
  const priorities = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
  const threshold = priorities[level] ?? priorities.info;
  return (severity, event, fields = {}) => {
    if ((priorities[severity] ?? priorities.info) < threshold) return;
    const record = {
      timestamp: new Date().toISOString(),
      level: severity,
      event,
      service: 'precision-speed-lab',
      ...fields,
    };
    const writer = severity === 'error' ? console.error : severity === 'warn' ? console.warn : console.log;
    writer(JSON.stringify(record));
  };
}

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' http: https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
}

function applyNoCache(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Surrogate-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

function resolveCorsOrigin(req, allowedOrigins) {
  const origin = req.headers.origin;
  if (!origin || !allowedOrigins.length) return '';
  if (allowedOrigins.includes('*')) return '*';
  return allowedOrigins.includes(origin) ? origin : '';
}

function applyApiHeaders(req, res, allowedOrigins) {
  applySecurityHeaders(res);
  applyNoCache(res);
  const corsOrigin = resolveCorsOrigin(req, allowedOrigins);
  res.setHeader('Timing-Allow-Origin', corsOrigin || 'self');
  res.setHeader('Access-Control-Expose-Headers', 'Server-Timing, X-Transfer-Id, X-Test-Bytes, X-Request-Id, X-Measurement-Node');
  if (corsOrigin) {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.appendHeader?.('Vary', 'Origin');
  }
}

function sendJson(req, res, status, body, allowedOrigins) {
  if (res.writableEnded) return;
  res.statusCode = status;
  applyApiHeaders(req, res, allowedOrigins);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function sendMethodNotAllowed(req, res, allowed, allowedOrigins) {
  res.setHeader('Allow', allowed.join(', '));
  sendJson(req, res, 405, { error: 'Method not allowed', allowed }, allowedOrigins);
}

function rejectUpload(req, res, status, body, allowedOrigins, retryAfter = null) {
  if (retryAfter != null) res.setHeader('Retry-After', String(retryAfter));
  res.setHeader('Connection', 'close');
  sendJson(req, res, status, body, allowedOrigins);
  req.resume();
  res.once('finish', () => req.destroy());
}

function parseRequestedBytes(url, maxBytes) {
  const raw = url.searchParams.get('bytes');
  if (!raw) return { ok: false, error: 'Missing bytes parameter' };
  if (!/^\d+$/.test(raw)) return { ok: false, error: 'bytes must be a positive integer' };
  const bytes = Number(raw);
  if (!Number.isSafeInteger(bytes) || bytes < 1) return { ok: false, error: 'Invalid bytes value' };
  if (bytes > maxBytes) return { ok: false, error: `Maximum transfer is ${maxBytes} bytes`, status: 413 };
  return { ok: true, bytes };
}

function normalizeAddress(address) {
  if (!address) return '';
  if (address.startsWith('::ffff:')) return address.slice(7);
  return address;
}

function getClientAddress(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) return normalizeAddress(forwarded.split(',')[0].trim());
  }
  return normalizeAddress(req.socket.remoteAddress || '');
}

function getClientFamily(req, trustProxy) {
  const address = getClientAddress(req, trustProxy);
  const family = net.isIP(address);
  if (family === 4) return 'IPv4';
  if (family === 6) return 'IPv6';
  return req.socket.remoteFamily || null;
}

function anonymizedClientKey(req, trustProxy, secret) {
  const address = getClientAddress(req, trustProxy) || 'unknown';
  return crypto.createHmac('sha256', secret).update(address).digest('hex').slice(0, 16);
}

function createTransferGuard({ maxActiveGlobal, maxActivePerClient, trustProxy, keySecret }) {
  let activeGlobal = 0;
  const byClient = new Map();

  return {
    begin(req) {
      const key = anonymizedClientKey(req, trustProxy, keySecret);
      const clientActive = byClient.get(key) || 0;
      if (activeGlobal >= maxActiveGlobal) return { ok: false, reason: 'Server is busy', retryAfter: 1 };
      if (clientActive >= maxActivePerClient) return { ok: false, reason: 'Too many concurrent streams from this client', retryAfter: 1 };
      activeGlobal += 1;
      byClient.set(key, clientActive + 1);
      let released = false;
      return {
        ok: true,
        key,
        release() {
          if (released) return;
          released = true;
          activeGlobal = Math.max(0, activeGlobal - 1);
          const next = Math.max(0, (byClient.get(key) || 1) - 1);
          if (next === 0) byClient.delete(key);
          else byClient.set(key, next);
        },
      };
    },
    snapshot() {
      return { activeGlobal, activeClients: byClient.size };
    },
  };
}

function createWindowLimiter({ windowMs, maxRequests, maxBytes, trustProxy, keySecret }) {
  const clients = new Map();
  let lastSweep = 0;

  function getEntry(req) {
    const now = Date.now();
    const key = anonymizedClientKey(req, trustProxy, keySecret);
    let entry = clients.get(key);
    if (!entry || now - entry.startedAt >= windowMs) {
      entry = { startedAt: now, requests: 0, bytes: 0 };
      clients.set(key, entry);
    }
    if (now - lastSweep > windowMs) {
      lastSweep = now;
      for (const [clientKey, value] of clients) {
        if (now - value.startedAt >= windowMs * 2) clients.delete(clientKey);
      }
    }
    return entry;
  }

  return {
    request(req, weight = 1) {
      const entry = getEntry(req);
      if (entry.requests + weight > maxRequests) {
        const retryAfter = Math.max(1, Math.ceil((windowMs - (Date.now() - entry.startedAt)) / 1000));
        return { ok: false, retryAfter, reason: 'Request rate limit exceeded' };
      }
      entry.requests += weight;
      return { ok: true };
    },
    bytes(req, count) {
      const entry = getEntry(req);
      if (entry.bytes + count > maxBytes) {
        const retryAfter = Math.max(1, Math.ceil((windowMs - (Date.now() - entry.startedAt)) / 1000));
        return { ok: false, retryAfter, reason: 'Transfer byte quota exceeded' };
      }
      entry.bytes += count;
      return { ok: true };
    },
  };
}

function createMetrics() {
  const counters = new Map();
  let downloadBytes = 0;
  let uploadBytes = 0;
  let completedTransfers = 0;
  let failedTransfers = 0;

  return {
    request(method, route, status) {
      const key = `${method}|${route}|${status}`;
      counters.set(key, (counters.get(key) || 0) + 1);
    },
    transfer(kind, bytes, success) {
      if (kind === 'download') downloadBytes += bytes;
      if (kind === 'upload') uploadBytes += bytes;
      if (success) completedTransfers += 1;
      else failedTransfers += 1;
    },
    render(activeTransfers) {
      const lines = [
        '# HELP precision_speed_lab_requests_total HTTP requests by bounded route and status.',
        '# TYPE precision_speed_lab_requests_total counter',
      ];
      for (const [key, value] of counters) {
        const [method, route, status] = key.split('|');
        lines.push(`precision_speed_lab_requests_total{method="${method}",route="${route}",status="${status}"} ${value}`);
      }
      lines.push(
        '# HELP precision_speed_lab_transfer_bytes_total Completed/attempted measurement bytes observed by the server.',
        '# TYPE precision_speed_lab_transfer_bytes_total counter',
        `precision_speed_lab_transfer_bytes_total{direction="download"} ${downloadBytes}`,
        `precision_speed_lab_transfer_bytes_total{direction="upload"} ${uploadBytes}`,
        '# TYPE precision_speed_lab_transfers_total counter',
        `precision_speed_lab_transfers_total{result="completed"} ${completedTransfers}`,
        `precision_speed_lab_transfers_total{result="failed"} ${failedTransfers}`,
        '# TYPE precision_speed_lab_active_transfers gauge',
        `precision_speed_lab_active_transfers ${activeTransfers}`,
        '# TYPE process_resident_memory_bytes gauge',
        `process_resident_memory_bytes ${process.memoryUsage().rss}`,
      );
      return `${lines.join('\n')}\n`;
    },
  };
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  };
  return types[ext] || 'application/octet-stream';
}

function serveStatic(req, res, pathname, publicDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch {
    res.statusCode = 400; applySecurityHeaders(res); applyNoCache(res); res.end('Bad request'); return true;
  }
  const requested = decoded === '/' ? '/index.html' : decoded;
  const filePath = path.resolve(publicDir, `.${requested}`);
  const publicPrefix = publicDir.endsWith(path.sep) ? publicDir : `${publicDir}${path.sep}`;
  if (filePath !== publicDir && !filePath.startsWith(publicPrefix)) return false;
  let stat;
  try { stat = fs.statSync(filePath); } catch { return false; }
  if (!stat.isFile()) return false;
  res.statusCode = 200;
  applySecurityHeaders(res);
  res.setHeader('Content-Type', contentTypeFor(filePath));
  res.setHeader('Content-Length', String(stat.size));
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html' || ext === '.js' || ext === '.mjs' || ext === '.css') applyNoCache(res);
  else res.setHeader('Cache-Control', 'public, max-age=3600');
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(filePath).on('error', () => { if (!res.headersSent) res.statusCode = 500; res.end(); }).pipe(res);
  return true;
}

function safeRoute(pathname) {
  if (pathname === '/api/download') return '/api/download';
  if (pathname === '/api/upload') return '/api/upload';
  if (pathname === '/api/progress') return '/api/progress';
  if (pathname.startsWith('/api/')) return pathname.slice(0, 80);
  if (pathname === '/metrics') return '/metrics';
  return 'static';
}

export function createSpeedServer(options = {}) {
  const publicDir = options.publicDir || defaultPublicDir;
  const maxBytes = options.maxBytes || envInt('MAX_TRANSFER_BYTES', DEFAULT_MAX_BYTES, MIB, 2 * GIB);
  const downloadChunk = options.downloadChunk || envInt('DOWNLOAD_CHUNK_BYTES', DEFAULT_DOWNLOAD_CHUNK, 16 * 1024, 4 * MIB);
  const randomPoolBytes = options.randomPoolBytes || envInt('RANDOM_POOL_BYTES', DEFAULT_RANDOM_POOL_BYTES, downloadChunk, 32 * MIB);
  const maxActiveGlobal = options.maxActiveGlobal || envInt('MAX_ACTIVE_TRANSFERS', 128, 1, 10_000);
  const maxActivePerClient = options.maxActivePerClient || envInt('MAX_ACTIVE_PER_CLIENT', 16, 1, 256);
  const trustProxy = options.trustProxy ?? envBool('TRUST_PROXY');
  const allowedOrigins = options.allowedOrigins || envList('CORS_ORIGINS', 'CORS_ORIGIN');
  const version = options.version || '2.0.0';
  const nodeId = options.nodeId || process.env.MEASUREMENT_NODE_ID || os.hostname();
  const region = options.region || process.env.MEASUREMENT_REGION || 'local';
  const publicBaseUrl = (options.publicBaseUrl || process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const measurementServers = options.measurementServers || parseServerList(process.env.MEASUREMENT_SERVERS_JSON || '');
  const requestWindowMs = options.requestWindowMs || envInt('RATE_WINDOW_MS', 60_000, 1_000, 3_600_000);
  const maxRequestsPerWindow = options.maxRequestsPerWindow || envInt('MAX_REQUESTS_PER_WINDOW', 900, 10, 100_000);
  const maxBytesPerWindow = options.maxBytesPerWindow || envInt('MAX_BYTES_PER_WINDOW', 8 * GIB, maxBytes, 128 * GIB);
  const uploadIdleTimeoutMs = options.uploadIdleTimeoutMs || envInt('UPLOAD_IDLE_TIMEOUT_MS', 30_000, 1_000, 300_000);
  const metricsEnabled = options.metricsEnabled ?? envBool('ENABLE_METRICS', false);
  const metricsToken = options.metricsToken ?? process.env.METRICS_TOKEN ?? '';
  const logger = options.logger || createLogger(process.env.LOG_LEVEL || 'info');
  const keySecret = crypto.randomBytes(32);
  const randomPool = crypto.randomBytes(Math.min(randomPoolBytes, maxBytes));
  const transfers = createTransferGuard({ maxActiveGlobal, maxActivePerClient, trustProxy, keySecret });
  const limiter = createWindowLimiter({ windowMs: requestWindowMs, maxRequests: maxRequestsPerWindow, maxBytes: maxBytesPerWindow, trustProxy, keySecret });
  const metrics = createMetrics();
  const progress = new Map();
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  eventLoopDelay.enable();
  const progressTtlMs = 30_000;

  const progressSweep = setInterval(() => {
    const cutoff = Date.now() - progressTtlMs;
    for (const [id, item] of progress) if (item.updatedAt < cutoff) progress.delete(id);
  }, 15_000);
  progressSweep.unref();

  const server = http.createServer((req, res) => {
    const requestId = crypto.randomUUID();
    const requestStarted = process.hrtime.bigint();
    const requestRoute = { value: 'unknown' };
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Measurement-Node', nodeId);

    res.once('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - requestStarted) / 1e6;
      metrics.request(req.method || 'UNKNOWN', requestRoute.value, res.statusCode);
      const severity = requestRoute.value === '/api/ping' || requestRoute.value === '/api/progress' ? 'debug' : 'info';
      logger(severity, 'http_request', {
        requestId,
        method: req.method,
        route: requestRoute.value,
        status: res.statusCode,
        durationMs: Number(durationMs.toFixed(3)),
        clientFamily: getClientFamily(req, trustProxy),
      });
    });

    if ((req.url || '').length > 2048) {
      requestRoute.value = 'invalid-url';
      return sendJson(req, res, 414, { error: 'URI too long', requestId }, allowedOrigins);
    }

    let url;
    try { url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`); }
    catch { requestRoute.value = 'invalid-url'; return sendJson(req, res, 400, { error: 'Invalid URL', requestId }, allowedOrigins); }
    const pathname = url.pathname;
    requestRoute.value = safeRoute(pathname);

    if (pathname.startsWith('/api/')) {
      const rate = limiter.request(req, pathname === '/api/ping' ? 1 : 2);
      if (!rate.ok) {
        res.setHeader('Retry-After', String(rate.retryAfter));
        return sendJson(req, res, 429, { error: rate.reason, requestId }, allowedOrigins);
      }
    }

    if (pathname.startsWith('/api/') && req.method === 'OPTIONS') {
      res.statusCode = 204;
      applyApiHeaders(req, res, allowedOrigins);
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Content-Length, Cache-Control, Authorization');
      res.setHeader('Access-Control-Max-Age', '600');
      return res.end();
    }

    if (pathname === '/api/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendMethodNotAllowed(req, res, ['GET', 'HEAD'], allowedOrigins);
      if (req.method === 'HEAD') { res.statusCode = 204; applyApiHeaders(req, res, allowedOrigins); return res.end(); }
      const transferSnapshot = transfers.snapshot();
      const elu = performance.eventLoopUtilization();
      return sendJson(req, res, 200, {
        ok: true,
        service: 'precision-speed-lab',
        version,
        node: { id: nodeId, region },
        uptimeSeconds: Math.round(process.uptime()),
        now: Date.now(),
        transfers: transferSnapshot,
        limits: { maxActiveTransfers: maxActiveGlobal, maxActivePerClient, maxTransferBytes: maxBytes },
        runtime: {
          eventLoopDelayP95Ms: Number((eventLoopDelay.percentile(95) / 1e6).toFixed(3)),
          eventLoopUtilization: Number(elu.utilization.toFixed(4)),
          rssBytes: process.memoryUsage().rss,
          loadAverage1m: os.loadavg()[0],
        },
      }, allowedOrigins);
    }

    if (pathname === '/api/capabilities') {
      if (req.method !== 'GET') return sendMethodNotAllowed(req, res, ['GET'], allowedOrigins);
      return sendJson(req, res, 200, {
        service: 'precision-speed-lab', version, node: { id: nodeId, region },
        maxTransferBytes: maxBytes, maxTransferMiB: Math.floor(maxBytes / MIB),
        recommendedSizesMiB: RECOMMENDED_SIZES_MIB.filter((size) => size * MIB <= maxBytes),
        maxActiveTransfers: maxActiveGlobal, maxActivePerClient,
        features: {
          streamingDownload: true, streamingUpload: true, uploadProgress: true, requestCancellation: true,
          ipv4Ipv6Awareness: true, regionalServerDiscovery: true, prometheusMetrics: metricsEnabled,
        },
        endpoints: {
          ping: '/api/ping', info: '/api/info', download: '/api/download?bytes={bytes}', upload: '/api/upload?id={uuid}',
          progress: '/api/progress?id={uuid}', health: '/api/health', servers: '/api/servers',
        },
      }, allowedOrigins);
    }

    if (pathname === '/api/servers') {
      if (req.method !== 'GET') return sendMethodNotAllowed(req, res, ['GET'], allowedOrigins);
      const self = { id: nodeId, region, url: publicBaseUrl || null, current: true };
      return sendJson(req, res, 200, { self, servers: measurementServers }, allowedOrigins);
    }

    if (pathname === '/api/ping') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendMethodNotAllowed(req, res, ['GET', 'HEAD'], allowedOrigins);
      res.statusCode = 204;
      applyApiHeaders(req, res, allowedOrigins);
      res.setHeader('Server-Timing', 'app;dur=0');
      res.setHeader('X-Server-Time-Ns', process.hrtime.bigint().toString());
      return res.end();
    }

    if (pathname === '/api/info') {
      if (req.method !== 'GET') return sendMethodNotAllowed(req, res, ['GET'], allowedOrigins);
      return sendJson(req, res, 200, {
        requestId, serverTime: Date.now(), protocol: `HTTP/${req.httpVersion}`, encrypted: Boolean(req.socket.encrypted),
        clientFamily: getClientFamily(req, trustProxy), node: { id: nodeId, region },
      }, allowedOrigins);
    }

    if (pathname === '/api/progress') {
      if (req.method !== 'GET') return sendMethodNotAllowed(req, res, ['GET'], allowedOrigins);
      const rawIds = url.searchParams.get('ids');
      const ids = rawIds ? rawIds.split(',').filter(Boolean) : [url.searchParams.get('id') || ''];
      if (!ids.length || ids.length > 8 || ids.some((id) => !UUID_RE.test(id))) {
        return sendJson(req, res, 400, { error: 'Invalid transfer id list', requestId }, allowedOrigins);
      }
      const nowNs = process.hrtime.bigint();
      const items = ids.flatMap((id) => {
        const item = progress.get(id);
        if (!item) return [];
        const elapsedMs = item.startedNs ? Number(nowNs - item.startedNs) / 1e6 : 0;
        return [{ transferId: id, received: item.received, elapsedMs: Number(elapsedMs.toFixed(3)), completed: item.completed }];
      });
      if (!items.length) return sendJson(req, res, 404, { error: 'Transfer not active or expired', requestId }, allowedOrigins);
      return sendJson(req, res, 200, rawIds ? { transfers: items } : items[0], allowedOrigins);
    }

    if (pathname === '/api/download') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendMethodNotAllowed(req, res, ['GET', 'HEAD'], allowedOrigins);
      const parsed = parseRequestedBytes(url, maxBytes);
      if (!parsed.ok) return sendJson(req, res, parsed.status || 400, { error: parsed.error, requestId }, allowedOrigins);
      const bytes = parsed.bytes;
      if (req.method === 'HEAD') {
        res.statusCode = 200; applyApiHeaders(req, res, allowedOrigins); res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', String(bytes)); res.setHeader('Content-Encoding', 'identity'); res.setHeader('X-Test-Bytes', String(bytes)); return res.end();
      }
      const quota = limiter.bytes(req, bytes);
      if (!quota.ok) { res.setHeader('Retry-After', String(quota.retryAfter)); return sendJson(req, res, 429, { error: quota.reason, requestId }, allowedOrigins); }
      const slot = transfers.begin(req);
      if (!slot.ok) { res.setHeader('Retry-After', String(slot.retryAfter)); return sendJson(req, res, 429, { error: slot.reason, requestId }, allowedOrigins); }
      const transferId = crypto.randomUUID();
      let remaining = bytes;
      let offset = crypto.randomInt(0, randomPool.length);
      let released = false;
      let attemptedBytes = 0;
      const release = (success) => {
        if (released) return;
        released = true;
        slot.release();
        metrics.transfer('download', success ? bytes : attemptedBytes, success);
      };
      res.statusCode = 200; applyApiHeaders(req, res, allowedOrigins); res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(bytes)); res.setHeader('Content-Encoding', 'identity'); res.setHeader('X-Transfer-Id', transferId);
      res.setHeader('X-Test-Bytes', String(bytes)); res.setHeader('Server-Timing', 'prepare;dur=0');
      res.once('finish', () => release(remaining === 0)); res.once('close', () => release(false)); res.once('error', () => release(false));
      const pump = () => {
        while (remaining > 0 && !res.destroyed) {
          if (offset >= randomPool.length) offset = 0;
          const amount = Math.min(remaining, downloadChunk, randomPool.length - offset);
          const chunk = randomPool.subarray(offset, offset + amount);
          offset += amount; remaining -= amount; attemptedBytes += amount;
          if (!res.write(chunk)) { res.once('drain', pump); return; }
        }
        if (remaining === 0 && !res.writableEnded) res.end();
      };
      pump();
      return;
    }

    if (pathname === '/api/upload') {
      if (req.method !== 'POST') return sendMethodNotAllowed(req, res, ['POST'], allowedOrigins);
      const contentEncoding = req.headers['content-encoding'];
      if (contentEncoding && contentEncoding !== 'identity') return rejectUpload(req, res, 415, { error: 'Compressed uploads are not accepted', requestId }, allowedOrigins);
      const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (contentType && contentType !== 'application/octet-stream') return rejectUpload(req, res, 415, { error: 'Upload Content-Type must be application/octet-stream', requestId }, allowedOrigins);
      const declaredLengthRaw = req.headers['content-length'];
      let declaredLength = null;
      if (declaredLengthRaw != null) {
        declaredLength = Number(declaredLengthRaw);
        if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) return rejectUpload(req, res, 400, { error: 'Invalid Content-Length', requestId }, allowedOrigins);
        if (declaredLength > maxBytes) return rejectUpload(req, res, 413, { error: `Maximum upload is ${maxBytes} bytes`, requestId }, allowedOrigins);
        const quota = limiter.bytes(req, declaredLength);
        if (!quota.ok) return rejectUpload(req, res, 429, { error: quota.reason, requestId }, allowedOrigins, quota.retryAfter);
      }
      const transferIdRaw = url.searchParams.get('id');
      const transferId = transferIdRaw && UUID_RE.test(transferIdRaw) ? transferIdRaw : crypto.randomUUID();
      if (transferIdRaw && transferIdRaw !== transferId) return rejectUpload(req, res, 400, { error: 'Invalid transfer id', requestId }, allowedOrigins);
      if (progress.has(transferId) && !progress.get(transferId).completed) return rejectUpload(req, res, 409, { error: 'Transfer id already active', requestId }, allowedOrigins);
      const slot = transfers.begin(req);
      if (!slot.ok) return rejectUpload(req, res, 429, { error: slot.reason, requestId }, allowedOrigins, slot.retryAfter);

      let received = 0;
      let startedNs = null;
      let completed = false;
      let quotaCharged = declaredLength != null;
      const progressItem = { received: 0, startedNs: null, updatedAt: Date.now(), completed: false };
      progress.set(transferId, progressItem);
      const finish = (success) => {
        if (completed) return false;
        completed = true;
        slot.release();
        progressItem.completed = true;
        progressItem.updatedAt = Date.now();
        metrics.transfer('upload', received, success);
        return true;
      };

      req.setTimeout(uploadIdleTimeoutMs, () => {
        if (!finish(false)) return;
        if (!res.headersSent) sendJson(req, res, 408, { error: 'Upload timed out', requestId }, allowedOrigins);
        req.destroy();
      });

      req.on('data', (chunk) => {
        if (completed) return;
        if (!startedNs) { startedNs = process.hrtime.bigint(); progressItem.startedNs = startedNs; }
        received += chunk.length;
        progressItem.received = received;
        progressItem.updatedAt = Date.now();
        if (received > maxBytes) {
          finish(false); req.pause(); res.setHeader('Connection', 'close');
          sendJson(req, res, 413, { error: `Maximum upload is ${maxBytes} bytes`, received, requestId }, allowedOrigins);
          res.once('finish', () => req.destroy());
          return;
        }
        if (!quotaCharged) {
          const quota = limiter.bytes(req, chunk.length);
          if (!quota.ok) {
            finish(false); req.pause(); res.setHeader('Connection', 'close'); res.setHeader('Retry-After', String(quota.retryAfter));
            sendJson(req, res, 429, { error: quota.reason, received, requestId }, allowedOrigins);
            res.once('finish', () => req.destroy());
          }
        }
      });
      req.once('aborted', () => finish(false));
      req.once('error', () => {
        const first = finish(false);
        if (first && !res.headersSent) sendJson(req, res, 400, { error: 'Upload interrupted', requestId }, allowedOrigins);
      });
      req.once('end', () => {
        if (!finish(true)) return;
        if (declaredLength != null && declaredLength !== received) return sendJson(req, res, 400, { error: 'Received byte count does not match Content-Length', received, declaredLength, requestId }, allowedOrigins);
        const endedNs = process.hrtime.bigint();
        const elapsedMs = startedNs ? Number(endedNs - startedNs) / 1e6 : 0;
        const serverMeasuredMbps = elapsedMs > 0 ? (received * 8) / (elapsedMs / 1000) / 1_000_000 : 0;
        res.setHeader('X-Transfer-Id', transferId); res.setHeader('X-Test-Bytes', String(received));
        sendJson(req, res, 200, {
          transferId, requestId, received, elapsedMs: Number(elapsedMs.toFixed(3)), serverMeasuredMbps: Number(serverMeasuredMbps.toFixed(3)),
        }, allowedOrigins);
      });
      return;
    }

    if (pathname === '/metrics') {
      if (!metricsEnabled) { res.statusCode = 404; applySecurityHeaders(res); return res.end('Not found'); }
      if (metricsToken && req.headers.authorization !== `Bearer ${metricsToken}`) { res.statusCode = 401; applySecurityHeaders(res); return res.end('Unauthorized'); }
      if (req.method !== 'GET') { res.statusCode = 405; res.setHeader('Allow', 'GET'); applySecurityHeaders(res); return res.end('Method not allowed'); }
      res.statusCode = 200; applySecurityHeaders(res); res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      res.end(metrics.render(transfers.snapshot().activeGlobal)); return;
    }

    if (serveStatic(req, res, pathname, publicDir)) return;
    res.statusCode = 404; applySecurityHeaders(res); applyNoCache(res); res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end('Not found');
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 30 * 60_000;
  server.maxRequestsPerSocket = 0;
  server.on('close', () => { eventLoopDelay.disable(); clearInterval(progressSweep); });
  return server;
}

export function startServer(options = {}) {
  const port = Number(options.port ?? process.env.PORT ?? 3000);
  const host = options.host ?? process.env.HOST ?? '0.0.0.0';
  const server = createSpeedServer(options);
  server.listen(port, host, () => {
    const address = server.address();
    const boundPort = typeof address === 'object' && address ? address.port : port;
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', event: 'server_listening', service: 'precision-speed-lab', host, port: boundPort }));
  });
  return server;
}
