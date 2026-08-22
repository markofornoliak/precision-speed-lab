# Precision Speed Lab

Precision Speed Lab is a deliberately minimal browser network-performance instrument backed by a dependency-free Node.js measurement server.

The UI is intentionally simple. The engineering underneath is not: exact byte accounting, connection warm-up, adaptive payload duration, dynamic 1 → 2 → 4 → 8 stream calibration, repeat runs, robust aggregation, loaded latency, throughput variability, cancellation, abuse protection, structured logs, optional Prometheus metrics, Docker deployment, and regional-node discovery are built into the current architecture.

## Measurement principles

The project follows one rule above all others: **do not display a metric unless the implementation can defend what that metric means.**

### Throughput

- Download is calculated from bytes actually read by the browser divided by wall-clock duration of the main run.
- Upload is calculated from bytes confirmed received by the measurement server divided by wall-clock duration of the main run.
- Main runs are preceded by a connection warm-up to reduce connection-establishment and TCP slow-start effects.
- `Auto` payload mode targets a measurement duration from a short calibration and caps the request at the server-advertised maximum.
- Auto stream mode calibrates 1, 2, 4 and 8 streams and only escalates when the additional concurrency produces a meaningful gain.
- The final headline number is the median of repeated run-level throughput results.
- With at least five runs, gross run-level outliers can be excluded using a median-absolute-deviation (MAD) rule. The raw values remain conceptually distinct from the filtered aggregate.
- The 95% interval shown in the UI is a percentile-bootstrap confidence interval for the run-level median. It is **not** called “measurement accuracy.”

### Latency and jitter

- Idle latency is browser-observed HTTP round-trip time (RTT) to `/api/ping`.
- P50 / P90 / P95 / P99 are calculated from successful idle RTT samples using linear percentile interpolation.
- Jitter is the mean absolute difference between consecutive RTT samples (`mean |RTT[n] - RTT[n-1]|`).
- Loaded latency is measured with concurrent HTTP RTT probes while download or upload is active.

### Packet loss limitation

A normal browser HTTP/TCP test cannot honestly measure network-layer packet loss because TCP retransmits lost packets before the application sees them. For that reason the UI does **not** invent an L3 “packet loss” percentage. It reports **HTTP probe loss**: the fraction of timed-out/failed application-level latency probes.

A future true packet-loss mode should use a protocol that exposes datagram delivery/loss directly (for example a controlled WebRTC/QUIC/UDP measurement path) and should be named separately.

### Stability and bufferbloat

- Download and upload stability are separate.
- Stability is expressed as the coefficient of variation (CV) of throughput samples; lower CV means steadier throughput. No arbitrary `100 - CV` score is used.
- Bufferbloat analysis compares loaded P50 RTT with idle P50 RTT. The letter grade is a documented heuristic derived from the added latency; the added milliseconds are displayed alongside it.

## Backend API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | node health, runtime pressure, transfer counters/limits |
| `GET /api/capabilities` | supported features, limits and measurement endpoints |
| `GET /api/servers` | current node plus configured regional candidates |
| `GET/HEAD /api/ping` | tiny uncached RTT probe |
| `GET /api/info` | HTTP protocol, IPv4/IPv6 family and node identity |
| `GET /api/download?bytes=N` | exact-length streaming download |
| `POST /api/upload?id=UUID` | bounded streaming upload |
| `GET /api/progress?id=UUID` | one active upload progress record |
| `GET /api/progress?ids=UUID,...` | batched active-upload progress for live telemetry |
| `GET /metrics` | optional Prometheus text metrics |

All measurement responses are `no-store`. Download uses `Content-Encoding: identity`. Upload accepts only uncompressed `application/octet-stream` bodies and enforces the configured byte ceiling even for chunked request bodies.

## Reliability and protection

The server intentionally uses Node core modules only.

- global and per-client concurrent-transfer limits;
- rolling per-client request limit;
- rolling per-client transfer-byte quota;
- upload idle timeout;
- exact request-size validation;
- UUID validation for progress telemetry;
- path-traversal-safe static serving;
- CSP and standard browser hardening headers;
- graceful SIGTERM/SIGINT shutdown;
- low-memory download streaming from a small random pool;
- low-memory browser upload streaming when request streams are supported;
- bounded chunk fallback for browsers without streaming request bodies;
- anonymized ephemeral client keys for in-memory protection (raw IP addresses are not logged by default).

The in-memory abuse controls are deliberately per-process. A multi-instance deployment that requires a global quota can add a shared edge/load-balancer policy without changing the measurement API.

## Observability

Logs are newline-delimited JSON on stdout. At `LOG_LEVEL=info`, high-frequency `/api/ping` and `/api/progress` requests are not logged so observability does not add unnecessary noise to latency measurement. Set `LOG_LEVEL=debug` when detailed probe logging is required.

Prometheus metrics are implemented but disabled by default. Enable with:

```bash
ENABLE_METRICS=1
METRICS_TOKEN=replace-with-a-secret
```

Then query `/metrics` with `Authorization: Bearer <token>`.

`/api/health` also reports event-loop P95 delay, event-loop utilization, RSS memory and transfer concurrency. The frontend uses these observable signals only to flag **server contention risk**; it does not claim to detect a physical NIC/ISP bottleneck from data it cannot observe.

## Regional measurement nodes

Each deployment can declare:

```bash
MEASUREMENT_NODE_ID=fra-1
MEASUREMENT_REGION=eu-central
PUBLIC_BASE_URL=https://fra.example.net
MEASUREMENT_SERVERS_JSON='[{"id":"fra-1","region":"eu-central","url":"https://fra.example.net"},{"id":"iad-1","region":"us-east","url":"https://iad.example.net"}]'
```

The browser obtains candidates from `/api/servers`, probes reachable nodes and selects the lowest-median-RTT candidate. Cross-origin regional nodes must allow the frontend origin through `CORS_ORIGINS`.

IPv4/IPv6 awareness is exposed through `/api/info`. The browser cannot force a specific address family; the endpoint reports the family actually observed by the measurement node (or the trusted proxy address when `TRUST_PROXY=1`).

## Run locally

Requires Node.js 20+.

```bash
npm run check
npm start
```

Open `http://localhost:3000`.

## Docker

```bash
docker build -t precision-speed-lab .
docker run --rm -p 3000:3000 precision-speed-lab
```

Or:

```bash
docker compose up --build
```

The supplied Compose service runs as the unprivileged Node user, read-only, with all Linux capabilities dropped and `no-new-privileges` enabled.

## CI

GitHub Actions runs:

1. syntax + statistical + backend integration tests on Node 20 and Node 22;
2. Docker Compose validation;
3. production image build;
4. hardened container startup;
5. frontend asset smoke tests;
6. health/capabilities checks;
7. exact 1 MiB download and upload end-to-end transfer checks.

The test suite covers the statistical definitions as code, not only endpoint availability.

## Important deployment notes

For credible Internet speed results, the measurement node itself must have enough CPU, memory, socket capacity and upstream bandwidth to exceed the connections being tested. Reverse proxies/CDNs must not compress, buffer, cache, rate-shape or transform `/api/download`, `/api/upload`, `/api/ping` or `/api/progress` in a way that changes measurement semantics.

If a proxy is used, enable `TRUST_PROXY=1` **only** when that proxy is trusted and overwrites `X-Forwarded-For`; otherwise a client could spoof the key used by per-client protection.
