// All configuration comes from environment variables. On ECS, the database
// credentials are injected from Secrets Manager into the task's environment.

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

export function loadConfig() {
  return {
    port: integer('PORT', 3000),
    logLevel: process.env.LOG_LEVEL ?? 'info',
    db: {
      host: required('DB_HOST'),
      port: integer('DB_PORT', 5432),
      database: required('DB_NAME'),
      user: required('DB_USER'),
      password: required('DB_PASSWORD'),
      // Path to the RDS CA bundle. When set, TLS is required and the
      // server certificate is verified.
      sslCaPath: process.env.DB_SSL_CA_PATH || null,
      poolMax: integer('DB_POOL_MAX', 10),
    },
    // redis:// locally, rediss:// (TLS) against ElastiCache.
    redisUrl: required('REDIS_URL'),
    // AUTH token, injected from Secrets Manager on ECS. Unset locally.
    redisPassword: process.env.REDIS_PASSWORD || undefined,
    cacheTtlSeconds: integer('CACHE_TTL_SECONDS', 60),
    shutdownTimeoutMs: integer('SHUTDOWN_TIMEOUT_MS', 20000),
  };
}
