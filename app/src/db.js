import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Signer } from '@aws-sdk/rds-signer';
import pg from 'pg';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
// Arbitrary constant: every task that starts takes the same advisory lock, so
// only one of them applies migrations at a time.
const MIGRATION_LOCK_ID = 7_310_442;

export async function createPool(dbConfig) {
  const ssl = dbConfig.sslCaPath
    ? { rejectUnauthorized: true, ca: await readFile(dbConfig.sslCaPath, 'utf8') }
    : false;

  return new pg.Pool({
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    user: dbConfig.user,
    // pg calls a password function for every new connection. An IAM token is
    // valid for 15 minutes, and signing one is a local computation with the
    // task role's credentials (no network call).
    password: dbConfig.authMode === 'iam' ? iamTokenSigner(dbConfig) : dbConfig.password,
    ssl,
    max: dbConfig.poolMax,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });
}

function iamTokenSigner({ host, port, user, region }) {
  const signer = new Signer({ hostname: host, port, username: user, region });
  return () => signer.getAuthToken();
}

const IDENTIFIER_RE = /^[a-z_][a-z0-9_]{0,62}$/;

// Creates (if needed) the login role the service connects as, and grants it
// only what the API uses: read and write rows in the existing and future
// tables of the public schema. It cannot create, alter or drop anything, and
// cannot read the migration history. On RDS the role is also granted
// rds_iam, so it logs in with IAM tokens instead of a password. Run by the
// migration task as the database owner; safe to run repeatedly.
export async function ensureAppUser(pool, username, logger) {
  if (!IDENTIFIER_RE.test(username)) throw new Error(`invalid database user name: ${username}`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [username]);
    if (rowCount === 0) await client.query(`CREATE ROLE ${username} LOGIN`);
    const iam = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'rds_iam'");
    if (iam.rowCount === 1) await client.query(`GRANT rds_iam TO ${username}`);
    const { rows } = await client.query('SELECT current_database() AS db');
    await client.query(`GRANT CONNECT ON DATABASE "${rows[0].db}" TO ${username}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${username}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${username}`);
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${username}`,
    );
    await client.query(`REVOKE ALL ON schema_migrations FROM ${username}`);
    await client.query('COMMIT');
    logger.info({ user: username, rdsIam: iam.rowCount === 1 }, 'application database user ready');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function migrate(pool, logger) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        logger.info({ migration: file }, 'migration applied');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}
