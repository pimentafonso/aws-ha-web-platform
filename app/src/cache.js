import { createClient } from 'redis';

// Cache-aside wrapper. The cache is an optimisation, never a dependency:
// if Redis is unavailable, reads and writes fall through to Postgres and a
// warning is logged.
export function createCache(url, ttlSeconds, logger) {
  const client = createClient({
    url,
    socket: {
      connectTimeout: 2000,
      reconnectStrategy: (retries) => Math.min(retries * 200, 5000),
    },
    // Fail fast instead of queueing commands while disconnected.
    disableOfflineQueue: true,
  });
  client.on('error', (err) => logger.warn({ err: err.message }, 'redis error'));

  // Connect in the background. node-redis retries the initial connection
  // indefinitely, so awaiting it would block start-up whenever Redis is down.
  client.connect().catch((err) => logger.warn({ err: err.message }, 'redis connect failed'));

  async function safe(operation, fallback) {
    if (!client.isReady) return fallback;
    try {
      return await operation();
    } catch (err) {
      logger.warn({ err: err.message }, 'cache operation failed');
      return fallback;
    }
  }

  return {
    async get(key) {
      const raw = await safe(() => client.get(key), null);
      return raw === null ? null : JSON.parse(raw);
    },
    set(key, value) {
      return safe(() => client.set(key, JSON.stringify(value), { EX: ttlSeconds }), null);
    },
    del(key) {
      return safe(() => client.del(key), null);
    },
    async ping() {
      return client.isReady && (await client.ping()) === 'PONG';
    },
    async close() {
      if (client.isReady) await client.close();
      else if (client.isOpen) client.destroy(); // still reconnecting: nothing to flush
    },
  };
}
