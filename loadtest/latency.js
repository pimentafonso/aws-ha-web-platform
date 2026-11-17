// Latency probe for a deployed environment, not a capacity test.
//
// A low, fixed request rate (default 5 requests a second for 2 minutes)
// through CloudFront, so the numbers show what one client sees end to end:
// the internet path to the nearest edge, CloudFront to the ALB, the task, and
// PostgreSQL or Valkey behind it.
//
//   k6 run -e BASE_URL=https://dxxxxxxxx.cloudfront.net loadtest/latency.js
//
// Optional: RATE (requests a second), DURATION (k6 duration, e.g. 2m).
//
// Each request is tagged with a name, so the summary reports p50/p95/p99 per
// route as well as overall. setup() creates the notes that reads use and
// teardown() deletes them, so a run leaves the database as it found it.
import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL;
if (!BASE_URL) throw new Error('set BASE_URL, e.g. -e BASE_URL=https://dxxxxxxxx.cloudfront.net');

const RATE = Number(__ENV.RATE || 5);
const DURATION = __ENV.DURATION || '2m';
const SEED_NOTES = 10;
const JSON_HEADERS = { headers: { 'Content-Type': 'application/json' } };

const ROUTES = ['health', 'ready', 'get_note', 'list_notes', 'create_delete'];

export const options = {
  scenarios: {
    probe: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 10,
      maxVUs: 20,
    },
  },
  summaryTrendStats: ['min', 'med', 'p(95)', 'p(99)', 'max', 'count'],
  // Thresholds only make the per-route numbers show up in the summary; they
  // are loose on purpose and are not a service-level objective.
  thresholds: Object.fromEntries([
    ['http_req_failed', ['rate<0.01']],
    ...ROUTES.map((r) => [`http_req_duration{name:${r}}`, ['p(99)<5000']]),
  ]),
};

export function setup() {
  const ids = [];
  for (let i = 0; i < SEED_NOTES; i++) {
    const res = http.post(
      `${BASE_URL}/api/notes`,
      JSON.stringify({ title: `k6 seed ${i}`, content: 'latency probe' }),
      { ...JSON_HEADERS, tags: { name: 'setup' } },
    );
    if (res.status !== 201) throw new Error(`setup: POST /api/notes returned ${res.status}`);
    ids.push(res.json('id'));
  }
  return { ids };
}

export default function (data) {
  const pick = Math.random();
  if (pick < 0.2) {
    const res = http.get(`${BASE_URL}/health`, { tags: { name: 'health' } });
    check(res, { 'health 200': (r) => r.status === 200 });
  } else if (pick < 0.3) {
    const res = http.get(`${BASE_URL}/ready`, { tags: { name: 'ready' } });
    check(res, { 'ready 200': (r) => r.status === 200 });
  } else if (pick < 0.8) {
    // Seeded notes are read again and again, so after the first read of each
    // one these should be cache hits (X-App-Cache: HIT).
    const id = data.ids[Math.floor(Math.random() * data.ids.length)];
    const res = http.get(`${BASE_URL}/api/notes/${id}`, { tags: { name: 'get_note' } });
    check(res, {
      'get 200': (r) => r.status === 200,
      'cache hit': (r) => r.headers['X-App-Cache'] === 'HIT',
    });
  } else if (pick < 0.9) {
    const res = http.get(`${BASE_URL}/api/notes?limit=20`, { tags: { name: 'list_notes' } });
    check(res, { 'list 200': (r) => r.status === 200 });
  } else {
    const created = http.post(
      `${BASE_URL}/api/notes`,
      JSON.stringify({ title: 'k6 write', content: 'created and deleted' }),
      { ...JSON_HEADERS, tags: { name: 'create_delete' } },
    );
    check(created, { 'create 201': (r) => r.status === 201 });
    if (created.status === 201) {
      const res = http.del(`${BASE_URL}/api/notes/${created.json('id')}`, null, {
        tags: { name: 'create_delete' },
      });
      check(res, { 'delete 204': (r) => r.status === 204 });
    }
  }
}

export function teardown(data) {
  for (const id of data.ids) {
    http.del(`${BASE_URL}/api/notes/${id}`, null, { tags: { name: 'teardown' } });
  }
}
