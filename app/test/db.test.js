// Database user and authentication tests (docker compose up -d).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createPool, ensureAppUser, migrate } from '../src/db.js';
import { createLogger } from '../src/logger.js';

const logger = createLogger('silent');
const ownerConfig = {
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 5442),
  database: process.env.DB_NAME ?? 'notes',
  user: process.env.DB_USER ?? 'notes',
  password: process.env.DB_PASSWORD ?? 'notes-local-only',
  sslCaPath: null,
  poolMax: 2,
};

describe('application database user', () => {
  const appUser = 'notes_app_test';
  let pool;

  before(async () => {
    pool = await createPool(ownerConfig);
    await migrate(pool, logger);
  });

  after(async () => {
    await pool.query(`DROP OWNED BY ${appUser}`);
    await pool.query(`DROP ROLE IF EXISTS ${appUser}`);
    await pool.end();
  });

  const privilege = async (sql, ...params) => (await pool.query(sql, params)).rows[0].ok;

  test('can read and write notes but not change the schema or read migrations', async () => {
    await ensureAppUser(pool, appUser, logger);
    await ensureAppUser(pool, appUser, logger); // idempotent

    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      assert.equal(await privilege('SELECT has_table_privilege($1, $2, $3) AS ok', appUser, 'notes', p), true, p);
    }
    assert.equal(await privilege('SELECT has_table_privilege($1, $2, $3) AS ok', appUser, 'notes', 'TRUNCATE'), false);
    assert.equal(
      await privilege('SELECT has_table_privilege($1, $2, $3) AS ok', appUser, 'schema_migrations', 'SELECT'),
      false,
    );
    assert.equal(await privilege('SELECT has_schema_privilege($1, $2, $3) AS ok', appUser, 'public', 'CREATE'), false);
  });

  test('rejects names that are not plain identifiers', async () => {
    await assert.rejects(ensureAppUser(pool, 'x; DROP TABLE notes', logger), /invalid database user name/);
  });
});

describe('IAM authentication', () => {
  test('signs a fresh RDS auth token for each connection', async () => {
    // Example credentials from the AWS documentation: signing is local, so no
    // request is made and nothing real is needed.
    process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
    const pool = await createPool({
      ...ownerConfig,
      host: 'db.example.internal',
      port: 5432,
      user: 'notes_app',
      authMode: 'iam',
      region: 'eu-west-1',
    });
    try {
      assert.equal(typeof pool.options.password, 'function');
      const token = await pool.options.password();
      assert.match(token, /^db\.example\.internal:5432\/\?/);
      assert.match(token, /Action=connect/);
      assert.match(token, /DBUser=notes_app/);
      assert.match(token, /X-Amz-Signature=/);
    } finally {
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;
      await pool.end();
    }
  });
});
