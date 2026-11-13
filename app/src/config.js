// All configuration comes from environment variables. On ECS, secrets are
// injected from Secrets Manager into the task's environment.

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function integer(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function boolean(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw !== 'true' && raw !== 'false') throw new Error(`${name} must be true or false`);
  return raw === 'true';
}

// DB_AUTH=password (default, local) uses DB_PASSWORD. DB_AUTH=iam (the ECS
// service) signs a short-lived IAM token for every new connection, so the
// service holds no database password at all.
export function loadDbConfig() {
  const authMode = process.env.DB_AUTH || 'password';
  if (authMode !== 'password' && authMode !== 'iam') {
    throw new Error('DB_AUTH must be password or iam');
  }
  const db = {
    host: required('DB_HOST'),
    port: integer('DB_PORT', 5432),
    database: required('DB_NAME'),
    user: required('DB_USER'),
    authMode,
    password: authMode === 'password' ? required('DB_PASSWORD') : undefined,
    region: authMode === 'iam' ? required('AWS_REGION') : undefined,
    // Path to the RDS CA bundle. When set, TLS is required and the
    // server certificate is verified. IAM authentication requires it.
    sslCaPath: process.env.DB_SSL_CA_PATH || null,
    poolMax: integer('DB_POOL_MAX', 10),
  };
  if (authMode === 'iam' && !db.sslCaPath) {
    throw new Error('DB_AUTH=iam requires DB_SSL_CA_PATH (IAM tokens are only accepted over TLS)');
  }
  return db;
}

export function loadConfig() {
  return {
    port: integer('PORT', 3000),
    logLevel: process.env.LOG_LEVEL ?? 'info',
    db: loadDbConfig(),
    // Locally the server applies migrations itself. On ECS a one-off
    // migration task does it with the owner's credentials, and the service
    // (which may not create tables) sets this to false.
    migrateOnStart: boolean('MIGRATE_ON_START', true),
    // redis:// locally, rediss:// (TLS) against ElastiCache.
    redisUrl: required('REDIS_URL'),
    // AUTH token, injected from Secrets Manager on ECS. Unset locally.
    redisPassword: process.env.REDIS_PASSWORD || undefined,
    cacheTtlSeconds: integer('CACHE_TTL_SECONDS', 60),
    shutdownTimeoutMs: integer('SHUTDOWN_TIMEOUT_MS', 20000),
  };
}
