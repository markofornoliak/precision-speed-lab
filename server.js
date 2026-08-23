import { createSpeedServer } from './src/speed-server.js';
import { attachProductionGateway } from './src/production-gateway.js';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const server = createSpeedServer();
const gateway = attachProductionGateway(server);
let shuttingDown = false;

function log(level, event, fields = {}) {
  const writer = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  writer(JSON.stringify({ timestamp: new Date().toISOString(), level, event, service: 'precision-speed-lab', ...fields }));
}

server.listen(port, host, () => {
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  log('info', 'server_listening', { host, port: boundPort, gateway: gateway.snapshot() });
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  gateway.beginDrain();
  log('info', 'shutdown_started', { signal, gateway: gateway.snapshot() });
  server.close(() => {
    log('info', 'shutdown_complete', { signal });
    process.exit(0);
  });
  server.closeIdleConnections?.();
  setTimeout(() => {
    log('error', 'shutdown_forced', { signal });
    process.exit(1);
  }, 10_000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
