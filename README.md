# Precision Speed Lab

Precision Speed Lab is a deliberately minimal browser network-performance instrument backed by a dependency-free Node.js measurement server.

The visible interface is intentionally quiet. The engineering underneath is not: exact byte accounting, connection warm-up, adaptive payload duration, dynamic 1 → 2 → 4 → 8 stream calibration, repeat runs, robust aggregation, loaded latency, throughput variability, cancellation, abuse protection, structured logs, optional Prometheus metrics, Docker deployment, and regional-node discovery are built into the current architecture.

The frontend follows the same principle. High-resolution measurement data, rate-limited presentation telemetry, and immutable completed results are kept separate so rendering work does not become part of the workload being measured. The active test has no decorative animation loop and does not continuously redraw the result chart.

## Measurement principles

The project follows one rule above all others: **do not display a metric unless the implementation can defend what that metric means.**

### Throughput

- Download is calculated from bytes actually read by the browser divided by browser wall-clock duration of the main run.
- Upload is calculated from bytes accepted by the measurement server over its monotonic receive window, from the first received byte to the last. Response-return latency is not folded into the final upload throughput.
- Main runs are preceded by connection warm-up to reduce connection-establishment and TCP slow-start effects.
- `Auto` payload mode targets a measurement duration from a short calibration and caps the request at the server-advertised maximum.
- Auto stream mode calibrates 1, 2, 4 and 8 streams and only escalates when additional concurrency produces a meaningful gain.
- The final headline number is the median of repeated run-level throughput results.
- With at least five runs, gross run-level outliers can be excluded using a median-absolute-deviation (MAD) rule. Raw and used run counts remain visible as expert evidence.
- The 95% interval shown in the UI is a percentile-bootstrap confidence interval for the run-level median. It is **not** called “measurement accuracy.”

### Latency and jitter

- Idle latency is browser-observed HTTP round-trip time (RTT) to `/api/ping`.
- P50 / P90 / P95 / P99 are calculated from successful idle RTT samples using linear percentile interpolation.
- Jitter is the mean absolute difference between consecutive RTT samples (`mean |RTT[n] - RTT[n-1]|`).
- Loaded latency is measured with concurrent HTTP RTT probes while download or upload is active.
- A loaded-latency result is published only when probe qualification criteria are satisfied.

### Probe loss limitation

A normal browser HTTP/TCP test cannot honestly measure network-layer packet loss because TCP retransmits lost packets before the application sees them. The UI therefore does **not** invent an L3 “packet loss” percentage. It reports **HTTP probe loss**: the fraction of timed-out or failed application-level latency probes.

A future true packet-loss mode would need a protocol that exposes datagram delivery/loss directly and would be named separately.

### Variation and bufferbloat

- Download and upload variation are independent.
- Throughput variation is expressed as the coefficient of variation (CV) of steady-state throughput samples; lower CV means steadier throughput. No arbitrary `100 - CV` score is used.
- Bufferbloat is shown as the actual increase between the worst qualified loaded P50 RTT and idle P50 RTT.

## Frontend architecture

The browser UI remains framework-free and has **zero production runtime dependencies**.

- `public/measurement-core.js` contains measurement/statistical helpers and remains the mathematical source of truth.
- `public/ui-core.js` contains the explicit frontend state machine, number formatting, error classification, chart decimation, and immutable final-result promotion.
- `public/app.js` orchestrates the measurement lifecycle and presentation without allowing measurement samples to drive expensive rendering directly.
- Live numeric presentation is rate-limited; high-resolution samples used for calculations are not discarded or visually smoothed.
- The chart is rendered only when expert evidence is deliberately opened after a completed measurement. It is DPR-aware, resize-aware, and decimates points without inventing intermediate values.
- Lifecycle changes such as backgrounding, page hiding, or freezing invalidate an active measurement rather than silently publishing a potentially corrupted result.
- Cancellation aborts active transfer work and cannot promote partial metrics to a final result.

The UI state model includes booting, server-ready, idle, preparation, latency, download/upload calibration and warm-up, active download/upload, analysis, completion, cancellation, cancelled, and error states. Illegal state transitions are rejected.

## Browser and Safari behavior

Request-body streaming is used only when both the browser API and the negotiated transport make that path defensible. In particular, the frontend enables streaming request bodies over negotiated HTTP/2 or HTTP/3; HTTP/1.1, unsupported browsers, and uncertain transports use the bounded Blob/chunk fallback. Both upload paths preserve server receive-window timing for the final metric.

WebKit is exercised in browser CI for the primary measurement flow, cancellation behavior, accessibility, and mobile geometry. The UI also handles safe-area insets, reduced motion, viewport changes, and measurement invalidation on lifecycle suspension.

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
- request-body streaming on eligible HTTP/2 or HTTP/3 browser transports;
- bounded chunk fallback elsewhere;
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
npm install
npm run check
npm start
```

Open `http://localhost:3000`.

The installed packages are development-only browser QA tools; the production application has no runtime package dependencies.

For browser QA:

```bash
npx playwright install chromium webkit
npm run test:browser
```

`npm run test:browser:update-visuals` is reserved for deliberate visual-baseline updates after a reviewed design change.

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

## CI quality gates

GitHub Actions blocks a change unless all relevant quality gates pass:

1. syntax, measurement-core, statistical, backend integration, UI-state, formatting and frontend-budget checks on Node.js 20 and 22;
2. production runtime-dependency and transferred-size budgets;
3. Chromium behavioral tests for boot, controls, phases, completion, structured errors, lifecycle invalidation, cancellation, immutable final results and on-demand chart rendering;
4. WebKit coverage for the primary flow, cancellation-race handling, accessibility-sensitive behavior and mobile geometry;
5. automated accessibility checks with axe for serious regressions;
6. exact responsive checks at 320×568, 360×800, 375×812, 390×844, 393×852, 430×932, tablet portrait/landscape, desktop and ultrawide dimensions, including deliberately extreme numeric values;
7. cancellation-race checks that fail on uncaught errors or unhandled Promise rejections;
8. deterministic visual-regression fingerprints for idle desktop, running download, running upload, completed desktop, idle mobile, completed mobile and error states;
9. Docker Compose validation and a production image build;
10. hardened read-only container startup plus end-to-end frontend assets, capabilities, exact 1 MiB download/upload transfers and server receive-window timing checks.

Automation complements rather than replaces visual and measurement-semantic review.

## Important deployment notes

For credible Internet speed results, the measurement node itself must have enough CPU, memory, socket capacity and upstream bandwidth to exceed the connections being tested. Reverse proxies/CDNs must not compress, buffer, cache, rate-shape or transform `/api/download`, `/api/upload`, `/api/ping` or `/api/progress` in a way that changes measurement semantics.

If a proxy is used, enable `TRUST_PROXY=1` **only** when that proxy is trusted and overwrites `X-Forwarded-For`; otherwise a client could spoof the key used by per-client protection.
