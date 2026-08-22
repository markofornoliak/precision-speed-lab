import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createSpeedServer } from '../src/speed-server.js';

const MIB = 1024 * 1024;

async function withServer(run, overrides = {}) {
  const server = createSpeedServer({
    maxBytes: 2 * MIB,
    randomPoolBytes: 128 * 1024,
    downloadChunk: 32 * 1024,
    maxActiveGlobal: 16,
    maxActivePerClient: 8,
    maxRequestsPerWindow: 1000,
    maxBytesPerWindow: 64 * MIB,
    metricsEnabled: true,
    logger: () => {},
    nodeId: 'test-node',
    region: 'test-region',
    ...overrides,
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    });
  }
}

test('health, capabilities, discovery and IPv4 awareness are coherent', async () => {
  await withServer(async (baseUrl) => {
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.node.id, 'test-node');
    assert.equal(healthBody.node.region, 'test-region');
    assert.equal(healthBody.limits.maxTransferBytes, 2 * MIB);
    assert.ok(Number.isFinite(healthBody.runtime.eventLoopDelayP95Ms));

    const capabilities = await fetch(`${baseUrl}/api/capabilities`);
    assert.equal(capabilities.status, 200);
    const body = await capabilities.json();
    assert.equal(body.maxTransferBytes, 2 * MIB);
    assert.deepEqual(body.recommendedSizesMiB, [1, 2]);
    assert.equal(body.features.uploadProgress, true);
    assert.equal(body.features.regionalServerDiscovery, true);
    assert.equal(body.features.serverReceiveTiming, true);

    const discovery = await fetch(`${baseUrl}/api/servers`);
    const discoveryBody = await discovery.json();
    assert.equal(discoveryBody.self.id, 'test-node');
    assert.equal(discoveryBody.self.current, true);

    const info = await fetch(`${baseUrl}/api/info`);
    const infoBody = await info.json();
    assert.equal(infoBody.clientFamily, 'IPv4');
    assert.match(infoBody.protocol, /^HTTP\//);
  });
});

test('ping is uncached, lightweight and has measurement-node headers', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/ping?nonce=${Date.now()}`);
    assert.equal(response.status, 204);
    assert.match(response.headers.get('cache-control') || '', /no-store/);
    assert.equal(response.headers.get('server-timing'), 'app;dur=0');
    assert.equal(response.headers.get('x-measurement-node'), 'test-node');
  });
});

test('download streams the exact requested byte count with identity encoding', async () => {
  await withServer(async (baseUrl) => {
    const bytes = 384 * 1024;
    const response = await fetch(`${baseUrl}/api/download?bytes=${bytes}&nonce=${Date.now()}`);
    assert.equal(response.status, 200);
    assert.equal(Number(response.headers.get('content-length')), bytes);
    assert.equal(Number(response.headers.get('x-test-bytes')), bytes);
    assert.equal(response.headers.get('content-encoding'), 'identity');
    const payload = await response.arrayBuffer();
    assert.equal(payload.byteLength, bytes);
  });
});

test('download validation rejects missing, malformed and oversized byte counts', async () => {
  await withServer(async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/api/download`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/download?bytes=1.2`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/download?bytes=${3 * MIB}`)).status, 413);
  });
});

test('upload consumes bytes as a stream and reports exact server receive timing', async () => {
  await withServer(async (baseUrl) => {
    const bytes = 512 * 1024;
    const response = await fetch(`${baseUrl}/api/upload?id=${crypto.randomUUID()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: crypto.randomBytes(bytes),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.received, bytes);
    assert.ok(result.elapsedMs > 0);
    assert.ok(result.serverMeasuredMbps > 0);
    assert.match(result.receiveStartedNs, /^\d+$/);
    assert.match(result.receiveEndedNs, /^\d+$/);
    assert.ok(BigInt(result.receiveEndedNs) > BigInt(result.receiveStartedNs));
    assert.equal(Number(response.headers.get('x-test-bytes')), bytes);
  });
});

test('zero-byte uploads are rejected instead of becoming a zero-speed measurement', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(0),
    });
    assert.equal(response.status, 400);
  });
});

test('streaming upload exposes low-memory progress telemetry while active', async () => {
  await withServer(async (baseUrl) => {
    const id = crypto.randomUUID();
    const chunk = new Uint8Array(32 * 1024);
    let remaining = 10;
    const body = new ReadableStream({
      async pull(controller) {
        if (remaining <= 0) { controller.close(); return; }
        await new Promise((resolve) => setTimeout(resolve, 18));
        controller.enqueue(chunk);
        remaining -= 1;
        if (remaining === 0) controller.close();
      },
    });

    const uploadPromise = fetch(`${baseUrl}/api/upload?id=${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
      duplex: 'half',
    });

    await new Promise((resolve) => setTimeout(resolve, 70));
    const progress = await fetch(`${baseUrl}/api/progress?ids=${id}`);
    assert.equal(progress.status, 200);
    const progressBody = await progress.json();
    assert.equal(progressBody.transfers.length, 1);
    assert.ok(progressBody.transfers[0].received > 0);
    assert.ok(progressBody.transfers[0].received < 10 * chunk.byteLength);

    const upload = await uploadPromise;
    assert.equal(upload.status, 200);
    const result = await upload.json();
    assert.equal(result.received, 10 * chunk.byteLength);
  });
});

test('upload rejects invalid transfer ids, content types and oversized payloads', async () => {
  await withServer(async (baseUrl) => {
    const invalidId = await fetch(`${baseUrl}/api/upload?id=not-a-uuid`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(1),
    });
    assert.equal(invalidId.status, 400);

    const invalidType = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'abc',
    });
    assert.equal(invalidType.status, 415);

    const oversized = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: crypto.randomBytes(3 * MIB),
    });
    assert.equal(oversized.status, 413);
  });
});

test('per-client concurrency protection rejects excess active streams', async () => {
  await withServer(async (baseUrl) => {
    const firstId = crypto.randomUUID();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let emitted = false;
    const slowBody = new ReadableStream({
      async pull(controller) {
        if (!emitted) {
          controller.enqueue(new Uint8Array(16 * 1024));
          emitted = true;
          await gate;
          controller.close();
        }
      },
    });
    const first = fetch(`${baseUrl}/api/upload?id=${firstId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: slowBody, duplex: 'half',
    });
    await new Promise((resolve) => setTimeout(resolve, 35));
    const second = await fetch(`${baseUrl}/api/upload?id=${crypto.randomUUID()}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(10),
    });
    assert.equal(second.status, 429);
    release();
    assert.equal((await first).status, 200);
  }, { maxActivePerClient: 1 });
});

test('byte quota protects the node from abusive repeated transfers', async () => {
  await withServer(async (baseUrl) => {
    const first = await fetch(`${baseUrl}/api/download?bytes=${700 * 1024}`);
    assert.equal(first.status, 200);
    await first.arrayBuffer();
    const second = await fetch(`${baseUrl}/api/download?bytes=${700 * 1024}`);
    assert.equal(second.status, 429);
  }, { maxBytesPerWindow: MIB });
});

test('request-rate limiter returns 429 without unbounded state', async () => {
  await withServer(async (baseUrl) => {
    const first = await fetch(`${baseUrl}/api/ping`);
    const second = await fetch(`${baseUrl}/api/ping`);
    const third = await fetch(`${baseUrl}/api/ping`);
    assert.equal(first.status, 204);
    assert.equal(second.status, 204);
    assert.equal(third.status, 429);
    assert.ok(Number(third.headers.get('retry-after')) >= 1);
  }, { maxRequestsPerWindow: 2 });
});

test('CORS preflight does not consume the measurement request quota', async () => {
  await withServer(async (baseUrl) => {
    for (let index = 0; index < 5; index += 1) {
      const preflight = await fetch(`${baseUrl}/api/ping`, { method: 'OPTIONS', headers: { Origin: 'https://example.test' } });
      assert.equal(preflight.status, 204);
    }
    assert.equal((await fetch(`${baseUrl}/api/ping`)).status, 204);
    assert.equal((await fetch(`${baseUrl}/api/ping`)).status, 429);
  }, { maxRequestsPerWindow: 1, allowedOrigins: ['https://example.test'] });
});

test('Prometheus metrics use bounded route labels for unknown API paths', async () => {
  await withServer(async (baseUrl) => {
    for (let index = 0; index < 5; index += 1) await fetch(`${baseUrl}/api/random-${index}`);
    const response = await fetch(`${baseUrl}/metrics`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /route="\/api\/other"/);
    assert.doesNotMatch(text, /random-0|random-1|random-2|random-3|random-4/);
  });
});

test('Prometheus metrics can be protected with a bearer token', async () => {
  await withServer(async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/metrics`)).status, 401);
    await fetch(`${baseUrl}/api/ping`);
    const response = await fetch(`${baseUrl}/metrics`, { headers: { Authorization: 'Bearer test-token' } });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /precision_speed_lab_requests_total/);
    assert.match(text, /precision_speed_lab_active_transfers/);
  }, { metricsToken: 'test-token' });
});

test('static responses carry hardening headers', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.match(response.headers.get('content-security-policy') || '', /default-src 'self'/);
  });
});
