import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultPublicDir = path.join(projectRoot, 'public');

const MIB = 1024 * 1024;
const DEFAULT_MAX_BYTES = 500 * MIB;
const DEFAULT_DOWNLOAD_CHUNK = 256 * 1024;
const DEFAULT_RANDOM_POOL_BYTES = 4 * MIB;
const RECOMMENDED_SIZES_MIB = Object.freeze([1, 2, 5, 10, 100, 250, 500]);

function envInt(name, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

function applyNoCache(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Surrogate-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

function applyApiHeaders(req, res, corsOrigin) {
  applySecurityHeaders(res);
  applyNoCache(res);
  res.setHeader('Timing-Allow-Origin', corsOrigin || '*');
  res.setHeader('Access-Control-Expose-Headers', 'Server-Timing, X-Transfer-Id, X-Test-Bytes, X-Request-Id');
  if (corsOrigin) {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Vary', 'Origin');
  }
}

function sendJson(req, res, status, body, corsOrigin) {
  if (res.writableEnded) return;
  res.statusCode = status;
  applyApiHeaders(req, res, corsOrigin);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function sendMethodNotAllowed(req, res, allowed, corsOrigin) {
  res.setHeader('Allow', allowed.join(', '));
  sendJson(req, res, 405, { error: 'Method not allowed', allowed }, corsOrigin);
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

function getClientKey(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim();
    }
  }
  return req.socket.remoteAddress || 'unknown';
}

function createTransferGuard({ maxActiveGlobal, maxActivePerClient, trustProxy }) {
  let activeGlobal = 0;
  const byClient = new Map();

  return {
    begin(req) {
      const key = getClientKey(req, trustProxy);
      const clientActive = byClient.get(key) || 0;
      if (activeGlobal >= maxActiveGlobal) {
        return { ok: false, reason: 'Server is busy', retryAfter: 1 };
      }
      if (clientActive >= maxActivePerClient) {
        return { ok: false, reason: 'Too many concurrent streams from this client', retryAfter: 1 };
      }

      activeGlobal += 1;
      byClient.set(key, clientActive + 1);
      let released = false;

      return {
        ok: true,
        release() {
          if (released) return;
          released = true;
          activeGlobal = Math.max(0, activeGlobal - 1);
          const next = Math.max(0, (byClient.get(key) || 1) - 1);
          if (next === 0) byClient.delete(key);
          else byClient.set(key, next);
        }
      };
    },
    snapshot() {
      return { activeGlobal, activeClients: byClient.size };
    }
  };
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.webmanifest': 'application/manifest+json'
  };
  return types[ext] || 'application/octet-stream';
}

function serveStatic(req, res, pathname, publicDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.statusCode = 400;
    res.end('Bad request');
    return true;
  }

  const requested = decoded === '/' ? '/index.html' : decoded;
  const filePath = path.resolve(publicDir, `.${requested}`);
  const publicPrefix = publicDir.endsWith(path.sep) ? publicDir : `${publicDir}${path.sep}`;
  if (filePath !== publicDir && !filePath.startsWith(publicPrefix)) return false;

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  res.statusCode = 200;
  applySecurityHeaders(res);
  res.setHeader('Content-Type', contentTypeFor(filePath));
  res.setHeader('Content-Length', String(stat.size));

  if (path.extname(filePath).toLowerCase() === '.html') {
    applyNoCache(res);
  } else {
    res.setHeader('Cache-Control', 'public, max-age=3600');
  }

  if (req.method === 'HEAD') {
    res.end();
    return true;
  }

  fs.createReadStream(filePath)
    .on('error', () => {
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    })
    .pipe(res);
  return true;
}

export function createSpeedServer(options = {}) {
  const publicDir = options.publicDir || defaultPublicDir;
  const maxBytes = options.maxBytes || envInt('MAX_TRANSFER_BYTES', DEFAULT_MAX_BYTES, MIB, 2 * 1024 * MIB);
  const downloadChunk = options.downloadChunk || envInt('DOWNLOAD_CHUNK_BYTES', DEFAULT_DOWNLOAD_CHUNK, 16 * 1024, 4 * MIB);
  const randomPoolBytes = options.randomPoolBytes || envInt('RANDOM_POOL_BYTES', DEFAULT_RANDOM_POOL_BYTES, downloadChunk, 32 * MIB);
  const maxActiveGlobal = options.maxActiveGlobal || envInt('MAX_ACTIVE_TRANSFERS', 128, 1, 10_000);
  const maxActivePerClient = options.maxActivePerClient || envInt('MAX_ACTIVE_PER_CLIENT', 16, 1, 256);
  const trustProxy = options.trustProxy ?? process.env.TRUST_PROXY === '1';
  const corsOrigin = options.corsOrigin ?? process.env.CORS_ORIGIN ?? '';
  const version = options.version || '1.1.0';

  const randomPool = crypto.randomBytes(Math.min(randomPoolBytes, maxBytes));
  const transfers = createTransferGuard({ maxActiveGlobal, maxActivePerClient, trustProxy });

  const server = http.createServer((req, res) => {
    const requestId = crypto.randomUUID();
    res.setHeader('X-Request-Id', requestId);

    let url;
    try {
      url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    } catch {
      return sendJson(req, res, 400, { error: 'Invalid URL', requestId }, corsOrigin);
    }

    const pathname = url.pathname;

    if (pathname.startsWith('/api/') && req.method === 'OPTIONS') {
      res.statusCode = 204;
      applyApiHeaders(req, res, corsOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Content-Length, Cache-Control');
      res.setHeader('Access-Control-Max-Age', '600');
      return res.end();
    }

    if (pathname === '/api/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendMethodNotAllowed(req, res, ['GET', 'HEAD'], corsOrigin);
      const body = {
        ok: true,
        service: 'precision-speed-lab',
        version,
        uptimeSeconds: Math.round(process.uptime()),
        now: Date.now(),
        transfers: transfers.snapshot()
      };
      if (req.method === 'HEAD') {
        res.statusCode = 204;
        applyApiHeaders(req, res, corsOrigin);
        return res.end();
      }
      return sendJson(req, res, 200, body, corsOrigin);
    }

    if (pathname === '/api/capabilities') {
      if (req.method !== 'GET') return sendMethodNotAllowed(req, res, ['GET'], corsOrigin);
      return sendJson(req, res, 200, {
        service: 'precision-speed-lab',
        version,
        maxTransferBytes: maxBytes,
        maxTransferMiB: Math.floor(maxBytes / MIB),
        recommendedSizesMiB: RECOMMENDED_SIZES_MIB.filter((size) => size * MIB <= maxBytes),
        maxActiveTransfers: maxActiveGlobal,
        maxActivePerClient,
        endpoints: {
          ping: '/api/ping',
          info: '/api/info',
          download: '/api/download?bytes={bytes}',
          upload: '/api/upload',
          health: '/api/health'
        }
      }, corsOrigin);
    }

    if (pathname === '/api/ping') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendMethodNotAllowed(req, res, ['GET', 'HEAD'], corsOrigin);
      res.statusCode = 204;
      applyApiHeaders(req, res, corsOrigin);
      res.setHeader('Server-Timing', 'app;dur=0');
      res.setHeader('X-Server-Time-Ns', process.hrtime.bigint().toString());
      return res.end();
    }

    if (pathname === '/api/info') {
      if (req.method !== 'GET') return sendMethodNotAllowed(req, res, ['GET'], corsOrigin);
      return sendJson(req, res, 200, {
        requestId,
        serverTime: Date.now(),
        protocol: `HTTP/${req.httpVersion}`,
        encrypted: Boolean(req.socket.encrypted),
        remoteFamily: req.socket.remoteFamily || null,
        userAgent: req.headers['user-agent'] || null
      }, corsOrigin);
    }

    if (pathname === '/api/download') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendMethodNotAllowed(req, res, ['GET', 'HEAD'], corsOrigin);
      const parsed = parseRequestedBytes(url, maxBytes);
      if (!parsed.ok) return sendJson(req, res, parsed.status || 400, { error: parsed.error, requestId }, corsOrigin);
      const bytes = parsed.bytes;

      if (req.method === 'HEAD') {
        res.statusCode = 200;
        applyApiHeaders(req, res, corsOrigin);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', String(bytes));
        res.setHeader('Content-Encoding', 'identity');
        res.setHeader('X-Test-Bytes', String(bytes));
        return res.end();
      }

      const slot = transfers.begin(req);
      if (!slot.ok) {
        res.setHeader('Retry-After', String(slot.retryAfter));
        return sendJson(req, res, 429, { error: slot.reason, requestId }, corsOrigin);
      }

      const transferId = crypto.randomUUID();
      const started = process.hrtime.bigint();
      let remaining = bytes;
      let offset = crypto.randomInt(0, randomPool.length);
      let released = false;

      const release = () => {
        if (released) return;
        released = true;
        slot.release();
      };

      res.statusCode = 200;
      applyApiHeaders(req, res, corsOrigin);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(bytes));
      res.setHeader('Content-Encoding', 'identity');
      res.setHeader('X-Transfer-Id', transferId);
      res.setHeader('X-Test-Bytes', String(bytes));
      res.setHeader('Server-Timing', 'prepare;dur=0');

      res.once('close', release);
      res.once('finish', release);
      res.once('error', release);

      const pump = () => {
        while (remaining > 0 && !res.destroyed) {
          if (offset >= randomPool.length) offset = 0;
          const amount = Math.min(remaining, downloadChunk, randomPool.length - offset);
          const chunk = randomPool.subarray(offset, offset + amount);
          offset += amount;
          remaining -= amount;
          if (!res.write(chunk)) {
            res.once('drain', pump);
            return;
          }
        }

        if (remaining === 0 && !res.writableEnded) {
          const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
          res.setHeader?.('X-Server-Transfer-Ms', elapsedMs.toFixed(3));
          res.end();
        }
      };

      pump();
      return;
    }

    if (pathname === '/api/upload') {
      if (req.method !== 'POST') return sendMethodNotAllowed(req, res, ['POST'], corsOrigin);

      const declaredLengthRaw = req.headers['content-length'];
      if (declaredLengthRaw != null) {
        const declaredLength = Number(declaredLengthRaw);
        if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
          return sendJson(req, res, 400, { error: 'Invalid Content-Length', requestId }, corsOrigin);
        }
        if (declaredLength > maxBytes) {
          return sendJson(req, res, 413, { error: `Maximum upload is ${maxBytes} bytes`, requestId }, corsOrigin);
        }
      }

      const slot = transfers.begin(req);
      if (!slot.ok) {
        res.setHeader('Retry-After', String(slot.retryAfter));
        return sendJson(req, res, 429, { error: slot.reason, requestId }, corsOrigin);
      }

      const transferId = crypto.randomUUID();
      const started = process.hrtime.bigint();
      let received = 0;
      let completed = false;

      const finish = () => {
        if (completed) return false;
        completed = true;
        slot.release();
        return true;
      };

      req.on('data', (chunk) => {
        if (completed) return;
        received += chunk.length;
        if (received > maxBytes) {
          finish();
          req.pause();
          res.setHeader('Connection', 'close');
          sendJson(req, res, 413, { error: `Maximum upload is ${maxBytes} bytes`, received, requestId }, corsOrigin);
          res.once('finish', () => req.destroy());
        }
      });

      req.once('aborted', finish);
      req.once('error', () => {
        const first = finish();
        if (first && !res.headersSent) sendJson(req, res, 400, { error: 'Upload interrupted', requestId }, corsOrigin);
      });

      req.once('end', () => {
        if (!finish()) return;
        const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
        const serverMeasuredMbps = elapsedMs > 0 ? (received * 8) / (elapsedMs / 1000) / 1_000_000 : 0;
        res.setHeader('X-Transfer-Id', transferId);
        res.setHeader('X-Test-Bytes', String(received));
        sendJson(req, res, 200, {
          transferId,
          requestId,
          received,
          elapsedMs: Number(elapsedMs.toFixed(3)),
          serverMeasuredMbps: Number(serverMeasuredMbps.toFixed(3))
        }, corsOrigin);
      });
      return;
    }

    if (serveStatic(req, res, pathname, publicDir)) return;

    res.statusCode = 404;
    applySecurityHeaders(res);
    applyNoCache(res);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Not found');
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 15 * 60_000;
  server.maxRequestsPerSocket = 0;

  return server;
}

export function startServer(options = {}) {
  const port = Number(options.port ?? process.env.PORT ?? 3000);
  const host = options.host ?? process.env.HOST ?? '0.0.0.0';
  const server = createSpeedServer(options);

  server.listen(port, host, () => {
    const address = server.address();
    const boundPort = typeof address === 'object' && address ? address.port : port;
    console.log(`[precision-speed-lab] listening on http://${host}:${boundPort}`);
  });

  return server;
}
