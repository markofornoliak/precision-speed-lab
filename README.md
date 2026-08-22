# Precision Speed Lab

Web-based network speed test with real byte transfer.

## Features
- Ping and jitter sampling
- Download and upload throughput
- Test payloads: 1, 2, 5, 10, 100, 250, 500 MB
- 1–8 parallel streams
- Precision mode with repeated runs and median aggregation
- Live throughput chart
- Cache disabled on measurement endpoints
- No large binary assets: download bytes are generated on demand
- Upload uses repeated chunks, avoiding 500 MB browser allocations
- Responsive mobile UI

## Run
Requires Node.js 20+.

```bash
npm start
```

Open `http://localhost:3000`.

## Important deployment note
For meaningful public results, deploy the server close to a high-capacity network edge with enough egress bandwidth. A slow VPS will measure the VPS, not the user's access line.

Reverse proxies/CDNs must not cache or compress `/api/download`, `/api/upload`, or `/api/ping`.

## Docker

```bash
docker build -t precision-speed-lab .
docker run --rm -p 3000:3000 precision-speed-lab
```

## Accuracy notes
- Use a server with substantially more bandwidth than the client being tested.
- Keep the server CPU lightly loaded.
- For 1–10 MB tests, RTT/setup overhead is a larger part of the result; 100–500 MB is better for high-speed links.
- Wi-Fi tests measure the complete path, including Wi-Fi quality.
- Browser timing and OS scheduling impose a practical precision limit; repeated-run median mode reduces variance but is not a calibrated laboratory instrument.
