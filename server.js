import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const MAX_BYTES = 512 * 1024 * 1024;
const DOWNLOAD_CHUNK = 256 * 1024;
const zeroChunk = Buffer.alloc(DOWNLOAD_CHUNK);

function noCache(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  noCache(res);
  res.end(JSON.stringify(body));
}

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? path.join(publicDir, 'index.html') : path.join(publicDir, pathname);
  const normalized = path.normalize(filePath);
  if (!normalized.startsWith(publicDir)) return false;
  if (!fs.existsSync(normalized) || !fs.statSync(normalized).isFile()) return false;

  const ext = path.extname(normalized).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.json': 'application/json; charset=utf-8'
  };
  res.statusCode = 200;
  res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
  if (ext === '.html') noCache(res);
  fs.createReadStream(normalized).pipe(res);
  return true;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (pathname === '/api/ping') {
    res.statusCode = 204;
    noCache(res);
    res.setHeader('Server-Timing', 'app;dur=0');
    return res.end();
  }

  if (pathname === '/api/info') {
    return sendJson(res, 200, {
      serverTime: Date.now(),
      requestId: crypto.randomUUID(),
      protocol: req.httpVersion,
      remoteFamily: req.socket.remoteFamily || null
    });
  }

  if (pathname === '/api/download' && req.method === 'GET') {
    const bytes = Math.max(1, Math.min(MAX_BYTES, Number(url.searchParams.get('bytes') || 0)));
    if (!Number.isFinite(bytes)) return sendJson(res, 400, { error: 'Invalid bytes' });

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(Math.floor(bytes)));
    res.setHeader('Content-Encoding', 'identity');
    noCache(res);

    let remaining = Math.floor(bytes);
    const pump = () => {
      while (remaining > 0) {
        const amount = Math.min(remaining, zeroChunk.length);
        const ok = res.write(amount === zeroChunk.length ? zeroChunk : zeroChunk.subarray(0, amount));
        remaining -= amount;
        if (!ok) return res.once('drain', pump);
      }
      res.end();
    };
    return pump();
  }

  if (pathname === '/api/upload' && req.method === 'POST') {
    let received = 0;
    const started = process.hrtime.bigint();
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_BYTES) req.destroy();
    });
    req.on('end', () => {
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      sendJson(res, 200, { received, elapsedMs });
    });
    req.on('error', () => {
      if (!res.headersSent) sendJson(res, 400, { error: 'Upload interrupted' });
    });
    return;
  }

  if (serveStatic(req, res, pathname)) return;
  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('Not found');
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.listen(port, host, () => {
  console.log(`Precision Speed Lab running on http://${host}:${port}`);
});
