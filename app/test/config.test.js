import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { loadDbConfig } from '../src/config.js';

const KEYS = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_AUTH', 'AWS_REGION', 'DB_SSL_CA_PATH'];
let saved;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, { DB_HOST: 'db', DB_NAME: 'notes', DB_USER: 'notes_app' });
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test('password mode needs DB_PASSWORD', () => {
  assert.throws(() => loadDbConfig(), /DB_PASSWORD/);
  process.env.DB_PASSWORD = 'pw';
  assert.equal(loadDbConfig().authMode, 'password');
});

test('IAM mode needs a region and TLS, and no password', () => {
  process.env.DB_AUTH = 'iam';
  assert.throws(() => loadDbConfig(), /AWS_REGION/);
  process.env.AWS_REGION = 'eu-west-1';
  assert.throws(() => loadDbConfig(), /DB_SSL_CA_PATH/);
  process.env.DB_SSL_CA_PATH = '/etc/ssl/rds/eu-west-1-bundle.pem';
  const db = loadDbConfig();
  assert.equal(db.password, undefined);
  assert.equal(db.region, 'eu-west-1');
});

test('rejects an unknown DB_AUTH', () => {
  process.env.DB_AUTH = 'kerberos';
  assert.throws(() => loadDbConfig(), /DB_AUTH must be/);
});
