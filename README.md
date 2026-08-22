# Precision Speed Lab

Precision Speed Lab is a browser-based network performance tester that transfers real bytes between the client and server. It is designed for accurate throughput, latency, jitter, loaded-latency and stability measurements rather than a decorative speedometer.

## What is implemented

### Frontend
- Ping and jitter sampling
- Download and upload throughput
- Payload presets: 1, 2, 5, 10, 100, 250 and 500 MiB
- 1–8 parallel streams
- Precision mode with repeated runs and median aggregation
- Live throughput chart
- Loaded latency and bufferbloat-oriented measurements
- Responsive desktop/mobile interface

### Backend
- Real streamed download endpoint up to 500 MiB per request
- Real streamed upload endpoint up to 500 MiB per request
- Random binary payload pool to avoid synthetic zero-filled transfers
- Exact `Content-Length` on downloads
- Cache and CDN-cache disabling on all measurement endpoints
- Compression disabled for measurement payloads
- High-resolution server-side upload timing
- Transfer IDs and request IDs
- Health endpoint
- Capabilities endpoint
- Server/network information endpoint
- Concurrent-transfer protection without bandwidth throttling
- Optional trusted-proxy awareness
- Optional CORS for split frontend/backend deployments
- Graceful SIGTERM/SIGINT shutdown
- Static frontend serving from the same process
- Docker healthcheck
- Integration tests using Node's built-in test runner
- GitHub Actions CI for syntax checks, integration tests and Docker build validation

## API

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/ping` | GET / HEAD | Low-overhead RTT sampling |
| `/api/info` | GET | Protocol and connection information |
| `/api/health` | GET / HEAD | Service health and active-transfer status |
| `/api/capabilities` | GET | Backend limits and supported test sizes |
| `/api/download?bytes=104857600` | GET / HEAD | Stream an exact number of bytes to the client |
| `/api/upload` | POST | Receive a streamed upload and return server-side timing |

The default single-transfer maximum is `524288000` bytes (500 MiB).

## Run locally

Requires Node.js 20 or newer.

```bash
npm start
```

Open:

```text
http://localhost:3000
```

Development mode:

```bash
npm run dev
```

Backend validation:

```bash
npm run check
```

## Docker

Build and run directly:

```bash
docker build -t precision-speed-lab .
docker run --rm -p 3000:3000 precision-speed-lab
```

Or use Compose:

```bash
docker compose up -d --build
```

## Environment variables

Copy `.env.example` as a reference.

| Variable | Default | Description |
|---|---:|---|
| `HOST` | `0.0.0.0` | Bind address |
| `PORT` | `3000` | HTTP port |
| `MAX_TRANSFER_BYTES` | `524288000` | Maximum single upload/download |
| `DOWNLOAD_CHUNK_BYTES` | `262144` | Server streaming chunk size |
| `RANDOM_POOL_BYTES` | `4194304` | In-memory random payload pool |
| `MAX_ACTIVE_TRANSFERS` | `128` | Maximum server-wide concurrent measurement streams |
| `MAX_ACTIVE_PER_CLIENT` | `16` | Maximum concurrent streams per client |
| `TRUST_PROXY` | `0` | Trust `X-Forwarded-For` when behind your own reverse proxy |
| `CORS_ORIGIN` | blank | Optional separate frontend origin |

## GitHub Actions

`.github/workflows/backend-ci.yml` runs automatically on backend changes and checks:

1. JavaScript syntax
2. Integration tests for health, ping, download and upload
3. Oversized-transfer rejection
4. Production Docker image build

## Important: GitHub vs live backend

The complete backend source code lives in this GitHub repository, but **GitHub Pages cannot run a persistent Node.js backend**. Pages can host static HTML/CSS/JavaScript only.

For a real public speed-test service, deploy this repository or its Docker image to a server/VPS/cloud instance with a high-capacity network connection. The frontend can be served by the same Node.js process, which is the preferred configuration because it avoids CORS and gives the cleanest measurement path.

## Accuracy requirements for production

The measurement server must have substantially more available bandwidth than the client connection being tested. Otherwise the result measures the server bottleneck instead of the user's line.

Recommended production characteristics:

- 10 Gbit/s or faster NIC for serious multi-user testing
- Low CPU utilization
- NVMe is not required for payload generation because transfer data is generated in memory
- No CDN caching or HTTP compression on `/api/download`, `/api/upload` or `/api/ping`
- Reverse proxy buffering disabled for measurement routes
- Server geographically close enough to the test population for meaningful latency results
- Multiple regional measurement nodes for Ookla-style geographic coverage

For 1–10 MiB transfers, handshake/RTT overhead can noticeably affect the result. Larger 100–500 MiB transfers are better for measuring high-speed links and sustained throughput.
