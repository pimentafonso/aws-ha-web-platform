import { createApp } from './app.js';
import { createCache } from './cache.js';
import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { createLogger } from './logger.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);

const pool = await createPool(config.db);
pool.on('error', (err) => logger.error({ err: err.message }, 'idle database client error'));
await migrate(pool, logger);

const cache = createCache(config.redisUrl, config.cacheTtlSeconds, logger);
const app = createApp({ pool, cache, logger });

const server = app.listen(config.port, () => logger.info({ port: config.port }, 'listening'));
// Must exceed the ALB idle timeout (60 s) so the ALB, not Node, closes idle connections.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

// ECS sends SIGTERM when it stops a task, after the ALB has started draining
// it. Stop accepting new connections, let in-flight requests finish, then exit.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  const forceExit = setTimeout(() => {
    logger.error('shutdown timed out, exiting');
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceExit.unref();

  server.close(async () => {
    await Promise.allSettled([pool.end(), cache.close()]);
    logger.info('shutdown complete');
    process.exit(0);
  });
  server.closeIdleConnections();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
