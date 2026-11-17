// Integration tests against real Postgres and Redis (docker compose up -d).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createClient } from 'redis';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createCache } from '../src/cache.js';
import { createPool, migrate } from '../src/db.js';
import { createLogger } from '../src/logger.js';

const logger = createLogger('silent');
const dbConfig = {
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 5442),
  database: process.env.DB_NAME ?? 'notes',
  user: process.env.DB_USER ?? 'notes',
  password: process.env.DB_PASSWORD ?? 'notes-local-only',
  sslCaPath: null,
  poolMax: 5,
};
const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6389';

describe('with database and cache', () => {
  let pool;
  let cache;
  let app;

  before(async () => {
    pool = await createPool(dbConfig);
    await migrate(pool, logger);
    await pool.query('TRUNCATE notes');
    cache = createCache(redisUrl, 60, logger);
    // The cache connects in the background; wait for it so HIT/MISS is deterministic.
    for (let i = 0; i < 50 && !(await cache.ping()); i++) await sleep(100);
    app = createApp({ pool, cache, logger });
  });

  after(async () => {
    await cache.close();
    await pool.end();
  });

  test('GET /health returns ok without touching dependencies', async () => {
    const res = await request(app).get('/health').expect(200);
    assert.deepEqual(res.body, { status: 'ok' });
  });

  test('GET /ready reports both dependencies', async () => {
    const res = await request(app).get('/ready').expect(200);
    assert.deepEqual(res.body.checks, { database: true, cache: true });
  });

  test('migrations are idempotent', async () => {
    await migrate(pool, logger);
  });

  test('create, read through the cache, list and delete a note', async () => {
    const created = await request(app)
      .post('/api/notes')
      .send({ title: '  First note ', content: 'hello' })
      .expect(201);
    assert.equal(created.body.title, 'First note');
    assert.equal(created.headers.location, `/api/notes/${created.body.id}`);

    const first = await request(app).get(`/api/notes/${created.body.id}`).expect(200);
    assert.equal(first.headers['x-app-cache'], 'MISS');
    const second = await request(app).get(`/api/notes/${created.body.id}`).expect(200);
    assert.equal(second.headers['x-app-cache'], 'HIT');
    assert.deepEqual(second.body, first.body);

    const list = await request(app).get('/api/notes').expect(200);
    assert.ok(list.body.items.some((n) => n.id === created.body.id));

    await request(app).delete(`/api/notes/${created.body.id}`).expect(204);
    await request(app).get(`/api/notes/${created.body.id}`).expect(404);
  });

  test('rejects invalid input', async () => {
    await request(app).post('/api/notes').send({ title: '' }).expect(400);
    await request(app).post('/api/notes').send({ title: 'x'.repeat(201) }).expect(400);
    await request(app)
      .post('/api/notes')
      .set('Content-Type', 'application/json')
      .send('{not json')
      .expect(400);
    await request(app).get('/api/notes/not-a-uuid').expect(400);
  });

  test('unknown routes return JSON 404', async () => {
    const res = await request(app).get('/nope').expect(404);
    assert.deepEqual(res.body, { error: 'not found' });
  });
});

describe('when the cache is unavailable', () => {
  let pool;
  let cache;
  let app;

  before(async () => {
    pool = await createPool(dbConfig);
    // Nothing listens on port 1, so Redis never connects.
    cache = createCache('redis://127.0.0.1:1', 60, logger);
    app = createApp({ pool, cache, logger });
  });

  after(async () => {
    await cache.close();
    await pool.end();
  });

  test('reads and writes still succeed from the database', async () => {
    const created = await request(app).post('/api/notes').send({ title: 'No cache' }).expect(201);
    const res = await request(app).get(`/api/notes/${created.body.id}`).expect(200);
    assert.equal(res.headers['x-app-cache'], 'MISS');
  });

  test('/ready stays 200 and reports the cache as down', async () => {
    const res = await request(app).get('/ready').expect(200);
    assert.deepEqual(res.body.checks, { database: true, cache: false });
  });
});

describe('when the cache requires an AUTH token', () => {
  const token = 'local-test-token';
  let admin;

  before(async () => {
    admin = await createClient({ url: redisUrl }).connect();
    await admin.configSet('requirepass', token);
  });

  after(async () => {
    // The admin connection stays authenticated, so it can turn AUTH off again.
    await admin.configSet('requirepass', '');
    await admin.close();
  });

  async function readyWithin(cache, ms) {
    for (let waited = 0; waited < ms; waited += 100) {
      if (await cache.ping()) return true;
      await sleep(100);
    }
    return false;
  }

  test('connects when given the token', async () => {
    const cache = createCache(redisUrl, 60, logger, { password: token });
    try {
      assert.equal(await readyWithin(cache, 5000), true);
    } finally {
      await cache.close();
    }
  });

  test('stays unavailable without the token', async () => {
    const cache = createCache(redisUrl, 60, logger);
    try {
      assert.equal(await readyWithin(cache, 1000), false);
    } finally {
      await cache.close();
    }
  });
});
