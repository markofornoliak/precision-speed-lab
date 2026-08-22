import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createSpeedServer } from '../src/speed-server.js';

const MIB = 1024 * 1024;

async function withServer(run) {
  const server = createSpeedServer({
    maxBytes: 2 * MIB,
    randomPoolBytes: 128 * 1024,
    downloadChunk: 32 * 1024,
    maxActiveGlobal: 16,
    maxActivePerClient: 8
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
    await new Promise((resolve) => server.close(resolve));
  }
}

test('health and capabilities endpoints respond correctly', async () => {
  await withServer(async (baseUrl) => {
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.service, 'precision-speed-lab');

    const capabilities = await fetch(`${baseUrl}/api/capabilities`);
    assert.equal(capabilities.status, 200);
    const body = await capabilities.json();
    assert.equal(body.maxTransferBytes, 2 * MIB);
    assert.deepEqual(body.recommendedSizesMiB, [1, 2]);
  });
});

test('ping is uncached and lightweight', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/ping?nonce=${Date.now()}`);
    assert.equal(response.status, 204);
    assert.match(response.headers.get('cache-control') || '', /no-store/);
    assert.equal(response.headers.get('server-timing'), 'app;dur=0');
  });
});

test('download streams the exact requested byte count', async () => {
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

test('download rejects oversized requests', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/download?bytes=${3 * MIB}`);
    assert.equal(response.status, 413);
  });
});

test('upload consumes bytes as a stream and reports server timing', async () => {
  await withServer(async (baseUrl) => {
    const bytes = 512 * 1024;
    const response = await fetch(`${baseUrl}/api/upload?nonce=${Date.now()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: crypto.randomBytes(bytes)
    });

    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.received, bytes);
    assert.ok(result.elapsedMs >= 0);
    assert.ok(result.serverMeasuredMbps >= 0);
    assert.equal(Number(response.headers.get('x-test-bytes')), bytes);
  });
});

test('upload rejects payloads larger than the configured maximum', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: crypto.randomBytes(3 * MIB)
    });
    assert.equal(response.status, 413);
  });
});
