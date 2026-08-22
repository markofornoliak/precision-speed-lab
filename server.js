import { startServer } from './src/speed-server.js';

const server = startServer();
let shuttingDown = false;

function log(level, event, fields = {}) {
  const writer = level === 'error' ? console.error : console.log;
  writer(JSON.stringify({ timestamp: new Date().toISOString(), level, event, service: 'precision-speed-lab', ...fields }));
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'shutdown_started', { signal });
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
