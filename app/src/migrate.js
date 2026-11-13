// One-off migration entrypoint, run as its own ECS task before the service
// is updated: node src/migrate.js. It connects as the database owner (the
// RDS-managed master secret), applies pending migrations and, when
// DB_APP_USER is set, makes sure the service's least-privilege user exists.
import { loadDbConfig } from './config.js';
import { createPool, ensureAppUser, migrate } from './db.js';
import { createLogger } from './logger.js';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');
const pool = await createPool({ ...loadDbConfig(), poolMax: 1 });
try {
  await migrate(pool, logger);
  const appUser = process.env.DB_APP_USER;
  if (appUser) await ensureAppUser(pool, appUser, logger);
  logger.info('migration task complete');
} catch (err) {
  logger.error({ err }, 'migration task failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
