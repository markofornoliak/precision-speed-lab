import { startServer } from './src/speed-server.js';

const server = startServer();

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[precision-speed-lab] ${signal} received, closing server...`);

  server.close(() => {
    console.log('[precision-speed-lab] server closed');
    process.exit(0);
  });

  server.closeIdleConnections?.();

  setTimeout(() => {
    console.error('[precision-speed-lab] forced shutdown after timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
