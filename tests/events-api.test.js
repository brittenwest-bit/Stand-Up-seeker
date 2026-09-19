const test = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/events');

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    json(value) { this.body = value; return this; }
  };
}

async function run(query) {
  const oldUrl = process.env.SUPABASE_URL;
  const oldKey = process.env.SUPABASE_ANON_KEY;
  const oldFetch = global.fetch;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'test-key';
  let requestedUrl = '';
  global.fetch = async url => {
    requestedUrl = String(url);
    return { ok: true, json: async () => [] };
  };
  const res = responseRecorder();
  try { await handler({ query }, res); }
  finally {
    global.fetch = oldFetch;
    if (oldUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = oldUrl;
    if (oldKey === undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY = oldKey;
  }
  return { res, requestedUrl, params: requestedUrl ? new URL(requestedUrl).searchParams : null };
}

test('comedian search ignores city, date, and window criteria', async () => {
  const { res, params } = await run({ comedian: 'Tom Papa', city: 'Boston', date: '1999-01-01', window: 'nonsense' });
  assert.equal(res.statusCode, 200);
  assert.equal(params.get('comedians.name'), 'ilike.Tom Papa');
  assert.equal(params.has('city'), false);
  assert.equal(res.body.meta.date, null);
  assert.equal(res.body.meta.window, null);
});

test('calendar requires a real YYYY-MM month', async () => {
  const { res, requestedUrl } = await run({ view: 'calendar', month: '2026-13' });
  assert.equal(res.statusCode, 400);
  assert.equal(requestedUrl, '');
});

test('calendar queries verified and publishable events only', async () => {
  const { res, params } = await run({ view: 'calendar', month: '2026-10' });
  assert.equal(res.statusCode, 200);
  assert.equal(params.get('publishable'), 'eq.true');
  assert.equal(params.get('verification_status'), 'in.(verified,verified_2_source)');
  assert.equal(params.getAll('local_date')[0], 'gte.2026-10-01');
  assert.equal(params.getAll('local_date')[1], 'lte.2026-10-31');
});

test('map requires verified venue coordinates', async () => {
  const { res, params } = await run({ view: 'map' });
  assert.equal(res.statusCode, 200);
  assert.equal(params.get('publishable'), 'eq.true');
  assert.equal(params.get('venues.latitude'), 'not.is.null');
  assert.equal(params.get('venues.longitude'), 'not.is.null');
  assert.equal(params.get('venues.coordinates_verified_at'), 'not.is.null');
  assert.equal(params.get('venues'), 'not.is.null');
});

test('discover rejects impossible dates before querying Supabase', async () => {
  const { res, requestedUrl } = await run({ city: 'Boston', date: '2026-02-30' });
  assert.equal(res.statusCode, 400);
  assert.equal(requestedUrl, '');
});

test('discover rejects malformed or out-of-range search windows before querying Supabase', async () => {
  for (const window of ['nonsense', '-1', '8', '1.5']) {
    const { res, requestedUrl } = await run({ city: 'Boston', date: '2026-10-01', window });
    assert.equal(res.statusCode, 400, `expected ${window} to be rejected`);
    assert.equal(requestedUrl, '');
  }
});
