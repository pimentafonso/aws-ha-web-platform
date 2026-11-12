import { randomUUID } from 'node:crypto';
import express from 'express';
import { pinoHttp } from 'pino-http';
import { notesRouter } from './notes.js';

export function createApp({ pool, cache, logger }) {
  const app = express();
  app.disable('x-powered-by');
  // One hop: the ALB. CloudFront's address arrives in X-Forwarded-For too.
  app.set('trust proxy', 1);

  app.use(
    pinoHttp({
      logger,
      // Reuse the ALB trace id when present so logs can be matched to ALB access logs.
      genReqId: (req) => req.headers['x-amzn-trace-id'] ?? randomUUID(),
      autoLogging: { ignore: (req) => req.url === '/health' },
      customLogLevel: (req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );
  app.use(express.json({ limit: '32kb' }));

  // Liveness: used by the ALB target group. Deliberately does not touch the
  // database, so a database failover does not make the ALB drain every task.
  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  // Readiness: checks dependencies. Used by humans and synthetic checks.
  app.get('/ready', async (req, res) => {
    const checks = { database: false, cache: false };
    try {
      await pool.query('SELECT 1');
      checks.database = true;
    } catch (err) {
      req.log.warn({ err: err.message }, 'readiness: database check failed');
    }
    try {
      checks.cache = await cache.ping();
    } catch (err) {
      req.log.warn({ err: err.message }, 'readiness: cache check failed');
    }
    // The cache is optional, so only the database decides readiness.
    res.status(checks.database ? 200 : 503).json({ status: checks.database ? 'ok' : 'degraded', checks });
  });

  app.use('/api/notes', notesRouter({ pool, cache }));

  app.use((req, res) => res.status(404).json({ error: 'not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid JSON body' });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'request body too large' });
    }
    req.log.error({ err }, 'unhandled error');
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}
