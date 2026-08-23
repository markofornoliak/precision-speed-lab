import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpeedServer } from '../src/speed-server.js';
import { attachProductionGateway } from '../src/production-gateway.js';

const MIB = 1024 * 1024;
const ORIGIN = 'https://markofornoliak.github.io';

async function withGateway(run, gatewayOverrides = {}) {
  const server = createSpeedServer({
    maxBytes: 2 * MIB,
    randomPoolBytes: 128 * 1024,
    downloadChunk: 32 * 1024,
    maxActiveGlobal: 16,
    maxActivePerClient: 8,
    maxRequestsPerWindow: 1000,
    maxBytesPerWindow: 64 * MIB,
    logger: () => {},
    nodeId: 'core-node',
    region: 'core-region',
  });
  const gateway = attachProductionGateway(server, {
    nodeId: 'edge-node',
    region: 'eu-central',
    publicBaseUrl: 'https://edge.example.test',
    allowedOrigins: [ORIGIN],
    regionalServers: [
      { id: 'fra-2', region: 'eu-central', url: 'https://fra-2.example.test', priority: 10, capacity: 2 },
      { id: 'iad-1', region: 'us-east', url: 'https://iad-1.example.test', priority: 20, capacity: 1 },
    ],
    maxConnections: 64,
    maxRssMiB: 2048,
    shedRssRatio: 1,
    shedElu: 1,
    bucketCapacity: 1000,
    refillPerSecond: 1000,
    ...gatewayOverrides,
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run({ baseUrl, gateway });
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    });
  }
}

test('production gateway exposes Render health and strict readiness independently', async () => {
  await withGateway(async ({ baseUrl, gateway }) => {
    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.node.id, 'edge-node');

    const ready = await fetch(`${baseUrl}/readyz`);
    assert.equal(ready.status, 200);
    const readyBody = await ready.json();
    assert.equal(readyBody.ok, true);
    assert.equal(readyBody.node.region, 'eu-central');
    assert.ok(Number.isFinite(readyBody.runtime.rssBytes));

    gateway.beginDrain();
    const snapshot = gateway.snapshot();
    assert.equal(snapshot.ok, false);
    assert.equal(snapshot.draining, true);
  });
});

test('production gateway preserves exact measurement path while adding admission controls', async () => {
  await withGateway(async ({ baseUrl }) => {
    const bytes = 128 * 1024;
    const response = await fetch(`${baseUrl}/api/download?bytes=${bytes}`);
    assert.equal(response.status, 200);
    assert.equal(Number(response.headers.get('x-test-bytes')), bytes);
    assert.equal((await response.arrayBuffer()).byteLength, bytes);
  });
});

test('payload-weighted admission keeps calibration transfers inside a realistic burst budget', async () => {
  await withGateway(async ({ baseUrl }) => {
    const bytes = 128 * 1024;
    for (let index = 0; index < 6; index += 1) {
      const response = await fetch(`${baseUrl}/api/download?bytes=${bytes}`);
      assert.equal(response.status, 200, `calibration transfer ${index + 1} should remain admissible`);
      assert.equal((await response.arrayBuffer()).byteLength, bytes);
    }
  }, { bucketCapacity: 20, refillPerSecond: 0.1 });
});

test('regional discovery, capacity hints and split-frontend CORS are first-class', async () => {
  await withGateway(async ({ baseUrl }) => {
    const preflight = await fetch(`${baseUrl}/api/upload`, {
      method: 'OPTIONS',
      headers: {
        Origin: ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN);
    assert.match(preflight.headers.get('access-control-allow-methods') || '', /POST/);

    const discovery = await fetch(`${baseUrl}/api/servers`, { headers: { Origin: ORIGIN } });
    assert.equal(discovery.status, 200);
    assert.equal(discovery.headers.get('access-control-allow-origin'), ORIGIN);
    const body = await discovery.json();
    assert.equal(body.strategy, 'client-rtt-with-capacity-hints');
    assert.equal(body.self.id, 'edge-node');
    assert.equal(body.self.current, true);
    assert.equal(body.servers.length, 2);
    assert.equal(body.servers[0].id, 'fra-2');
    assert.equal(body.servers[0].capacity, 2);
  });
});

test('draining node remains healthy but refuses readiness and new heavy transfers', async () => {
  await withGateway(async ({ baseUrl, gateway }) => {
    gateway.beginDrain();

    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).draining, true);

    const ready = await fetch(`${baseUrl}/readyz`);
    assert.equal(ready.status, 503);
    assert.equal(ready.headers.get('retry-after'), '2');
    assert.equal((await ready.json()).draining, true);

    const response = await fetch(`${baseUrl}/api/download?bytes=1024`, { headers: { Origin: ORIGIN } });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '2');
    assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
    const body = await response.json();
    assert.equal(body.retryable, true);
    assert.match(body.error, /draining/i);
  });
});
